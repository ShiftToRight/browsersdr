import { makeHannWindow } from "./spectrumMath";

export function gpuFftSize(search = location.search): 4096 | 16384 | undefined {
  const query = new URLSearchParams(search);
  if (query.get("analysis") !== "gpu") return undefined;
  return query.get("fft") === "16384" ? 16384 : 4096;
}

export function checkGpuFftLimits(device: Pick<GPUDevice, "limits">, size: number): void {
  if (size !== 4096 && size !== 16384) throw new RangeError("GPU FFT supports only 4096 and 16384 bins");
  const limits = device.limits;
  if (limits.maxStorageBufferBindingSize < size * 4 * 8 || limits.maxBufferSize < size * 4 * 8
    || limits.maxComputeWorkgroupSizeX < 64 || limits.maxComputeInvocationsPerWorkgroup < 64
    || limits.maxComputeWorkgroupsPerDimension < size * 4 / 64 || limits.maxStorageBuffersPerShaderStage < 3) {
    throw new Error("Device limits cannot support the experimental FFT");
  }
}

/** Four independent windows per batch. Each radix-2 stage is a separate dispatch.
 * Input is owned interleaved Float32 I,Q, output is shifted coherent-gain-normalized dB.
 * No workgroup barriers, optional features, mapping, or result readback in production.
 */
export class GpuSpectrum {
  private readonly buffers: GPUBuffer[] = [];
  private readonly passes: { pipeline: GPUComputePipeline; group: GPUBindGroup; count: number }[] = [];
  readonly output: GPUBuffer;
  private readonly input: GPUBuffer;
  private disposed = false;

  private constructor(private readonly device: GPUDevice, readonly size: number) {
    checkGpuFftLimits(device, size);
    try {
      const buffer = (label: string, bytes: number, usage = 0x80 | 0x8) => {
        const result = device.createBuffer({ label, size: bytes, usage });
        this.buffers.push(result);
        return result;
      };
      this.input = buffer("FFT four-window I/Q upload", size * 4 * 8);
      const ping = buffer("FFT ping", size * 4 * 8);
      const pong = buffer("FFT pong", size * 4 * 8);
      const coefficients = buffer("FFT Hann", size * 4);
      const twiddles = buffer("FFT twiddles", size * 4);
      this.output = buffer("FFT shifted relative dB", size * 4, 0x80 | 0x4);
      const window = makeHannWindow(size);
      const gain = window.reduce((sum, value) => sum + value, 0);
      device.queue.writeBuffer(coefficients, 0, window);
      const table = new Float32Array(size);
      for (let k = 0; k < size / 2; k++) {
        table[2 * k] = Math.cos(-2 * Math.PI * k / size);
        table[2 * k + 1] = Math.sin(-2 * Math.PI * k / size);
      }
      device.queue.writeBuffer(twiddles, 0, table);
      const add = (code: string, resources: GPUBuffer[], count: number) => {
        const module = device.createShaderModule({ code, label: "experimental FFT" });
        const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource: { buffer: resource } })) });
        this.passes.push({ pipeline, group, count });
      };
      add(`
        @group(0) @binding(0) var<storage, read> input: array<vec2f>;
        @group(0) @binding(1) var<storage, read> window: array<f32>;
        @group(0) @binding(2) var<storage, read_write> output: array<vec2f>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
          let k = id.x % ${size}u;
          let base = id.x - k;
          output[base + (reverseBits(k) >> ${32 - Math.log2(size)}u)] = input[id.x] * window[k];
        }`, [this.input, coefficients, ping], size * 4 / 64);
      let source = ping;
      let target = pong;
      for (let span = 2; span <= size; span *= 2) {
        add(`
          @group(0) @binding(0) var<storage, read> input: array<vec2f>;
          @group(0) @binding(1) var<storage, read> twiddle: array<vec2f>;
          @group(0) @binding(2) var<storage, read_write> output: array<vec2f>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
            let j = id.x % ${span / 2}u;
            let even = (id.x / ${span / 2}u) * ${span}u + j;
            let a = input[even]; let b = input[even + ${span / 2}u];
            let w = twiddle[j * ${size / span}u];
            let product = vec2f(b.x * w.x - b.y * w.y, b.x * w.y + b.y * w.x);
            output[even] = a + product;
            output[even + ${span / 2}u] = a - product;
          }`, [source, twiddles, target], size * 2 / 64);
        [source, target] = [target, source];
      }
      add(`
        @group(0) @binding(0) var<storage, read> input: array<vec2f>;
        @group(0) @binding(1) var<storage, read_write> output: array<f32>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
          let k = (id.x + ${size / 2}u) % ${size}u;
          var power = 0.0;
          for (var batch = 0u; batch < 4u; batch++) {
            let z = input[batch * ${size}u + k]; power += dot(z, z);
          }
          output[id.x] = max(-120.0, 10.0 * log2(max(power / ${4 * gain * gain}, 1e-12)) / log2(10.0));
        }`, [source, this.output], size / 64);
    } catch (error) { this.dispose(); throw error; }
  }

  static async create(device: GPUDevice, size: number): Promise<GpuSpectrum> {
    device.pushErrorScope("validation");
    let fft: GpuSpectrum | undefined;
    try {
      fft = new GpuSpectrum(device, size);
    } catch (error) {
      await device.popErrorScope();
      throw error;
    }
    const error = await device.popErrorScope();
    if (error) { fft.dispose(); throw new Error(error.message); }
    return fft;
  }

  encode(input: Float32Array, encoder: GPUCommandEncoder): void {
    if (this.disposed) throw new Error("GPU FFT disposed");
    if (input.length !== this.size * 8) throw new RangeError("Expected four complete complex windows");
    this.device.queue.writeBuffer(this.input, 0, input as Float32Array<ArrayBuffer>);
    for (const { pipeline, group, count } of this.passes) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count); pass.end();
    }
  }

  dispose(): void { this.disposed = true; for (const buffer of this.buffers) buffer.destroy(); }
}
