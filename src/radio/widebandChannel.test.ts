import { describe, expect, it, vi } from "vitest";
import { CHANNEL_RATE, WIDEBAND_RATE, WidebandChannelFilter, WidebandChannelWorker, CHANNEL_WORKER_SLOTS } from "./widebandChannel";
import { ChannelWorkerFixture } from "../testing/channelWorkerFixture";
function tone(frequency: number, length = 32768, rate = WIDEBAND_RATE) {
  return { I: Float32Array.from({ length }, (_, n) => Math.cos(2 * Math.PI * frequency * n / rate)),
    Q: Float32Array.from({ length }, (_, n) => Math.sin(2 * Math.PI * frequency * n / rate)), frequency: 100e6 };
}
function amplitude(I: Float32Array, Q: Float32Array, count: number, frequency: number): number {
  let re = 0, im = 0; const begin = 300;
  for (let n = begin; n < count; n++) {
    const a = 2 * Math.PI * frequency * n / CHANNEL_RATE;
    re += I[n]! * Math.cos(a) + Q[n]! * Math.sin(a);
    im += Q[n]! * Math.cos(a) - I[n]! * Math.sin(a);
  }
  return Math.hypot(re, im) / (count - begin);
}
describe("4.8 to 2.4 MS/s channel filter", () => {
  it.each([-1e6, -100e3, 0, 100e3, 1e6])("preserves passband amplitude and orientation at %i Hz", frequency => {
    const block = tone(frequency); const count = new WidebandChannelFilter().process(block.I, block.Q);
    expect(count).toBe(16384); expect(amplitude(block.I, block.Q, count, frequency)).toBeCloseTo(1, 3);
    if (frequency) expect(amplitude(block.I, block.Q, count, -frequency)).toBeLessThan(.002);
  });
  it.each([-2.3e6, -2e6, -1.4e6, 1.4e6, 2e6, 2.3e6])("rejects aliases from %i Hz by at least 60 dB", frequency => {
    const block = tone(frequency); const count = new WidebandChannelFilter().process(block.I, block.Q);
    expect(amplitude(block.I, block.Q, count, frequency)).toBeLessThan(.001);
  });
  it.each([-1.7e6, 1.7e6])("mixes a selected channel at offset %i to baseband", offset => {
    const block = tone(offset + 100e3); const count = new WidebandChannelFilter(offset).process(block.I, block.Q);
    expect(amplitude(block.I, block.Q, count, 100e3)).toBeCloseTo(1, 3);
  });
  it("is block-boundary invariant including odd lengths and clears history on reset", () => {
    const source = tone(330123, 8191); const whole = { I: source.I.slice(), Q: source.Q.slice() };
    const f = new WidebandChannelFilter(300000); const size = f.process(whole.I, whole.Q);
    f.reset(300000); const I: number[] = [], Q: number[] = [];
    for (let p = 0; p < source.I.length; p += 137) {
      const i = source.I.slice(p, p + 137), q = source.Q.slice(p, p + 137); const n = f.process(i, q);
      I.push(...i.subarray(0, n)); Q.push(...q.subarray(0, n));
    }
    expect(I).toEqual([...whole.I.subarray(0, size)]); expect(Q).toEqual([...whole.Q.subarray(0, size)]);
    f.reset(0); const i = new Float32Array(400), q = i.slice(); f.process(i, q);
    expect(i.every(v => v === 0)).toBe(true); expect(q.every(v => v === 0)).toBe(true);
  });
});
it.each([4_800_000, 9_600_000])("bounds %i worker transfers and rejects stale generations, then recycles buffers", async rate => {
  const slots = rate === 9_600_000 ? CHANNEL_WORKER_SLOTS * 2 : CHANNEL_WORKER_SLOTS;
  const fake = new ChannelWorkerFixture(); fake.auto = false;
  const deliver = vi.fn(), error = vi.fn();
  const worker = new WidebandChannelWorker(deliver, error, () => fake);
  const ready = worker.configure(1, 0, rate); fake.flushOne(); await ready;
  const block = tone(100000);
  for (let n = 0; n < slots; n++) worker.receive(block, 100e6);
  expect(() => worker.receive(block, 100e6)).toThrow(/bounded queue/);
  void worker.configure(2, 100000, rate);
  for (let n = 0; n <= slots; n++) fake.flushOne();
  expect(deliver).not.toHaveBeenCalled();
  worker.receive(block, 100.1e6); fake.flushOne();
  expect(deliver).toHaveBeenCalledTimes(1); expect(deliver.mock.calls[0]![0].I.length).toBe(rate === 9_600_000 ? 8192 : 16384);
  worker.reset(); worker.receive(block, 100e6); expect(fake.pending).toHaveLength(0);
  worker.close(); worker.close(); expect(error).not.toHaveBeenCalled();
});

describe("9.6 to 2.4 MS/s cascade", () => {
  it.each([-1e6, -100e3, 0, 100e3, 1e6])("preserves level and orientation at %i", frequency => {
    const block = tone(frequency, 32768, 9_600_000);
    const count = new WidebandChannelFilter(0, 9_600_000).process(block.I, block.Q);
    expect(count).toBe(8192); expect(amplitude(block.I, block.Q, count, frequency)).toBeCloseTo(1, 3);
    if (frequency) expect(amplitude(block.I, block.Q, count, -frequency)).toBeLessThan(.002);
  });
  it.each([-4.7e6, -3.8e6, -2.4e6, -1.4e6, 1.4e6, 2.4e6, 3.8e6, 4.7e6])("rejects aliases from %i by at least 60 dB", frequency => {
    const block = tone(frequency, 32768, 9_600_000);
    const count = new WidebandChannelFilter(0, 9_600_000).process(block.I, block.Q);
    expect(amplitude(block.I, block.Q, count, frequency)).toBeLessThan(.001);
  });
  it.each([-3.5e6, 3.5e6])("mixes offset %i with chunk-invariant state and resets both stages", offset => {
    const original = tone(offset + 100e3, 32767, 9_600_000);
    const block = { I: original.I.slice(), Q: original.Q.slice() };
    const filter = new WidebandChannelFilter(offset, 9_600_000);
    const count = filter.process(block.I, block.Q);
    expect(amplitude(block.I, block.Q, count, 100e3)).toBeCloseTo(1, 3);
    filter.reset(offset); const i: number[] = [], q: number[] = [];
    for (let n = 0; n < original.I.length; n += 137) {
      const I = original.I.slice(n, n + 137), Q = original.Q.slice(n, n + 137);
      const size = filter.process(I, Q); i.push(...I.subarray(0, size)); q.push(...Q.subarray(0, size));
    }
    expect(i).toEqual([...block.I.subarray(0, count)]); expect(q).toEqual([...block.Q.subarray(0, count)]);
    filter.reset(0); const I = new Float32Array(1024), Q = I.slice(); filter.process(I, Q);
    expect(I.every(v => v === 0) && Q.every(v => v === 0)).toBe(true);
  });
});
