import { GpuSpectrum } from "../dsp/gpuSpectrum";
import { SpectrumAccumulator } from "../dsp/spectrumMath";
import { createAnalysisBackend } from "../dsp/spectrumBackend";

/** Explicit browser-only validation. Readback is confined to this module, never the live path.
 * Run through Vite: await (await import('/src/testing/gpuFftValidation.ts')).validateGpuFft()
 */
export async function validateGpuFft() {
  const started = performance.now();
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { unavailable: "No WebGPU adapter" };
  const device = await adapter.requestDevice();
  const deviceStartupMs = performance.now() - started;
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const results = [];
  try {
    for (const size of [4096, 16384]) {
      const startup = performance.now();
      const fft = await GpuSpectrum.create(device, size);
      const startupMs = performance.now() - startup;
      const readback = device.createBuffer({ size: size * 4, usage: 1 | 8 });
      const levels = device.createBuffer({ size: size * 4, usage: 128 | 8 });
      const history = device.createBuffer({ size: size * 4 * 240, usage: 128 | 8 });
      const controls = device.createBuffer({ size: 32, usage: 64 | 8 });
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 560;
      const context = canvas.getContext("webgpu") as GPUCanvasContext;
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, usage: 16 | 1 });
      const { spectrumShader } = await import("../graphics/spectrumShader");
      const module = device.createShaderModule({ code: spectrumShader(size) });
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: 1, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: 2, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: 3, buffer: { type: "uniform" } },
      ] });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const spectrum = device.createRenderPipeline({ layout: pipelineLayout, vertex: { module, entryPoint: "spectrumVertex" }, fragment: { module, entryPoint: "spectrumFragment", targets: [{ format }] }, primitive: { topology: "line-strip" } });
      const waterfall = device.createRenderPipeline({ layout: pipelineLayout, vertex: { module, entryPoint: "fullscreenVertex" }, fragment: { module, entryPoint: "waterfallFragment", targets: [{ format }] } });
      const group = device.createBindGroup({ layout, entries: [levels, history, controls].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const controlData = new ArrayBuffer(32); const view = new DataView(controlData);
      view.setFloat32(4, -105, true); view.setFloat32(8, 90, true); view.setUint32(16, 1, true); view.setUint32(20, 240, true);
      device.queue.writeBuffer(controls, 0, controlData);
      const render = (encoder: GPUCommandEncoder) => {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
        pass.setBindGroup(0, group); pass.setPipeline(waterfall); pass.draw(3); pass.setPipeline(spectrum); pass.draw(size); pass.end();
      };
      const fixtures = [];
      const input = new Float32Array(size * 8);
      const I = new Float32Array(size); const Q = new Float32Array(size);
      let seed = 123;
      for (const kind of ["silence", "positive", "negative", "off-bin", "noise"]) {
        const reference = new SpectrumAccumulator(size);
        let expected: Float32Array | undefined;
        for (let batch = 0; batch < 4; batch++) {
          for (let k = 0; k < size; k++) {
            const frequency = kind === "negative" ? -317 : kind === "off-bin" ? 123.37 : 123;
            const phase = 2 * Math.PI * frequency * (batch * size + k) / size;
            const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
            I[k] = kind === "silence" ? 0 : kind === "noise" ? random() : 0.5 * Math.cos(phase);
            Q[k] = kind === "silence" ? 0 : kind === "noise" ? random() : 0.5 * Math.sin(phase);
            input[(batch * size + k) * 2] = I[k]!; input[(batch * size + k) * 2 + 1] = Q[k]!;
          }
          expected = reference.addWindow(I, Q);
        }
        const encoder = device.createCommandEncoder(); fft.encode(input, encoder);
        encoder.copyBufferToBuffer(fft.output, 0, readback, 0, size * 4);
        device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
        const actual = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
        let maxDbError = 0; let maxPowerError = 0; let peak = 0; let referencePeak = 0;
        for (let k = 0; k < size; k++) {
          maxDbError = Math.max(maxDbError, Math.abs(actual[k]! - expected![k]!));
          maxPowerError = Math.max(maxPowerError, Math.abs(10 ** (actual[k]! / 10) - 10 ** (expected![k]! / 10)));
          if (actual[k]! > actual[peak]!) peak = k;
          if (expected![k]! > expected![referencePeak]!) referencePeak = k;
        }
        if ((kind === "silence" && maxDbError !== 0) || maxDbError > 0.1 || maxPowerError > 1e-5 || peak !== referencePeak || !actual.every(Number.isFinite)) {
          throw new Error(JSON.stringify({ size, kind, maxDbError, maxPowerError, peak, referencePeak }));
        }
        fixtures.push({ kind, maxDbError, maxPowerError, peak });
      }
      const timings = [];
      for (const preference of ["gpu", "javascript", "wasm"] as const) {
        const cpu = preference === "gpu" ? undefined : await createAnalysisBackend(preference, size);
        const samples: number[] = [];
        for (let iteration = 0; iteration < 25; iteration++) {
          const before = performance.now();
          const encoder = device.createCommandEncoder();
          if (!cpu) {
            fft.encode(input, encoder);
            encoder.copyBufferToBuffer(fft.output, 0, levels, 0, size * 4);
            encoder.copyBufferToBuffer(fft.output, 0, history, (iteration % 240) * size * 4, size * 4);
          } else {
            let bins: Float32Array | undefined;
            for (let batch = 0; batch < 4; batch++) {
              for (let k = 0; k < size; k++) { I[k] = input[(batch * size + k) * 2]!; Q[k] = input[(batch * size + k) * 2 + 1]!; }
              bins = cpu.kernel.addWindow(I, Q);
            }
            device.queue.writeBuffer(levels, 0, bins! as Float32Array<ArrayBuffer>);
            device.queue.writeBuffer(history, (iteration % 240) * size * 4, bins! as Float32Array<ArrayBuffer>);
          }
          render(encoder); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
          if (iteration >= 5) samples.push(performance.now() - before);
        }
        timings.push({ backend: cpu?.name ?? "GPU", startupMs: cpu?.startupMs ?? startupMs,
          meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, maxMs: Math.max(...samples) });
        cpu?.kernel.dispose?.();
      }
      // A separate bounded render readback verifies pixels; excluded from all timings.
      const pixels = device.createBuffer({ size: 960 * 560 * 4, usage: 1 | 8 });
      const pixelEncoder = device.createCommandEncoder();
      pixelEncoder.copyBufferToBuffer(fft.output, 0, levels, 0, size * 4);
      pixelEncoder.copyBufferToBuffer(fft.output, 0, history, 0, size * 4);
      render(pixelEncoder);
      pixelEncoder.copyTextureToBuffer({ texture: context.getCurrentTexture() }, { buffer: pixels, bytesPerRow: 960 * 4 }, { width: 960, height: 560 });
      device.queue.submit([pixelEncoder.finish()]);
      await pixels.mapAsync(1);
      const rgba = new Uint8Array(pixels.getMappedRange());
      let coloredPixels = 0;
      for (let k = 0; k < rgba.length; k += 4) if (rgba[k] !== rgba[k + 1] || rgba[k + 1] !== rgba[k + 2]) coloredPixels++;
      pixels.unmap(); pixels.destroy();
      if (coloredPixels < 1000) throw new Error("Spectrum/waterfall produced no colored pixels");
      results.push({ size, fixtures, timings, coloredPixels });
      fft.dispose(); readback.destroy(); levels.destroy(); history.destroy(); controls.destroy(); context.unconfigure();
    }
    if (errors.length) throw new Error(errors.join("; "));
    return { userAgent: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, deviceStartupMs,
      timing: "Wall-clock kernel/upload + compute + spectrum/waterfall render + queue completion; 5 warmups, 20 samples; no readback or GPU timestamps in timings. CPU measured locally without worker transport; no presentation/vsync latency.", results };
  } finally { device.destroy(); }
}
