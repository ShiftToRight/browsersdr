import { describe, expect, it } from "vitest";
import type { ReducedDigitalBlock } from "../digital";
import { SrdPulseInspector, estimateTiming } from "./inspector";
import { defaultSrdConfiguration, validateSrdConfiguration } from "./settings";

function reduced(
  envelope: number[],
  fmHz: number[] = envelope.map(() => 0),
): ReducedDigitalBlock {
  return {
    I: new Float32Array(envelope.length),
    Q: new Float32Array(envelope.length),
    envelope: Float32Array.from(envelope),
    fmHz: Float32Array.from(fmHz),
    outputSampleRateHz: 100_000,
    firstOutputInputSampleIndex: 0,
    inputSamplesPerOutput: 10,
    provenance: {
      generation: 1,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: envelope.length * 10 - 1,
      actualInputSampleRateHz: 1_000_000,
      selectedChannelOffsetHz: 0,
    },
  };
}

describe("SrdPulseInspector", () => {
  it("includes each decimated sample's full acquisition interval in pulse duration", () => {
    const configuration = defaultSrdConfiguration(3_200_000, 1);
    configuration.threshold.mode = "manual";
    configuration.threshold.carrierLevel = 0.2;
    configuration.burst.minimumDurationUs = 0;
    configuration.burst.endGapUs = 20;
    const inspector = new SrdPulseInspector(configuration);
    const block = reduced([0, 1, 1, 1, 0, 0, 0, 0]);
    block.inputSamplesPerOutput = 25;
    block.outputSampleRateHz = 128_000;
    block.provenance.actualInputSampleRateHz = 3_200_000;
    const [burst] = inspector.process(block);
    expect(burst?.pulses[0]).toMatchObject({ firstInputSampleIndex: 25, lastInputSampleIndex: 99, durationUs: 23.4375 });
  });
  it("uses adaptive carrier thresholding and exposes explicit bit-slice assumptions", () => {
    const configuration = defaultSrdConfiguration(1_024_000, 1);
    configuration.actualInputSampleRateHz = 1_000_000;
    configuration.modulation = "ook";
    configuration.burst.minimumDurationUs = 100;
    configuration.burst.endGapUs = 100;
    configuration.bitSlice = {
      enabled: true,
      symbolUs: 100,
      encoding: "pwm-pulse-width",
      polarity: "normal",
    };
    const inspector = new SrdPulseInspector(configuration);
    const samples = [
      ...Array(100).fill(0.01),
      ...Array(20).fill(0.12),
      ...Array(5).fill(0.01),
      ...Array(40).fill(0.45),
      ...Array(20).fill(0.01),
    ];
    const bursts = inspector.process(reduced(samples));
    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.bitSlice).toMatchObject({
      encoding: "pwm-pulse-width",
      symbolUs: 100,
      polarity: "normal",
    });
    expect(bursts[0]!.timingCandidates[0]).toMatchObject({
      basis: "pulse-duration-cluster",
    });
  });

  it("caps pulse and trace storage and marks pulse overflow truncated", () => {
    const configuration = defaultSrdConfiguration(1_024_000, 1);
    configuration.actualInputSampleRateHz = 1_000_000;
    configuration.modulation = "2fsk";
    configuration.threshold.mode = "manual";
    configuration.threshold.carrierLevel = 0.1;
    configuration.threshold.discriminatorHysteresisHz = 0;
    configuration.burst.minimumDurationUs = 100;
    configuration.burst.endGapUs = 100;
    configuration.trace.decimation = 1;
    configuration.trace.maximumPoints = 16;
    const inspector = new SrdPulseInspector(configuration);
    const active = Array(1_200).fill(0.5);
    const fm = active.map((_, index) => (index % 2 ? 2_000 : -2_000));
    const bursts = inspector.process(
      reduced([...active, ...Array(20).fill(0)], [...fm, ...Array(20).fill(0)]),
    );
    expect(bursts[0]!.pulses.length).toBeLessThanOrEqual(128);
    expect(bursts[0]).toMatchObject({ truncated: true });
    expect(bursts[0]!.pulseOverflow).toBeGreaterThan(0);
    expect(inspector.traceSnapshot()).toHaveLength(16);
    expect(inspector.droppedTracePoints).toBeGreaterThan(0);
  });

  it("reports duration clusters as candidates, not identities", () => {
    expect(
      estimateTiming([
        { durationUs: 495 },
        { durationUs: 505 },
        { durationUs: 1_000 },
      ]),
    ).toEqual([
      { symbolUs: 500, support: 2, basis: "pulse-duration-cluster" },
      { symbolUs: 1_000, support: 1, basis: "pulse-duration-cluster" },
    ]);
  });

  it("rejects protocol/modulation mismatches and excessive trace bounds", () => {
    const mismatch = defaultSrdConfiguration(1_024_000, 1);
    mismatch.protocol = "fineoffset-wh51";
    expect(() => validateSrdConfiguration(mismatch)).toThrow(/does not match/);
    const excessive = defaultSrdConfiguration(1_024_000, 1);
    excessive.trace.maximumPoints = 2_049;
    expect(() => validateSrdConfiguration(excessive)).toThrow(/trace bounds/);
  });
});
