import { describe, expect, it, vi } from "vitest";
import {
  DemodWBFM,
  DemodWBFMStage1,
  DemodWBFMStage2,
} from "@jtarrio/signals/demod/demod-wbfm.js";
import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { DemodAM } from "@jtarrio/signals/demod/demod-am.js";
import { SharedWbfmDemodulator } from "./sharedWbfmDemodulator";
import {
  AudioFirstRdsReceiver,
  RdsMultiplexReceiver,
} from "../rds/rdsMultiplexReceiver";

function player(rate = 48000) {
  return {
    sampleRate: rate,
    play: vi.fn(),
    setVolume: vi.fn(),
    getVolume: () => 0.5,
  };
}
function block(rate: number, start: number, count: number, offset: number) {
  const I = new Float32Array(count),
    Q = new Float32Array(count);
  for (let n = 0; n < count; n++) {
    const t = (start + n) / rate;
    const phase =
      2 * Math.PI * offset * t +
      12 * Math.sin(2 * Math.PI * 1000 * t) +
      0.2 * Math.sin(2 * Math.PI * 57000 * t);
    I[n] = Math.cos(phase);
    Q[n] = Math.sin(phase);
  }
  return { I, Q, frequency: 100e6 };
}
describe("shared WBFM multiplex", () => {
  it("keeps short white-noise blocks muted above the measured noise and admits a sustained AM carrier", () => {
    const sink = player(),
      meter = vi.fn();
    const shared = new SharedWbfmDemodulator(sink, vi.fn(), meter);
    shared.setSampleRate(48_000);
    shared.setMode({
      scheme: "AM",
      bandwidth: 8_000,
      squelch: 1.5,
    } as Parameters<Demodulator["setMode"]>[0]);
    let seed = 321,
      now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    const receive = (carrier = false) => {
      const I = Float32Array.from({ length: 164 }, () =>
        carrier ? 1 : random(),
      );
      const Q = Float32Array.from({ length: 164 }, () =>
        carrier ? 0 : random(),
      );
      now += I.length / 48;
      shared.receiveSamples({ I, Q, frequency: 120_025_000 });
    };
    try {
      // The previous raw-block gate opens six times in this deterministic noise
      // stream, all while its separately smoothed meter is below the threshold.
      for (let n = 0; n < 3_000; n++) {
        receive();
        expect(sink.play.mock.lastCall![0]).toEqual(new Float32Array(164));
      }
      expect(meter.mock.calls.every(([state]) => !state.open)).toBe(true);
      for (let n = 0; n < 20; n++) receive(true);
      const opening = meter.mock.calls.find(([state]) => state.open)?.[0];
      expect(opening).toMatchObject({ open: true });
      expect(opening.level).toBeGreaterThan(1.6);
      for (let n = 0; n < 100; n++) receive();
      expect(meter.mock.lastCall?.[0]).toMatchObject({ open: false });
      expect(sink.play.mock.lastCall![0]).toEqual(new Float32Array(164));
      for (let n = 0; n < 20; n++) receive(true);
      shared.setFrequencyOffset(0);
      receive();
      expect(meter.mock.lastCall?.[0]).toMatchObject({ open: false });
      expect(sink.play.mock.lastCall![0]).toEqual(new Float32Array(164));
    } finally {
      clock.mockRestore();
    }
  });
  it("uses the same gate response for different USB block sizes and output sample rates", () => {
    const demodulate = vi
      .spyOn(DemodAM.prototype, "demodulate")
      .mockImplementation((I, Q) => ({
        left: I.fill(0.25),
        right: Q.fill(0.25),
        stereo: false,
        snr: 2,
      }));
    let now = 1_000;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (now += 200));
    const levels: number[] = [];
    try {
      for (const [rate, frames] of [
        [48_000, 48],
        [48_000, 480],
        [24_000, 240],
      ] as const) {
        const sink = player(rate),
          meter = vi.fn();
        const shared = new SharedWbfmDemodulator(sink, vi.fn(), meter);
        shared.setSampleRate(rate);
        shared.setMode({
          scheme: "AM",
          bandwidth: 8_000,
          squelch: 1.5,
        } as Parameters<Demodulator["setMode"]>[0]);
        for (let elapsed = 0; elapsed < rate * 0.05; elapsed += frames)
          shared.receiveSamples({
            I: new Float32Array(frames),
            Q: new Float32Array(frames),
            frequency: 120_025_000,
          });
        const opening = meter.mock.calls.find(([state]) => state.open)?.[0];
        expect(opening).toBeDefined();
        expect(opening.level).toBeGreaterThan(1.6);
        levels.push(meter.mock.lastCall![0].level);
        expect(sink.play.mock.lastCall![0][0]).toBe(0.25);
      }
      // Fifty milliseconds of input gives the same measurement regardless of
      // the USB partition or the player's sample rate.
      expect(levels[1]).toBeCloseTo(levels[2]!, 12);
      expect(levels[0]).toBeCloseTo(levels[1]!, 12);
    } finally {
      demodulate.mockRestore();
      clock.mockRestore();
    }
  });
  it.each([1_024_000, 2_400_000, 3_200_000])(
    "matches independent audio/RDS stages at %i with offsets, irregular blocks and resets",
    (rate) => {
      const sink = player();
      let observed = new Float32Array(0);
      const shared = new SharedWbfmDemodulator(sink, (data) => {
        observed = data.slice();
      });
      for (const offset of [0, 100_000, -100_000]) {
        shared.setSampleRate(rate);
        shared.setFrequencyOffset(offset);
        const audio = new DemodWBFM(rate, 48000, {
          scheme: "WBFM",
          stereo: true,
        });
        const rds = new DemodWBFMStage1(rate, 336000, {
          scheme: "WBFM",
          stereo: false,
        });
        let start = 0;
        for (const count of [4096, 137, 8192, 1, 4095]) {
          const input = block(rate, start, count, offset);
          start += count;
          const expected = audio.demodulate(
            input.I.slice(),
            input.Q.slice(),
            offset,
          );
          const multiplex = rds.demodulate(
            input.I.slice(),
            input.Q.slice(),
            offset,
          ).left;
          shared.receiveSamples(input);
          expect(observed).toEqual(multiplex);
          expect(sink.play.mock.lastCall![0]).toEqual(expected.left);
          expect(sink.play.mock.lastCall![1]).toEqual(expected.right);
        }
      }
    },
  );
  it("bypasses the second RDS first-stage path and retains raw analysis ordering", () => {
    const sink = player(),
      rds = new RdsMultiplexReceiver(vi.fn());
    const tap = vi.spyOn(rds, "receiveMultiplex"),
      duplicate = vi.spyOn(rds, "receiveOwnedSamples");
    const shared = new SharedWbfmDemodulator(sink, (samples) =>
      rds.receiveMultiplex(samples),
    );
    const input = block(2_400_000, 0, 4096, 0),
      original = input.I.slice();
    const analysis = {
      setSampleRate: vi.fn(),
      receiveSamples: vi.fn((b) => expect(b.I).toEqual(original)),
    };
    const receiver = new AudioFirstRdsReceiver(shared, rds, analysis);
    receiver.setSampleRate(2_400_000);
    receiver.receiveSamples(input);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
    expect(analysis.receiveSamples).toHaveBeenCalledTimes(1);
  });
  it("retains non-WBFM audio and returns cleanly to WBFM", () => {
    const a = player(),
      b = player(),
      tap = vi.fn();
    const shared = new SharedWbfmDemodulator(a, tap),
      legacy = new Demodulator({ player: b });
    for (const demod of [shared, legacy]) {
      demod.setMode({
        scheme: "AM",
        bandwidth: 10000,
        squelch: 0,
      } as Parameters<Demodulator["setMode"]>[0]);
      demod.setSampleRate(2_400_000);
    }
    const input = block(2_400_000, 0, 8192, 0);
    shared.receiveSamples({ ...input, I: input.I.slice(), Q: input.Q.slice() });
    legacy.receiveSamples(input);
    expect(a.play.mock.lastCall).toEqual(b.play.mock.lastCall);
    expect(tap).not.toHaveBeenCalled();
    shared.setMode({ scheme: "WBFM", stereo: true } as Parameters<
      Demodulator["setMode"]
    >[0]);
    shared.receiveSamples(block(2_400_000, 0, 4096, 0));
    expect(tap).toHaveBeenCalledTimes(1);
  });
  it("reports the same live quality used by squelch and keeps zero fully open", () => {
    const sink = player(),
      meter = vi.fn();
    const shared = new SharedWbfmDemodulator(sink, vi.fn(), meter);
    shared.setSampleRate(1_024_000);
    shared.setMode({
      scheme: "AM",
      bandwidth: 10_000,
      squelch: 6,
    } as Parameters<Demodulator["setMode"]>[0]);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_200);
    let seed = 1234;
    const noise = () => {
      const I = new Float32Array(16_384),
        Q = new Float32Array(I.length);
      for (let n = 0; n < I.length; n++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        I[n] = (seed / 0xffffffff) * 2 - 1;
        seed = (1664525 * seed + 1013904223) >>> 0;
        Q[n] = (seed / 0xffffffff) * 2 - 1;
      }
      return { I, Q, frequency: 100e6 };
    };
    shared.receiveSamples(noise());
    expect(meter.mock.lastCall?.[0]).toMatchObject({ open: false });
    expect(
      Array.from(sink.play.mock.lastCall![0] as Float32Array).every(
        (value) => value === 0,
      ),
    ).toBe(true);

    shared.setMode({
      scheme: "AM",
      bandwidth: 10_000,
      squelch: 0,
    } as Parameters<Demodulator["setMode"]>[0]);
    shared.receiveSamples(noise());
    expect(meter.mock.lastCall?.[0]).toMatchObject({ open: true });
    clock.mockRestore();
  });
  it("caps steady meter reports at 5 Hz but reports squelch edges immediately", () => {
    const sink = player(),
      meter = vi.fn();
    const shared = new SharedWbfmDemodulator(sink, vi.fn(), meter);
    shared.setSampleRate(1_024_000);
    shared.setMode({
      scheme: "AM",
      bandwidth: 10_000,
      squelch: 6,
    } as Parameters<Demodulator["setMode"]>[0]);
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const noise = block(1_024_000, 0, 16_384, 0);

    shared.receiveSamples(noise);
    now = 1_050;
    shared.receiveSamples(noise);
    expect(meter).toHaveBeenCalledTimes(1);

    shared.setMode({
      scheme: "AM",
      bandwidth: 10_000,
      squelch: 0,
    } as Parameters<Demodulator["setMode"]>[0]);
    now = 1_060;
    shared.receiveSamples(noise);
    expect(meter).toHaveBeenCalledTimes(2);
    expect(meter.mock.lastCall?.[0]).toMatchObject({ open: true });

    now = 1_259;
    shared.receiveSamples(noise);
    expect(meter).toHaveBeenCalledTimes(2);
    now = 1_260;
    shared.receiveSamples(noise);
    expect(meter).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });
});

