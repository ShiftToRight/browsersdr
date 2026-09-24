import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { WasmChannelFilter, type ChannelExports } from "./wasmChannel";
import { WidebandChannelFilter } from "./widebandChannel";
let exports: ChannelExports;
beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/pkg/spectrum_analysis.wasm", import.meta.url)), {});
  exports = instance.exports as ChannelExports;
});
describe("optimized 9.6 MS/s cascade", () => {
  it.each([-3_500_000, 0, 3_500_000])("matches the reference across odd blocks and resets at offset %i", offset => {
    const wasm = new WasmChannelFilter(exports), reference = new WidebandChannelFilter(offset, 9_600_000);
    wasm.reset(offset);
    let index = 0;
    for (const size of [1, 137, 32768, 8191, 32768]) {
      const I = Float32Array.from({ length: size }, (_, n) => Math.cos((index + n) * .321) * .7);
      const Q = Float32Array.from({ length: size }, (_, n) => Math.sin((index + n) * .731) * .7);
      index += size;
      const i = I.slice(), q = Q.slice(); const count = wasm.process(I, Q);
      expect(count).toBe(reference.process(i, q));
      for (let n = 0; n < count; n++) { expect(I[n]).toBeCloseTo(i[n]!, 6); expect(Q[n]).toBeCloseTo(q[n]!, 6); }
    }
    wasm.reset(0); const I = new Float32Array(1024), Q = I.slice(); wasm.process(I, Q);
    expect(I.every(v => v === 0) && Q.every(v => v === 0)).toBe(true);
    expect(() => wasm.reset(Infinity)).toThrow();
    expect(() => wasm.process(new Float32Array(32769), new Float32Array(32769))).toThrow();
    wasm.dispose(); wasm.dispose(); expect(() => wasm.process(I, Q)).toThrow();
  });
});
