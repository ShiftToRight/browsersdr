import { describe, expect, it } from "vitest";
import {
  SignalIntelligenceProbe,
  type SignalProbeConfiguration,
} from "./signalIntelligence";
import { createRdsMultiplexFixture } from "../testing/rdsFixture";

const config: SignalProbeConfiguration = {
  sampleRateHz: 1_024_000,
  centerFrequencyHz: 99_815_680,
  frequencyHz: 100e6,
  bandwidthHz: 180_000,
  seconds: 6,
};
function feed(
  probe: SignalIntelligenceProbe,
  mpx: Float32Array | undefined,
  seconds: number,
  options: { noise?: boolean; gapAt?: number; pilotOnly?: boolean } = {},
) {
  const rate = probe.config.sampleRateHz;
  let phase = 0,
    random = 12345;
  const randomValue = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 0x80000000 - 1;
  };
  for (let start = 0; start < rate * seconds; start += 8192) {
    const count = Math.min(8192, Math.round(rate * seconds) - start);
    const I = new Float32Array(count),
      Q = new Float32Array(count);
    for (let n = 0; n < count; n++) {
      const t = (start + n) / rate;
      const value = mpx
        ? mpx[Math.floor(((start + n) * 336_000) / rate) % mpx.length]!
        : options.pilotOnly
          ? 0.2 * Math.cos(2 * Math.PI * 19000 * t) +
            0.5 * Math.sin(2 * Math.PI * 1000 * t)
          : 0;
      phase +=
        (2 *
          Math.PI *
          (probe.config.frequencyHz -
            probe.config.centerFrequencyHz +
            75_000 * value)) /
        rate;
      I[n] = options.noise ? randomValue() * 0.2 : Math.cos(phase) * 0.7;
      Q[n] = options.noise ? randomValue() * 0.2 : Math.sin(phase) * 0.7;
    }
    const copy = I.slice();
    const done = probe.accept(
      I,
      Q,
      start,
      options.gapAt !== undefined &&
        start >= options.gapAt &&
        start - 8192 < options.gapAt,
    );
    // Check every sample without the assertion library building millions of deep-comparison nodes.
    expect(I.every((value, n) => value === copy[n])).toBe(true);
    if (done) break;
  }
  return probe.result();
}

describe("signal-derived intelligence", () => {
  it("recovers checked repeated RDS names from raw RF, independent of the carrier band", () => {
    const mpx = createRdsMultiplexFixture({
      sampleRate: 336_000,
      programmeService: "TEST FM",
      radioText: "Probe test",
      pilotAmplitude: 0.08,
    });
    for (const shift of [0, 333e6]) {
      const probe = new SignalIntelligenceProbe({
        ...config,
        frequencyHz: config.frequencyHz + shift,
        centerFrequencyHz: config.centerFrequencyHz + shift,
      });
      const result = feed(probe, mpx, 6);
      expect(result).toMatchObject({
        status: "complete",
        stableProgrammeService: "TEST FM",
        suggestedMode: "WBFM",
        pilotObserved: true,
      });
      expect(result.rds.validGroups).toBeGreaterThanOrEqual(8);
      expect(result.resolutionHz).toBe(62.5);
      expect(result.sampledSeconds).toBeLessThanOrEqual(6);
      expect(result.lastSampleIndex! - result.firstSampleIndex! + 1).toBe(
        Math.round(result.sampledSeconds * config.sampleRateHz),
      );
      expect(result.measuredCenterHz).toBeCloseTo(probe.config.frequencyHz, -4);
    }
  }, 30_000);
  it("can suggest WBFM from a stable multiplex pilot without inventing an RDS name", () => {
    const result = feed(
      new SignalIntelligenceProbe({ ...config, seconds: 2 }),
      undefined,
      2,
      { pilotOnly: true },
    );
    expect(result).toMatchObject({
      pilotObserved: true,
      suggestedMode: "WBFM",
      stableProgrammeService: null,
      rds: { validGroups: 0, pi: null },
    });
  });
  it("keeps noise and unmodulated carriers unknown even inside the broadcast band", () => {
    for (const noise of [true, false]) {
      const result = feed(
        new SignalIntelligenceProbe({ ...config, seconds: 1 }),
        undefined,
        1,
        { noise },
      );
      expect(result.suggestedMode).toBeUndefined();
      expect(result.stableProgrammeService).toBeNull();
      expect(result.pilotObserved).toBe(false);
    }
  });
  it("resets pilot and decoded evidence across input gaps", () => {
    const probe = new SignalIntelligenceProbe(config);
    feed(probe, undefined, 1.5, { pilotOnly: true });
    expect(probe.result().pilotObserved).toBe(true);
    probe.accept(
      new Float32Array(8192),
      new Float32Array(8192),
      2 * config.sampleRateHz,
      true,
    );
    expect(probe.result()).toMatchObject({
      pilotObserved: false,
      stableProgrammeService: null,
      discontinuities: 1,
    });
  });
  it("rejects clipped/invalid requests and does not promote narrow signals to FM", () => {
    expect(
      () => new SignalIntelligenceProbe({ ...config, seconds: Infinity }),
    ).toThrow();
    expect(
      () =>
        new SignalIntelligenceProbe({
          ...config,
          frequencyHz: config.centerFrequencyHz + config.sampleRateHz / 2,
        }),
    ).toThrow();
    const result = feed(
      new SignalIntelligenceProbe({ ...config, bandwidthHz: 2000, seconds: 1 }),
      undefined,
      1,
    );
    expect(result.suggestedMode).toBeUndefined();
    expect(result.resolutionHz).toBe(62.5);
    expect(result.reasons.join(" ")).toContain("width does not fit");
  });
});
