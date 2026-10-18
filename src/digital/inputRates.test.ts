import { expect, it } from "vitest";
import { DigitalChannelReducer } from "./channelReducer";
import { digitalInputProfile } from "./inputRates";

it.each([64_000, 128_000])("preserves passband, rejects aliases and keeps exact chunk phase at 3.2 MS/s → %i", outputSampleRateHz => {
  const rate = 3_200_000, offset = -371_000;
  const configuration = { actualInputSampleRateHz: rate, outputSampleRateHz, selectedChannelOffsetHz: offset, generation: 5, channelBandwidthHz: 20_000 };
  const signal = (hz: number, count: number) => {
    const I = new Float32Array(count), Q = new Float32Array(count);
    for (let n = 0; n < count; n++) { const phase = 2 * Math.PI * (hz + offset) * n / rate; I[n] = Math.cos(phase); Q[n] = Math.sin(phase); }
    return { I, Q };
  };
  const iq = signal(5_000, 350_003), whole = new DigitalChannelReducer(), split = new DigitalChannelReducer();
  whole.configure(configuration); split.configure(configuration);
  const expected = whole.process({ ...iq, generation: 5, firstSampleIndex: 0 });
  const actual: number[] = [], fm: number[] = [];
  let start = 0;
  for (const size of [1, 53, 160_256, 7, 160_256, 29_430]) {
    const end = Math.min(iq.I.length, start + size);
    const result = split.process({ I: iq.I.subarray(start, end), Q: iq.Q.subarray(start, end), generation: 5, firstSampleIndex: start });
    actual.push(...result.I); fm.push(...result.fmHz); start = end;
  }
  expect(start).toBe(iq.I.length);
  expect(Float32Array.from(actual)).toEqual(expected.I);
  expect(Float32Array.from(fm)).toEqual(expected.fmHz);
  expect(expected.I.length).toBe(Math.ceil(iq.I.length / (rate / outputSampleRateHz)));
  expect(expected.provenance.actualInputSampleRateHz).toBe(rate);
  expect(expected.envelope[200]).toBeCloseTo(1, 2);
  expect(expected.fmHz[200]).toBeCloseTo(5_000, 0);
  const alias = new DigitalChannelReducer(); alias.configure(configuration);
  const rejected = alias.process({ ...signal(outputSampleRateHz - 5_000, 160_256), generation: 5, firstSampleIndex: 0 });
  expect(Math.max(...rejected.envelope.subarray(100))).toBeLessThan(0.01);
  expect(() => split.configure({ ...configuration, actualInputSampleRateHz: 3_200_001 })).toThrow(/input rate/);
  const gap = split.process({ ...signal(5_000, 10_000), generation: 5, firstSampleIndex: 360_003 });
  expect(gap.discontinuityBefore?.reason).toBe("source-gap");
  expect(gap.fmHz[0]).toBe(0);
});

it("keeps the older narrow and sensor profiles and rejects unsupported clocks", () => {
  expect(digitalInputProfile(1_024_000)).toEqual({ narrowRateHz: 64_000, sensorRateHz: 128_000 });
  expect(digitalInputProfile(2_400_000)).toEqual({ narrowRateHz: 60_000, sensorRateHz: 120_000 });
  expect(digitalInputProfile(3_200_000)).toEqual({ narrowRateHz: 64_000, sensorRateHz: 128_000 });
  expect(() => digitalInputProfile(3_199_999)).toThrow(/input rate/);
});
