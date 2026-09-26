import { describe, expect, it } from "vitest";
import type { DigitalInputBlock } from "../digital";
import {
  ACURITE_592_VECTOR,
  FINEOFFSET_WH51_VECTOR,
} from "./fixtures/rtl433Vectors";
import { defaultSrdConfiguration, type SrdConfiguration } from "./settings";
import { SrdReceiver } from "./srdReceiver";

const INPUT_RATE = 1_024_000;

function appendTone(
  I: number[],
  Q: number[],
  durationUs: number,
  frequencyHz: number,
  amplitude: number,
): void {
  const count = Math.round((durationUs * INPUT_RATE) / 1_000_000);
  const start = I.length;
  for (let index = 0; index < count; index++) {
    const angle = (2 * Math.PI * frequencyHz * (start + index)) / INPUT_RATE;
    I.push(Math.cos(angle) * amplitude);
    Q.push(Math.sin(angle) * amplitude);
  }
}

function ookWave(bytes: Uint8Array, offsetHz: number): DigitalInputBlock {
  const I: number[] = [],
    Q: number[] = [];
  appendTone(I, Q, 5_000, offsetHz, 0);
  for (const byte of bytes)
    for (let bit = 7; bit >= 0; bit--) {
      const highUs = byte & (1 << bit) ? 408 : 220;
      appendTone(I, Q, highUs, offsetHz, bit & 1 ? 0.55 : 0.9);
      appendTone(I, Q, 612 - highUs, offsetHz, 0);
    }
  appendTone(I, Q, 8_000, offsetHz, 0);
  return {
    I: Float32Array.from(I),
    Q: Float32Array.from(Q),
    generation: 9,
    firstSampleIndex: 0,
  };
}

function fskWave(
  bytes: Uint8Array,
  offsetHz: number,
  symbolUs = 58,
): DigitalInputBlock {
  const I: number[] = [],
    Q: number[] = [];
  appendTone(I, Q, 4_317, offsetHz, 0);
  const frame = Uint8Array.from([0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...bytes]);
  for (const byte of frame)
    for (let bit = 7; bit >= 0; bit--)
      appendTone(
        I,
        Q,
        symbolUs,
        offsetHz + (byte & (1 << bit) ? 7_000 : -7_000),
        bit & 1 ? 0.65 : 0.95,
      );
  appendTone(I, Q, 8_000, offsetHz, 0);
  return {
    I: Float32Array.from(I),
    Q: Float32Array.from(Q),
    generation: 9,
    firstSampleIndex: 0,
  };
}

function configured(
  modulation: "ook" | "2fsk",
  protocol: SrdConfiguration["protocol"],
  offsetHz: number,
): SrdConfiguration {
  const configuration = defaultSrdConfiguration(INPUT_RATE, 9, offsetHz);
  configuration.modulation = modulation;
  configuration.protocol = protocol;
  configuration.threshold.mode = "manual";
  configuration.threshold.carrierLevel = 0.15;
  configuration.threshold.carrierHysteresis = 0.04;
  configuration.threshold.discriminatorHz = 0;
  configuration.threshold.discriminatorHysteresisHz = 1_000;
  configuration.trace.publicationIntervalInputSamples = 1;
  return configuration;
}

function feedSplit(receiver: SrdReceiver, block: DigitalInputBlock): void {
  const sizes = [1, 37, 2_003, 17, 8_191, 511];
  let at = 0,
    part = 0;
  while (at < block.I.length) {
    const count = Math.min(sizes[part++ % sizes.length]!, block.I.length - at);
    receiver.receive({
      I: block.I.slice(at, at + count),
      Q: block.Q.slice(at, at + count),
      generation: block.generation,
      firstSampleIndex: block.firstSampleIndex + at,
    });
    at += count;
  }
}