it("decodes the independent RDS fixture through the shared RF first stage", async () => {
  const { createRdsMultiplexFixture } = await import("../testing/rdsFixture");
  const multiplex = createRdsMultiplexFixture();
  const updates = vi.fn(),
    rds = new RdsMultiplexReceiver(updates);
  const shared = new SharedWbfmDemodulator(player(), (samples) =>
    rds.receiveMultiplex(samples),
  );
  const receiver = new AudioFirstRdsReceiver(shared, rds);
  receiver.setSampleRate(228_000);
  let phase = 0;
  for (let p = 0; p < multiplex.length; p += 4096) {
    const length = Math.min(4096, multiplex.length - p),
      I = new Float32Array(length),
      Q = I.slice();
    for (let n = 0; n < length; n++) {
      phase += ((2 * Math.PI * 75000) / 228000) * multiplex[p + n]!;
      I[n] = Math.cos(phase);
      Q[n] = Math.sin(phase);
    }
    receiver.receiveSamples({ I, Q, frequency: 100e6 });
  }
  expect(updates.mock.lastCall?.[0]).toMatchObject({
    pi: "C201",
    programmeService: "CODEX FM",
    radioText: "BrowserSDR RDS fixture",
  });
});

it("recovers separate left/right FM tones and falls back to mono without a pilot", () => {
  const sink = player();
  const status = vi.fn();
  const demod = new SharedWbfmDemodulator(sink, vi.fn(), undefined, status);
  const rate = 336_000;
  demod.setSampleRate(rate);
  let phase = 0;
  const left: number[] = [],
    right: number[] = [];
  for (let at = 0; at < rate * 3; at += 4096) {
    const count = Math.min(4096, rate * 3 - at);
    const I = new Float32Array(count),
      Q = new Float32Array(count);
    for (let n = 0; n < count; n++) {
      const t = (at + n) / rate;
      const l = 0.3 * Math.sin(2 * Math.PI * 1000 * t),
        r = 0.3 * Math.sin(2 * Math.PI * 3000 * t);
      const multiplex =
        (l + r) / 2 +
        ((l - r) / 2) * Math.sin(2 * Math.PI * 38000 * t) +
        0.1 * Math.sin(2 * Math.PI * 19000 * t);
      phase += (2 * Math.PI * 75000 * multiplex) / rate;
      I[n] = Math.cos(phase);
      Q[n] = Math.sin(phase);
    }
    demod.receiveSamples({ I, Q, frequency: 100e6 });
    if (at > rate) {
      left.push(...sink.play.mock.lastCall![0]);
      right.push(...sink.play.mock.lastCall![1]);
    }
  }
  const amplitude = (samples: number[], f: number) => {
    let i = 0,
      q = 0;
    samples.forEach((sample, n) => {
      i += sample * Math.cos((2 * Math.PI * f * n) / 48000);
      q += sample * Math.sin((2 * Math.PI * f * n) / 48000);
    });
    return Math.hypot(i, q) / samples.length;
  };
  expect(status.mock.lastCall?.[0]).toBe("stereo");
  expect(amplitude(left, 1000) / amplitude(left, 3000)).toBeGreaterThan(8);
  expect(amplitude(right, 3000) / amplitude(right, 1000)).toBeGreaterThan(8);
  demod.setFrequencyOffset(0);
  expect(status.mock.lastCall?.[0]).toBeUndefined();
  for (let at = 0; at < rate * 3; at += 4096)
    demod.receiveSamples(block(rate, at, Math.min(4096, rate * 3 - at), 0));
  expect(status.mock.lastCall?.[0]).toBe("mono");
  expect(sink.play.mock.lastCall![0]).toEqual(sink.play.mock.lastCall![1]);
});

