import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { WasmChannelFilter, warmChannelFilter, type ChannelExports } from "./wasmChannel";
import { WidebandChannelFilter } from "./widebandChannel";
let exports: ChannelExports;
beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/pkg/spectrum_analysis.wasm", import.meta.url)), {});
  exports = instance.exports as ChannelExports;
});
describe.each([4_800_000, 9_600_000, 19_200_000])("optimized %i MS/s cascade", rate => {
  it.each([-rate / 2 + 1_200_000, 0, rate / 2 - 1_200_000])("matches the reference across odd blocks at offset %i", offset => {
    const wasm = new WasmChannelFilter(exports, rate), reference = new WidebandChannelFilter(offset, rate);
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

it.each([4_800_000, 9_600_000, 19_200_000])("keeps compiled block history equivalent across repeated full-scale noise and tiny/empty chunks at %i", rate => {
  const wasm = new WasmChannelFilter(exports, rate);
  const reference = new WidebandChannelFilter(0, rate);
  let seed = 1234567, maximumError = 0;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  for (const offset of [0, rate / 2 - 1_200_000, -rate / 2 + 1_200_000]) {
    wasm.reset(offset); reference.reset(offset);
    for (let block = 0; block < 24; block++) {
      const size = [32768, 1, 0, 3, 137, 8191][block % 6]!;
      const I = Float32Array.from({ length: size }, next), Q = Float32Array.from({ length: size }, next);
      const i = I.slice(), q = Q.slice(), count = wasm.process(I, Q);
      expect(count).toBe(reference.process(i, q));
      for (let n = 0; n < count; n++) maximumError = Math.max(maximumError, Math.abs(I[n]! - i[n]!), Math.abs(Q[n]! - q[n]!));
    }
  }
  expect(maximumError).toBeLessThan(1e-6);
  wasm.dispose();
});

it.each([4_800_000, 9_600_000, 19_200_000])("normalizes offset CI8 directly into WASM with small outputs at %i", rate => {
  const native = new WasmChannelFilter(exports, rate), planar = new WasmChannelFilter(exports, rate);
  for (const offset of [-rate / 2 + 1_200_000, 0, rate / 2 - 1_200_000]) {
    native.reset(offset); planar.reset(offset);
    for (const size of [1, 3, 32768, 8191, 32768]) {
      const backing = new Uint8Array(size * 2 + 13);
      const bytes = backing.subarray(7, 7 + size * 2);
      for (let n = 0; n < bytes.length; n++) bytes[n] = n * 37;
      const I = Float32Array.from({ length: size }, (_, n) => (bytes[n * 2]! < 128 ? bytes[n * 2]! : bytes[n * 2]! - 256) / 128);
      const Q = Float32Array.from({ length: size }, (_, n) => (bytes[n * 2 + 1]! < 128 ? bytes[n * 2 + 1]! : bytes[n * 2 + 1]! - 256) / 128);
      const oi = new Float32Array(Math.ceil(size * 2_400_000 / rate)), oq = oi.slice();
      const copy = bytes.slice();
      const count = native.processCi8(bytes, oi, oq);
      expect(count).toBe(planar.process(I, Q));
      expect(oi.subarray(0, count).every((value, n) => Object.is(value, I[n]))).toBe(true);
      expect(oq.subarray(0, count).every((value, n) => Object.is(value, Q[n]))).toBe(true); expect(bytes.every((value, n) => value === copy[n])).toBe(true);
    }
  }
  expect(() => native.processCi8(new Uint8Array(3), new Float32Array(1), new Float32Array(1))).toThrow();
  native.dispose(); planar.dispose();
});

it.each([4_800_000, 9_600_000, 19_200_000])("normalizes bladeRF SC16 Q11 directly into WASM at %i", rate => {
  const native = new WasmChannelFilter(exports, rate), planar = new WasmChannelFilter(exports, rate);
  for (const offset of [-rate / 2 + 1_200_000, 0, rate / 2 - 1_200_000]) {
    native.reset(offset); planar.reset(offset);
    for (const size of [1, 3, 32768, 8191]) {
      const backing = new Uint8Array(size * 4 + 11), bytes = backing.subarray(5, 5 + size * 4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const I = new Float32Array(size), Q = new Float32Array(size);
      for (let n = 0; n < size; n++) {
        const i = n * 73 % 4096 - 2048, q = n * 151 % 4096 - 2048;
        view.setInt16(n * 4, i, true); view.setInt16(n * 4 + 2, q, true); I[n] = i / 2048; Q[n] = q / 2048;
      }
      const oi = new Float32Array(Math.ceil(size * 2_400_000 / rate)), oq = oi.slice(), copy = bytes.slice();
      const count = native.processSc16(bytes, oi, oq);
      expect(count).toBe(planar.process(I, Q));
      expect(oi.subarray(0, count).every((value, n) => Object.is(value, I[n]))).toBe(true);
      expect(oq.subarray(0, count).every((value, n) => Object.is(value, Q[n]))).toBe(true);
      expect(bytes.every((value, n) => value === copy[n])).toBe(true);
    }
  }
  expect(() => native.processSc16(new Uint8Array(3), new Float32Array(1), new Float32Array(1))).toThrow();
  native.dispose(); planar.dispose();
});


it.each([4_800_000,9_600_000,19_200_000].flatMap(rate =>
  ([false,"ci8","sc16"] as const).map(native => ({rate,native}))))(
  "warm-up leaves first real samples and odd history exact at $rate / $native", ({rate,native}) => {
    const warm = new WasmChannelFilter(exports,rate), cold = new WasmChannelFilter(exports,rate);
    const offset = -700_000;
    warm.reset(offset); cold.reset(offset);
    warmChannelFilter(warm,rate,offset,native);
    for (const size of [137,32768,3]) {
      const I=Float32Array.from({length:size},(_,n)=>Math.cos(n*.31)*.7),Q=Float32Array.from({length:size},(_,n)=>Math.sin(n*.71)*.6);
      const expectedI=I.slice(),expectedQ=Q.slice();
      let count, expectedCount;
      if(native){
        const bytes=new Uint8Array(size*(native==="ci8"?2:4));
        for(let n=0;n<bytes.length;n++)bytes[n]=(n*37)%256;
        const before=bytes.slice();
        count=native==="ci8"?warm.processCi8(bytes,I,Q):warm.processSc16(bytes,I,Q);
        expectedCount=native==="ci8"?cold.processCi8(bytes,expectedI,expectedQ):cold.processSc16(bytes,expectedI,expectedQ);
        expect(bytes).toEqual(before);
      } else {count=warm.process(I,Q);expectedCount=cold.process(expectedI,expectedQ);}
      expect(count).toBe(expectedCount);
      expect(I.subarray(0,count)).toEqual(expectedI.subarray(0,count));
      expect(Q.subarray(0,count)).toEqual(expectedQ.subarray(0,count));
    }
    warm.dispose();cold.dispose();
  });
