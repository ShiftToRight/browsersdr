import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SpectrumProcessor } from "./spectrumProcessor";
import { SpectrumAccumulator } from "./spectrumMath";
import { createAnalysisBackend, instantiateWasmSpectrum, WasmSpectrumAccumulator, type SpectrumKernel } from "./spectrumBackend";

const WASM_PATH = new URL("../wasm/pkg/spectrum_analysis.wasm", import.meta.url);
let wasmBytes: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  const file = await readFile(WASM_PATH);
  wasmBytes = new Uint8Array(file.byteLength);
  wasmBytes.set(file);
});
afterEach(() => vi.unstubAllGlobals());

async function kernels(size: number): Promise<[SpectrumKernel, SpectrumKernel]> {
  const exports = await instantiateWasmSpectrum(wasmBytes);
  return [new SpectrumAccumulator(size), new WasmSpectrumAccumulator(exports, size)];
}

function averaged(kernel: SpectrumKernel, I: Float32Array, Q: Float32Array): Float32Array {
  let bins: Float32Array | undefined;
  for (let index = 0; index < 4; index += 1) bins = kernel.addWindow(I, Q);
  if (!bins) throw new Error("Expected an averaged spectrum");
  return bins;
}

function tone(size: number, bin: number, amplitude = 0.6): [Float32Array, Float32Array] {
  const I = new Float32Array(size);
  const Q = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const phase = 2 * Math.PI * bin * index / size;
    I[index] = Math.cos(phase) * amplitude;
    Q[index] = Math.sin(phase) * amplitude;
  }
  return [I, Q];
}

function seededNoise(size: number): [Float32Array, Float32Array] {
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000 * 2 - 1;
  };
  const I = new Float32Array(size);
  const Q = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    I[index] = next() * 0.2;
    Q[index] = next() * 0.2;
  }
  return [I, Q];
}

function expectSpectraClose(reference: Float32Array, wasm: Float32Array, toleranceDb: number): void {
  expect(wasm).toHaveLength(reference.length);
  let maximumDifference = 0;
  for (let index = 0; index < reference.length; index += 1) {
    maximumDifference = Math.max(maximumDifference, Math.abs((reference[index] ?? 0) - (wasm[index] ?? 0)));
  }
  expect(maximumDifference).toBeLessThanOrEqual(toleranceDb);
}

describe("RustFFT WebAssembly spectrum backend", () => {
  it.each([4096, 16384])("matches silence at %d bins", async (size) => {
    const [reference, wasm] = await kernels(size);
    expectSpectraClose(
      averaged(reference, new Float32Array(size), new Float32Array(size)),
      averaged(wasm, new Float32Array(size), new Float32Array(size)),
      0,
    );
    wasm.dispose?.();
  });

  it.each([4096, 16384])("matches bin-centered and off-bin tones at %d bins", async (size) => {
    for (const bin of [37, -81.375]) {
      const [I, Q] = tone(size, bin);
      const [reference, wasm] = await kernels(size);
      expectSpectraClose(averaged(reference, I, Q), averaged(wasm, I, Q), 0.05);
      wasm.dispose?.();
    }
  });

  it.each([4096, 16384])("matches deterministic seeded noise at %d bins", async (size) => {
    const [I, Q] = seededNoise(size);
    const [reference, wasm] = await kernels(size);
    expectSpectraClose(averaged(reference, I, Q), averaged(wasm, I, Q), 0.025);
    wasm.dispose?.();
  });

  it("preserves block assembly and reset semantics", async () => {
    const [I, Q] = tone(4096 * 4, 128);
    const exports = await instantiateWasmSpectrum(wasmBytes);
    const reference = new SpectrumProcessor(new SpectrumAccumulator());
    const wasm = new SpectrumProcessor(new WasmSpectrumAccumulator(exports, 4096));
    for (const processor of [reference, wasm]) {
      expect(processor.accept(I.subarray(0, 5000), Q.subarray(0, 5000), 0)).toHaveLength(0);
      expect(processor.accept(I.subarray(5000), Q.subarray(5000), 0)).toHaveLength(1);
      processor.reset();
      processor.accept(I.subarray(0, 4096 * 3), Q.subarray(0, 4096 * 3), 100);
      expect(processor.accept(I.subarray(0, 4096), Q.subarray(0, 4096), 100, true, 1)).toHaveLength(0);
      processor.dispose();
    }
  });

  it("retains the JavaScript backend when the WASM asset cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fixture load failure")));
    const selection = await createAnalysisBackend("auto", 4096);
    expect(selection.name).toBe("JavaScript fallback");
    expect(selection.fallbackReason).toBe("fixture load failure");
    expect(averaged(selection.kernel, ...tone(4096, 9))).toHaveLength(4096);
  });
});

describe("spectrum backend benchmark", () => {
  it("reports startup, warm analysis, averaged-frame latency and allocations", async () => {
    const results: Record<string, string | number>[] = [];
    for (const size of [4096, 16384]) {
      const [I, Q] = tone(size, 17.25);
      const javascriptStarted = performance.now();
      const javascript = new SpectrumAccumulator(size);
      const javascriptStartupMs = performance.now() - javascriptStarted;

      const wasmStarted = performance.now();
      const module = await WebAssembly.compile(wasmBytes);
      const exports = await instantiateWasmSpectrum(module);
      const wasm = new WasmSpectrumAccumulator(exports, size);
      const wasmStartupMs = performance.now() - wasmStarted;

      for (let index = 0; index < 12; index += 1) {
        javascript.addWindow(I, Q);
        wasm.addWindow(I, Q);
      }
      const iterations = size === 4096 ? 160 : 60;
      for (const [name, kernel, startupMs, allocations] of [
        ["javascript", javascript, javascriptStartupMs, 13],
        ["wasm", wasm, wasmStartupMs, 1],
      ] as const) {
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) kernel.addWindow(I, Q);
        const elapsed = performance.now() - started;
        results.push({ backend: name, bins: size, startupMs: startupMs.toFixed(3), warmWindowMs: (elapsed / iterations).toFixed(3), averagedFrameLatencyMs: (elapsed / iterations * 4).toFixed(3), typedArrayAllocationsPerFrame: allocations });
      }
      wasm.dispose();
    }
    console.table(results);
  });
});

it("batched FFT preserves frame boundaries, credits, partial windows and gaps", async () => {
  const e = await instantiateWasmSpectrum(wasmBytes);
  const batched = new SpectrumProcessor(new WasmSpectrumAccumulator(e, 4096, 3), true);
  const scalarKernel = new WasmSpectrumAccumulator(e, 4096, 3);
  const scalar = new SpectrumProcessor({ size: 4096, reset: () => scalarKernel.reset(), addWindow: (i, q) => scalarKernel.addWindow(i, q) }, true);
  let start = 0;
  for (const [index, length] of [32768, 1, 123, 65536, 4095, 32768, 8192].entries()) {
    const [I, Q] = seededNoise(length); const gap = index === 4;
    if (index % 2 === 0) { batched.grantPublicationCredit(); scalar.grantPublicationCredit(); }
    const actual = batched.accept(I, Q, start, gap, gap ? 2 : 0, gap ? 77 : 0);
    const expected = scalar.accept(I, Q, start, gap, gap ? 2 : 0, gap ? 77 : 0);
    expect(actual).toEqual(expected); start += 10;
  }
  batched.dispose(); scalarKernel.dispose();
});