it("stabilizes the indicator while leaving instantaneous left/right playback unchanged", () => {
  const first = vi
    .spyOn(DemodWBFMStage1.prototype, "demodulate")
    .mockImplementation((I) => ({ left: I, right: I, stereo: false, snr: 1 }));
  const second = vi.spyOn(DemodWBFMStage2.prototype, "demodulate");
  const sink = player(),
    status = vi.fn();
  try {
    const demod = new SharedWbfmDemodulator(sink, vi.fn(), undefined, status);
    demod.setSampleRate(336_000);
    const I = new Float32Array(3360),
      Q = I.slice();
    const mono = {
      left: new Float32Array([0.4]),
      right: new Float32Array([0.4]),
      stereo: false,
      snr: 1,
    };
    const stereo = {
      left: new Float32Array([0.7]),
      right: new Float32Array([0.2]),
      stereo: true,
      snr: 1,
    };
    for (let n = 0; n < 400; n++) {
      const audio = n % 2 ? mono : stereo;
      second.mockReturnValue(audio);
      demod.receiveSamples({ I, Q, frequency: 100e6 });
      expect(sink.play.mock.lastCall).toEqual([audio.left, audio.right]);
    }
    expect(status.mock.calls.map(([s]) => s).filter(Boolean)).toEqual([
      "intermittent",
    ]);
    demod.setFrequencyOffset(1000);
    expect(status.mock.lastCall?.[0]).toBeUndefined();
    demod.setMode({ scheme: "AM", bandwidth: 10000, squelch: 0 } as Parameters<
      Demodulator["setMode"]
    >[0]);
    expect(status.mock.lastCall?.[0]).toBeUndefined();
  } finally {
    first.mockRestore();
    second.mockRestore();
  }
});
