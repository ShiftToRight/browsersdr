import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_RATE,
  WIDEBAND_RATE,
  WidebandChannelFilter,
  WidebandChannelWorker,
  CHANNEL_WORKER_SLOTS,
  CHANNEL_SC16_MAX_SAMPLES,
  CHANNEL_USRP_SC16_MAX_SAMPLES,
} from "./widebandChannel";
import { ChannelWorkerFixture } from "../testing/channelWorkerFixture";
function tone(frequency: number, length = 32768, rate = WIDEBAND_RATE) {
  return {
    I: Float32Array.from({ length }, (_, n) =>
      Math.cos((2 * Math.PI * frequency * n) / rate),
    ),
    Q: Float32Array.from({ length }, (_, n) =>
      Math.sin((2 * Math.PI * frequency * n) / rate),
    ),
    frequency: 100e6,
  };
}
function amplitude(
  I: Float32Array,
  Q: Float32Array,
  count: number,
  frequency: number,
): number {
  let re = 0,
    im = 0;
  const begin = 300;
  for (let n = begin; n < count; n++) {
    const a = (2 * Math.PI * frequency * n) / CHANNEL_RATE;
    re += I[n]! * Math.cos(a) + Q[n]! * Math.sin(a);
    im += Q[n]! * Math.cos(a) - I[n]! * Math.sin(a);
  }
  return Math.hypot(re, im) / (count - begin);
}
describe("4.8 to 2.4 MS/s channel filter", () => {
  it.each([-1e6, -100e3, 0, 100e3, 1e6])(
    "preserves passband amplitude and orientation at %i Hz",
    (frequency) => {
      const block = tone(frequency);
      const count = new WidebandChannelFilter().process(block.I, block.Q);
      expect(count).toBe(16384);
      expect(amplitude(block.I, block.Q, count, frequency)).toBeCloseTo(1, 3);
      if (frequency)
        expect(amplitude(block.I, block.Q, count, -frequency)).toBeLessThan(
          0.002,
        );
    },
  );
  it.each([-2.3e6, -2e6, -1.4e6, 1.4e6, 2e6, 2.3e6])(
    "rejects aliases from %i Hz by at least 60 dB",
    (frequency) => {
      const block = tone(frequency);
      const count = new WidebandChannelFilter().process(block.I, block.Q);
      expect(amplitude(block.I, block.Q, count, frequency)).toBeLessThan(0.001);
    },
  );
  it.each([-1.7e6, 1.7e6])(
    "mixes a selected channel at offset %i to baseband",
    (offset) => {
      const block = tone(offset + 100e3);
      const count = new WidebandChannelFilter(offset).process(block.I, block.Q);
      expect(amplitude(block.I, block.Q, count, 100e3)).toBeCloseTo(1, 3);
    },
  );
  it("is block-boundary invariant including odd lengths and clears history on reset", () => {
    const source = tone(330123, 8191);
    const whole = { I: source.I.slice(), Q: source.Q.slice() };
    const f = new WidebandChannelFilter(300000);
    const size = f.process(whole.I, whole.Q);
    f.reset(300000);
    const I: number[] = [],
      Q: number[] = [];
    for (let p = 0; p < source.I.length; p += 137) {
      const i = source.I.slice(p, p + 137),
        q = source.Q.slice(p, p + 137);
      const n = f.process(i, q);
      I.push(...i.subarray(0, n));
      Q.push(...q.subarray(0, n));
    }
    expect(I).toEqual([...whole.I.subarray(0, size)]);
    expect(Q).toEqual([...whole.Q.subarray(0, size)]);
    f.reset(0);
    const i = new Float32Array(400),
      q = i.slice();
    f.process(i, q);
    expect(i.every((v) => v === 0)).toBe(true);
    expect(q.every((v) => v === 0)).toBe(true);
  });
});
it.each([4_800_000, 9_600_000, 19_200_000])(
  "bounds %i worker transfers and rejects stale generations, then recycles buffers",
  async (rate) => {
    const slots = (CHANNEL_WORKER_SLOTS * rate) / 4_800_000;
    const fake = new ChannelWorkerFixture();
    fake.auto = false;
    const deliver = vi.fn(),
      error = vi.fn();
    const worker = new WidebandChannelWorker(deliver, error, () => fake);
    const ready = worker.configure(1, 0, rate);
    fake.flushOne();
    await ready;
    const block = tone(100000);
    for (let n = 0; n < slots; n++) worker.receive(block, 100e6);
    expect(() => worker.receive(block, 100e6)).toThrow(/bounded queue/);
    void worker.configure(2, 100000, rate);
    for (let n = 0; n <= slots; n++) fake.flushOne();
    expect(deliver).not.toHaveBeenCalled();
    worker.receive(block, 100.1e6);
    fake.flushOne();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0].I.length).toBe((32768 * 2_400_000) / rate);
    worker.reset();
    worker.receive(block, 100e6);
    expect(fake.pending).toHaveLength(0);
    worker.close();
    worker.close();
    expect(error).not.toHaveBeenCalled();
  },
);