describe("SrdReceiver RF paths", () => {
  it("decodes Acurite OOK across arbitrary blocks, amplitude changes and channel offset", () => {
    const receiver = new SrdReceiver();
    receiver.configure(configured("ook", "acurite-592txr", 83_000));
    feedSplit(receiver, ookWave(ACURITE_592_VECTOR.bytes, 83_000));
    expect(receiver.snapshot().value.recentReadings.at(-1)).toMatchObject(
      ACURITE_592_VECTOR.expected,
    );
    expect(receiver.snapshot().value.bursts.at(-1)).toMatchObject({
      modulation: "ook",
      truncated: false,
    });
  });

  it("decodes WH51 binary FSK across arbitrary blocks and timing phase", () => {
    const receiver = new SrdReceiver();
    receiver.configure(configured("2fsk", "fineoffset-wh51", -91_000));
    feedSplit(receiver, fskWave(FINEOFFSET_WH51_VECTOR.bytes, -91_000, 59.5));
    expect(receiver.snapshot().value.recentReadings.at(-1)).toMatchObject(
      FINEOFFSET_WH51_VECTOR.expected,
    );
  });

  it("keeps noise and unknown bursts inspectable without guessed readings", () => {
    const receiver = new SrdReceiver();
    const configuration = configured("ook", "none", 0);
    configuration.threshold.carrierLevel = 0.1;
    receiver.configure(configuration);
    const length = 20_000;
    const I = new Float32Array(length),
      Q = new Float32Array(length);
    for (let index = 0; index < length; index++) {
      I[index] = Math.sin(index * 1.7) * 0.01;
      Q[index] = Math.cos(index * 0.9) * 0.01;
    }
    receiver.receive({ I, Q, generation: 9, firstSampleIndex: 0 });
    expect(receiver.snapshot().value.counters.bursts).toBe(0);
    expect(receiver.snapshot().value.recentReadings).toEqual([]);

    const unknown = ookWave(Uint8Array.from([0xaa, 0x55]), 0);
    unknown.firstSampleIndex = length;
    receiver.receive(unknown);
    expect(receiver.snapshot().value.bursts.length).toBeGreaterThan(0);
    expect(receiver.snapshot().value.recentReadings).toEqual([]);
  });

  it("marks an active burst truncated on reset and bounds trace/history", () => {
    const receiver = new SrdReceiver();
    const configuration = configured("ook", "none", 0);
    configuration.trace.maximumPoints = 8;
    receiver.configure(configuration);
    const I = new Float32Array(20_000).fill(1),
      Q = new Float32Array(20_000);
    receiver.receive({ I, Q, generation: 9, firstSampleIndex: 0 });
    receiver.reset();
    const snapshot = receiver.snapshot().value;
    expect(snapshot.trace.length).toBeLessThanOrEqual(8);
    expect(snapshot.bursts.at(-1)).toMatchObject({
      truncated: true,
      truncationReason: "reset",
    });
    expect(snapshot.counters.tracePointsDropped).toBeGreaterThan(0);
  });

  it("truncates an active burst at an inferred source discontinuity", () => {
    const receiver = new SrdReceiver();
    receiver.configure(configured("ook", "acurite-592txr", 0));
    receiver.receive({
      I: new Float32Array(20_000).fill(1),
      Q: new Float32Array(20_000),
      generation: 9,
      firstSampleIndex: 0,
    });
    receiver.receive({
      I: new Float32Array(4_000),
      Q: new Float32Array(4_000),
      generation: 9,
      firstSampleIndex: 20_257,
    });
    const snapshot = receiver.snapshot().value;
    expect(snapshot.bursts.at(-1)).toMatchObject({
      truncated: true,
      truncationReason: "discontinuity",
    });
    expect(snapshot.recentReadings).toHaveLength(0);
  });

  it("suppresses repeated validated frames on the acquisition clock", () => {
    const receiver = new SrdReceiver();
    receiver.configure(configured("ook", "acurite-592txr", 17_000));
    const first = ookWave(ACURITE_592_VECTOR.bytes, 17_000);
    feedSplit(receiver, first);
    const second = ookWave(ACURITE_592_VECTOR.bytes, 17_000);
    second.firstSampleIndex = first.I.length;
    feedSplit(receiver, second);
    expect(receiver.snapshot().value.counters).toMatchObject({
      validatedReadings: 1,
      duplicateReadings: 1,
    });
    expect(receiver.snapshot().value.recentReadings).toHaveLength(1);
  });

  it("rate-limits cached snapshots and rejects stale generations", () => {
    const receiver = new SrdReceiver();
    const configuration = configured("ook", "none", 0);
    configuration.trace.publicationIntervalInputSamples = 10_000;
    receiver.configure(configuration);
    const initial = receiver.snapshot().sequence;
    receiver.receive({
      I: new Float32Array(5_000),
      Q: new Float32Array(5_000),
      generation: 9,
      firstSampleIndex: 0,
    });
    expect(receiver.snapshot().sequence).toBe(initial);
    receiver.receive({
      I: new Float32Array(6_000),
      Q: new Float32Array(6_000),
      generation: 9,
      firstSampleIndex: 5_000,
    });
    expect(receiver.snapshot().sequence).toBeGreaterThan(initial);
    expect(() =>
      receiver.receive({
        I: new Float32Array(1),
        Q: new Float32Array(1),
        generation: 8,
        firstSampleIndex: 0,
      }),
    ).toThrow(/generation/);
  });
});
