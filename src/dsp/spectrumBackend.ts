import wasmUrl from "../wasm/pkg/spectrum_analysis.wasm?url";
import { SpectrumAccumulator } from "./spectrumMath";

export type AnalysisBackendPreference = "auto" | "wasm" | "javascript";
export type AnalysisBackendName = "WebAssembly · RustFFT" | "JavaScript reference" | "JavaScript fallback";

export interface SpectrumKernel {
  readonly size: number;
  reset(): void;
  addWindow(I: Float32Array, Q: Float32Array): Float32Array | undefined;
  dispose?(): void;
}

interface WasmSpectrumExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly spectrum_create: (size: number, windowsPerAverage: number) => number;
  readonly spectrum_destroy: (handle: number) => void;
  readonly spectrum_reset: (handle: number) => void;
  readonly spectrum_input_i: (handle: number) => number;
  readonly spectrum_input_q: (handle: number) => number;
  readonly spectrum_output: (handle: number) => number;
  readonly spectrum_process: (handle: number) => number;
}

export interface AnalysisBackendSelection {
  kernel: SpectrumKernel;
  name: AnalysisBackendName;
  startupMs: number;
  fallbackReason?: string;
}

function wasmExports(instance: WebAssembly.Instance): WasmSpectrumExports {
  const exports = instance.exports as unknown as Partial<WasmSpectrumExports>;
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.spectrum_create !== "function"
    || typeof exports.spectrum_destroy !== "function"
    || typeof exports.spectrum_reset !== "function"
    || typeof exports.spectrum_input_i !== "function"
    || typeof exports.spectrum_input_q !== "function"
    || typeof exports.spectrum_output !== "function"
    || typeof exports.spectrum_process !== "function") {
    throw new Error("The spectrum WebAssembly module has an incompatible export table.");
  }
  return exports as WasmSpectrumExports;
}

/** Preallocates RustFFT state. Views are recreated on every call after any possible memory growth. */
export class WasmSpectrumAccumulator implements SpectrumKernel {
  readonly size: number;
  private handle: number;

  constructor(private readonly exports: WasmSpectrumExports, size: number, windowsPerAverage = 4) {
    this.size = size;
    this.handle = exports.spectrum_create(size, windowsPerAverage);
    if (this.handle === 0) throw new RangeError("WASM spectrum size must be a power of two and averaging must be positive");
  }

  reset(): void {
    this.assertAlive();
    this.exports.spectrum_reset(this.handle);
  }

  addWindow(I: Float32Array, Q: Float32Array): Float32Array | undefined {
    this.assertAlive();
    if (I.length !== this.size || Q.length !== this.size) throw new RangeError(`Expected ${this.size} complex samples`);
    const memory = this.exports.memory.buffer;
    new Float32Array(memory, this.exports.spectrum_input_i(this.handle), this.size).set(I);
    new Float32Array(memory, this.exports.spectrum_input_q(this.handle), this.size).set(Q);
    if (this.exports.spectrum_process(this.handle) === 0) return undefined;
    // The worker transfers this independent one-allocation result; WASM memory is never detached.
    return new Float32Array(new Float32Array(
      this.exports.memory.buffer,
      this.exports.spectrum_output(this.handle),
      this.size,
    ));
  }

  dispose(): void {
    if (this.handle !== 0) this.exports.spectrum_destroy(this.handle);
    this.handle = 0;
  }

  private assertAlive(): void {
    if (this.handle === 0) throw new Error("WASM spectrum accumulator has been disposed");
  }
}

export async function instantiateWasmSpectrum(source: BufferSource | WebAssembly.Module): Promise<WasmSpectrumExports> {
  if (source instanceof WebAssembly.Module) return wasmExports(await WebAssembly.instantiate(source, {}));
  return wasmExports((await WebAssembly.instantiate(source, {})).instance);
}

async function loadWasmSpectrum(): Promise<WasmSpectrumExports> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`WASM asset request failed with HTTP ${response.status}`);
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      const result = await WebAssembly.instantiateStreaming(response.clone(), {});
      return wasmExports(result.instance);
    } catch {
      // Static hosts sometimes omit application/wasm; buffered instantiation remains portable.
    }
  }
  return instantiateWasmSpectrum(await response.arrayBuffer());
}

export async function createAnalysisBackend(
  preference: AnalysisBackendPreference,
  size: number,
  windowsPerAverage = 4,
): Promise<AnalysisBackendSelection> {
  const started = performance.now();
  if (preference === "javascript") {
    return { kernel: new SpectrumAccumulator(size, windowsPerAverage), name: "JavaScript reference", startupMs: performance.now() - started };
  }
  try {
    const exports = await loadWasmSpectrum();
    return { kernel: new WasmSpectrumAccumulator(exports, size, windowsPerAverage), name: "WebAssembly · RustFFT", startupMs: performance.now() - started };
  } catch (error) {
    return {
      kernel: new SpectrumAccumulator(size, windowsPerAverage),
      name: "JavaScript fallback",
      startupMs: performance.now() - started,
      fallbackReason: error instanceof Error ? error.message : "WebAssembly initialization failed",
    };
  }
}

export function analysisBackendPreference(search = typeof location === "undefined" ? "" : location.search): AnalysisBackendPreference {
  const requested = new URLSearchParams(search).get("analysis");
  return requested === "js" || requested === "javascript" ? "javascript" : requested === "wasm" ? "wasm" : "auto";
}