describe.each([9_600_000, 19_200_000])("%i to 2.4 MS/s cascade", (rate) => {
  it.each([-1e6, -100e3, 0, 100e3, 1e6])(
    "preserves level and orientation at %i",
    (frequency) => {
      const block = tone(frequency, 32768, rate);
      const count = new WidebandChannelFilter(0, rate).process(
        block.I,
        block.Q,
      );
      expect(count).toBe((32768 * 2_400_000) / rate);
      expect(amplitude(block.I, block.Q, count, frequency)).toBeCloseTo(1, 3);
      if (frequency)
        expect(amplitude(block.I, block.Q, count, -frequency)).toBeLessThan(
          0.002,
        );
    },
  );
  it.each([-4.7e6, -3.8e6, -2.4e6, -1.4e6, 1.4e6, 2.4e6, 3.8e6, 4.7e6])(
    "rejects aliases from %i by at least 60 dB",
    (frequency) => {
      const block = tone(frequency, 32768, rate);
      const count = new WidebandChannelFilter(0, rate).process(
        block.I,
        block.Q,
      );
      expect(amplitude(block.I, block.Q, count, frequency)).toBeLessThan(0.001);
    },
  );
  it.each([-3.5e6, 3.5e6])(
    "mixes offset %i with chunk-invariant state and resets both stages",
    (offset) => {
      const original = tone(offset + 100e3, 32767, rate);
      const block = { I: original.I.slice(), Q: original.Q.slice() };
      const filter = new WidebandChannelFilter(offset, rate);
      const count = filter.process(block.I, block.Q);
      expect(amplitude(block.I, block.Q, count, 100e3)).toBeCloseTo(1, 3);
      filter.reset(offset);
      const i: number[] = [],
        q: number[] = [];
      for (let n = 0; n < original.I.length; n += 137) {
        const I = original.I.slice(n, n + 137),
          Q = original.Q.slice(n, n + 137);
        const size = filter.process(I, Q);
        i.push(...I.subarray(0, size));
        q.push(...Q.subarray(0, size));
      }
      expect(i).toEqual([...block.I.subarray(0, count)]);
      expect(q).toEqual([...block.Q.subarray(0, count)]);
      filter.reset(0);
      const I = new Float32Array(1024),
        Q = I.slice();
      filter.process(I, Q);
      expect(I.every((v) => v === 0) && Q.every((v) => v === 0)).toBe(true);
    },
  );
});

it.each([-9.5e6, -8.6e6, 8.6e6, 9.5e6])(
  "rejects 19.2 MS/s first-stage alias %i",
  (frequency) => {
    const block = tone(frequency, 32768, 19_200_000);
    const count = new WidebandChannelFilter(0, 19_200_000).process(
      block.I,
      block.Q,
    );
    expect(amplitude(block.I, block.Q, count, frequency)).toBeLessThan(0.001);
  },
);
it.each([-8e6, 8e6])("selects an outer 19.2 MS/s channel %i", (offset) => {
  const block = tone(offset + 100e3, 32768, 19_200_000);
  const count = new WidebandChannelFilter(offset, 19_200_000).process(
    block.I,
    block.Q,
  );
  expect(amplitude(block.I, block.Q, count, 100e3)).toBeCloseTo(1, 3);
});

