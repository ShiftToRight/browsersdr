import { describe, expect, it } from "vitest";
import {
  DigitalChannelReducer,
  type DigitalChannelConfiguration,
} from "./channelReducer";

const configuration = (
  overrides: Partial<DigitalChannelConfiguration> = {},
): DigitalChannelConfiguration => ({
  actualInputSampleRateHz: 1_024_000,
  selectedChannelOffsetHz: 0,
  generation: 3,
  channelBandwidthHz: 32_000,
  outputSampleRateHz: 64_000,
  ...overrides,
});

function tone(
  length: number,
  rate: number,
  frequency: number,
  start = 0,
): readonly [Float32Array, Float32Array] {
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const angle = (2 * Math.PI * frequency * (start + index)) / rate;
    I[index] = Math.cos(angle);
    Q[index] = Math.sin(angle);
  }
  return [I, Q];
}

function rms(values: Float32Array, skip = 0): number {
  let sum = 0;
  for (let index = skip; index < values.length; index++)
    sum += values[index]! ** 2;
  return Math.sqrt(sum / Math.max(1, values.length - skip));
}

describe("DigitalChannelReducer", () => {
  it("rejects unsupported rates and unsafe output/bandwidth combinations atomically", () => {
    const reducer = new DigitalChannelReducer();
    reducer.configure(configuration());
    expect(() =>
      reducer.configure(configuration({ actualInputSampleRateHz: 2_000_000 })),
    ).toThrow(/1\.024, 2\.4 or 3\.2/);
    expect(() =>
      reducer.configure(configuration({ outputSampleRateHz: 50_000 })),
    ).toThrow(/integer input-rate divisor/);
    expect(() =>
      reducer.configure(configuration({ channelBandwidthHz: 50_000 })),
    ).toThrow(/70%/);
    const [I, Q] = tone(32, 1_024_000, 0);
    expect(
      reducer.process({ I, Q, generation: 3, firstSampleIndex: 0 })
        .outputSampleRateHz,
    ).toBe(64_000);
  });

  it("translates the selected offset and exposes envelope and FM before audio processing", () => {
    const reducer = new DigitalChannelReducer();
    reducer.configure(configuration({ selectedChannelOffsetHz: 120_000 }));
    const [I, Q] = tone(32_768, 1_024_000, 125_000);
    const output = reducer.process({
      I,
      Q,
      generation: 3,
      firstSampleIndex: 10_000,
    });
    expect(rms(output.envelope, 40)).toBeCloseTo(1, 2);
    const discriminator = output.fmHz.subarray(40);
    const mean =
      discriminator.reduce((sum, value) => sum + value, 0) /
      discriminator.length;
    expect(mean).toBeCloseTo(5_000, -1);
    expect(output.provenance).toMatchObject({
      generation: 3,
      firstInputSampleIndex: 10_000,
      actualInputSampleRateHz: 1_024_000,
      selectedChannelOffsetHz: 120_000,
    });
  });

  it("attenuates frequencies that would alias while retaining the passband", () => {
    const measure = (frequency: number) => {
      const reducer = new DigitalChannelReducer();
      reducer.configure(configuration());
      const [I, Q] = tone(65_536, 1_024_000, frequency);
      return rms(
        reducer.process({ I, Q, generation: 3, firstSampleIndex: 0 }).envelope,
        80,
      );
    };
    expect(measure(8_000)).toBeGreaterThan(0.95);
    expect(measure(50_000)).toBeLessThan(0.01);
  });

  it("supports the 2.4 MS/s path with an exact integer output clock", () => {
    const reducer = new DigitalChannelReducer();
    reducer.configure(
      configuration({
        actualInputSampleRateHz: 2_400_000,
        outputSampleRateHz: 60_000,
        channelBandwidthHz: 30_000,
        selectedChannelOffsetHz: -200_000,
      }),
    );
    const [I, Q] = tone(2_400, 2_400_000, -197_000);
    const output = reducer.process({
      I,
      Q,
      generation: 3,
      firstSampleIndex: 0,
    });
    expect(output.I).toHaveLength(60);
    const discriminator = output.fmHz.subarray(20);
    const mean =
      discriminator.reduce((sum, value) => sum + value, 0) /
      discriminator.length;
    expect(mean).toBeCloseTo(3_000, -1);
  });

  it("is invariant to arbitrary chunk splits", () => {
    const [I, Q] = tone(12_345, 1_024_000, 73_125);
    const whole = new DigitalChannelReducer();
    whole.configure(configuration({ selectedChannelOffsetHz: 70_000 }));
    const expected = whole.process({
      I,
      Q,
      generation: 3,
      firstSampleIndex: 500,
    });

    const split = new DigitalChannelReducer();
    split.configure(configuration({ selectedChannelOffsetHz: 70_000 }));
    const parts = [1, 17, 509, 4_003, I.length];
    let from = 0;
    const actualI: number[] = [];
    const actualQ: number[] = [];
    const actualFm: number[] = [];
    for (const to of parts) {
      const output = split.process({
        I: I.slice(from, to),
        Q: Q.slice(from, to),
        generation: 3,
        firstSampleIndex: 500 + from,
      });
      actualI.push(...output.I);
      actualQ.push(...output.Q);
      actualFm.push(...output.fmHz);
      from = to;
    }
    expect(Float32Array.from(actualI)).toEqual(expected.I);
    expect(Float32Array.from(actualQ)).toEqual(expected.Q);
    expect(Float32Array.from(actualFm)).toEqual(expected.fmHz);
  });

  it("resets filter/discriminator state on declared and inferred gaps", () => {
    const reducer = new DigitalChannelReducer();
    reducer.configure(configuration());
    const [I, Q] = tone(4_096, 1_024_000, 5_000);
    reducer.process({ I, Q, generation: 3, firstSampleIndex: 0 });
    const afterGap = reducer.process({
      I: I.slice(0, 32),
      Q: Q.slice(0, 32),
      generation: 3,
      firstSampleIndex: 5_000,
    });
    expect(afterGap.discontinuityBefore).toEqual({
      reason: "source-gap",
      missingInputSamples: 904,
    });
    expect(afterGap.fmHz[0]).toBe(0);
    reducer.reset();
    const reset = reducer.process({
      I: I.slice(0, 32),
      Q: Q.slice(0, 32),
      generation: 3,
      firstSampleIndex: 8_000,
    });
    expect(reset.discontinuityBefore).toBeUndefined();
    expect(reset.fmHz[0]).toBe(0);
  });
});
