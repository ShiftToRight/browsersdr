import { describe, expect, it } from "vitest";
import { SyntheticComplexTone } from "./syntheticTone";

const SAMPLE_RATE_HZ = 1_024_000;
const TONE_OFFSET_HZ = 125_000;

describe("SyntheticComplexTone", () => {
  it("produces the requested complex frequency", () => {
    const tone = new SyntheticComplexTone({
      sampleRateHz: SAMPLE_RATE_HZ,
      toneOffsetHz: TONE_OFFSET_HZ,
      amplitude: 0.8,
      initialPhaseRadians: 0.3,
    });
    const block = tone.generate(4096);
    let phaseAdvance = 0;

    for (let index = 1; index < block.I.length; index += 1) {
      const previousI = block.I[index - 1] ?? 0;
      const previousQ = block.Q[index - 1] ?? 0;
      const currentI = block.I[index] ?? 0;
      const currentQ = block.Q[index] ?? 0;
      phaseAdvance += Math.atan2(
        previousI * currentQ - previousQ * currentI,
        previousI * currentI + previousQ * currentQ,
      );
    }

    const measuredHz =
      (phaseAdvance / (block.I.length - 1) / (2 * Math.PI)) * SAMPLE_RATE_HZ;
    expect(measuredHz).toBeCloseTo(TONE_OFFSET_HZ, 2);
  });

  it("preserves phase exactly across differently sized blocks", () => {
    const options = {
      sampleRateHz: SAMPLE_RATE_HZ,
      toneOffsetHz: TONE_OFFSET_HZ,
      amplitude: 0.7,
      initialPhaseRadians: -0.4,
    };
    const splitTone = new SyntheticComplexTone(options);
    const first = splitTone.generate(777);
    const second = splitTone.generate(333);
    const whole = new SyntheticComplexTone(options).generate(1110);

    expect(Array.from(first.I)).toEqual(Array.from(whole.I.slice(0, 777)));
    expect(Array.from(first.Q)).toEqual(Array.from(whole.Q.slice(0, 777)));
    expect(Array.from(second.I)).toEqual(Array.from(whole.I.slice(777)));
    expect(Array.from(second.Q)).toEqual(Array.from(whole.Q.slice(777)));
  });
});