it("reports a bounded recent timing window and clears it across generations", async () => {
  let now = 0,
    compute = 10;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const fake = new ChannelWorkerFixture();
  fake.auto = false;
  const worker = new WidebandChannelWorker(
    () => {
      now += 0.1;
    },
    vi.fn(),
    () => fake,
  );
  const onmessage = fake.onmessage!;
  fake.onmessage = (event) => {
    if (event.data.type === "samples") event.data.processingMs = compute;
    onmessage.call(fake as unknown as Worker, event);
  };
  try {
    const ready = worker.configure(1, 0);
    fake.flushOne();
    await ready;
    for (let n = 0; n < 300; n++) {
      compute = n < 44 ? 10 : 0.05;
      worker.receive(tone(0, 1024), 100e6);
      now += 2;
      fake.flushOne();
    }
    expect(worker.diagnostics).toMatchObject({
      recentBlocks: 256,
      queuedBlocks: 0,
      peakQueuedBlocks: 1,
      capacityBlocks: CHANNEL_WORKER_SLOTS,
      computeMaximumMs: 0.05,
    });
    expect(worker.diagnostics.computeAverageMs).toBeCloseTo(0.05);
    expect(worker.diagnostics.computeBudgetPercent).toBeCloseTo(23.4375);
    expect(worker.diagnostics.turnaroundMaximumMs).toBeCloseTo(2.1);
    worker.receive(tone(0, 1024), 100e6);
    void worker.configure(2, 0);
    fake.flushOne();
    fake.flushOne();
    expect(worker.diagnostics.recentBlocks).toBe(0);
    expect(worker.diagnostics.queuedBlocks).toBe(0);
  } finally {
    worker.close();
    clock.mockRestore();
  }
});

it.each([4_800_000, 9_600_000, 19_200_000])(
  "bounds native pools and returns small outputs across stale generations at %i",
  async (rate) => {
    const fake = new ChannelWorkerFixture();
    fake.auto = false;
    const deliver = vi.fn();
    const worker = new WidebandChannelWorker(deliver, vi.fn(), () => fake);
    const ready = worker.configure(1, 0, rate, "ci8");
    fake.flushOne();
    await ready;
    const bytes = new Uint8Array(65536);
    bytes.fill(64);
    const slots = (CHANNEL_WORKER_SLOTS * rate) / 4_800_000;
    for (let n = 0; n < slots; n++) worker.receiveCi8(bytes, 100e6);
    expect(bytes.byteLength).toBe(65536); // borrowed source never transferred
    expect(worker.diagnostics.queuedBlocks).toBe(slots);
    for (const message of fake.pending) {
      if (message.type !== "ci8") throw new Error("Expected compact input");
      expect(message.bytes.byteLength).toBe(65536);
      expect(message.I.byteLength + message.Q.byteLength).toBe(
        (262144 * 2_400_000) / rate,
      );
    }
    expect(() => worker.receiveCi8(bytes, 100e6)).toThrow(/bounded queue/);
    void worker.configure(2, 0, rate, "ci8");
    while (fake.pending.length) fake.flushOne();
    expect(deliver).not.toHaveBeenCalled();
    expect(worker.diagnostics.queuedBlocks).toBe(0);
    worker.receiveCi8(bytes, 100e6);
    fake.flushOne();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0].I.length).toBe((32768 * 2_400_000) / rate);
    expect(worker.diagnostics.queuedBlocks).toBe(0);
    worker.close();
    worker.close();
  },
);

it.each([4_800_000, 9_600_000, 19_200_000])(
  "decodes native bladeRF SC16 Q11 off-thread at %i",
  async (rate) => {
    const fake = new ChannelWorkerFixture();
    fake.auto = false;
    const deliver = vi.fn();
    const worker = new WidebandChannelWorker(deliver, vi.fn(), () => fake);
    const ready = worker.configure(1, 0, rate, "sc16");
    fake.flushOne();
    await ready;
    expect(worker.diagnostics.capacityBlocks).toBe(
      (CHANNEL_WORKER_SLOTS * 2 * rate) / 4_800_000,
    );
    const bytes = new Uint8Array(CHANNEL_SC16_MAX_SAMPLES * 4);
    const view = new DataView(bytes.buffer);
    for (let n = 0; n < CHANNEL_SC16_MAX_SAMPLES; n++) {
      view.setInt16(n * 4, 1024, true);
      view.setInt16(n * 4 + 2, -1024, true);
    }
    worker.receiveSc16(bytes, 100e6);
    expect(fake.pending[0]).toMatchObject({
      type: "sc16",
      inputCount: CHANNEL_SC16_MAX_SAMPLES,
    });
    fake.flushOne();
    expect(deliver).toHaveBeenCalledOnce();
    const block = deliver.mock.calls[0]![0];
    expect(block.I.length).toBe((CHANNEL_SC16_MAX_SAMPLES * 2_400_000) / rate);
    expect(block.I.at(-1)).toBeCloseTo(0.5, 3);
    expect(block.Q.at(-1)).toBeCloseTo(-0.5, 3);
    worker.close();
  },
);

it("decodes native USRP Q/I SC16 with full-scale normalization off-thread", async () => {
  const fake = new ChannelWorkerFixture();
  fake.auto = false;
  const deliver = vi.fn();
  const worker = new WidebandChannelWorker(deliver, vi.fn(), () => fake);
  const ready = worker.configure(1, 0, 4_800_000, "usrp-sc16");
  fake.flushOne();
  await ready;
  const bytes = new Uint8Array(CHANNEL_USRP_SC16_MAX_SAMPLES * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < CHANNEL_USRP_SC16_MAX_SAMPLES; n++) {
    view.setInt16(n * 4, -16_384, true); // Q is the low half-word.
    view.setInt16(n * 4 + 2, 16_384, true); // I is the high half-word.
  }
  worker.receiveUsrpSc16(bytes, 100e6);
  expect(fake.pending[0]).toMatchObject({
    type: "usrp-sc16",
    inputCount: CHANNEL_USRP_SC16_MAX_SAMPLES,
  });
  fake.flushOne();
  const block = deliver.mock.calls[0]![0];
  expect(block.I.at(-1)).toBeCloseTo(0.5, 3);
  expect(block.Q.at(-1)).toBeCloseTo(-0.5, 3);
  worker.close();
});

it("keeps bladeRF 19.2 MS/s buffering bounded at the intended 437 ms", async () => {
  const fake = new ChannelWorkerFixture();
  fake.auto = false;
  const worker = new WidebandChannelWorker(vi.fn(), vi.fn(), () => fake);
  const ready = worker.configure(1, 0, 19_200_000, "sc16");
  fake.flushOne();
  await ready;
  const bytes = new Uint8Array(CHANNEL_SC16_MAX_SAMPLES * 4);
  const slots = CHANNEL_WORKER_SLOTS * 2 * 4;
  for (let n = 0; n < slots; n++) worker.receiveSc16(bytes, 100e6);
  expect(worker.diagnostics).toMatchObject({
    capacityBlocks: slots,
    queuedBlocks: slots,
    peakQueuedBlocks: slots,
  });
  expect(((slots * CHANNEL_SC16_MAX_SAMPLES) / 19_200_000) * 1000).toBeCloseTo(
    436.907,
    3,
  );
  expect(() => worker.receiveSc16(bytes, 100e6)).toThrow(/bounded queue/);
  while (fake.pending.length) fake.flushOne();
  expect(worker.diagnostics.queuedBlocks).toBe(0);
  worker.close();
});
