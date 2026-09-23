import { describe, expect, it } from "vitest";
import type { SpectrumFrame } from "./types";
import {
  analyzeScanWindow,
  canStartSpectrumScan,
  compressSpectrumPoints,
  mergeSignalCandidates,
  planSpectrumScan,
} from "./spectrumScan";

function frame(centerFrequencyHz: number, peakBin: number): SpectrumFrame {
  const bins = new Float32Array(16).fill(-90);
  bins[peakBin] = -52;
  bins[peakBin + 1] = -58;
  return {
    sessionGeneration: 3,
    sequence: 1,
    timestampMs: 0,
    sampleIndex: 65_536,
    centerFrequencyHz,
    sampleRateHz: 1_600,
    units: "relative-dB",
    bins,
    droppedFramesBefore: 0,
  };
}

describe("bounded spectrum scan", () => {
  it("allows a sweep from connected standby as well as active reception", () => {
    expect(canStartSpectrumScan("connected", "rtl-sdr", false)).toBe(true);
    expect(canStartSpectrumScan("running", "rtl-sdr", false)).toBe(true);
    expect(canStartSpectrumScan("connected", "rtl-sdr", true)).toBe(false);
    expect(canStartSpectrumScan("connected", "replay", false)).toBe(false);
    expect(canStartSpectrumScan("idle", undefined, false)).toBe(false);
  });

  it("covers a requested range with guarded, contiguous tuner windows", () => {
    const plan = planSpectrumScan(88_000_000, 108_000_000, 1_024_000);
    expect(plan).toHaveLength(27);
    expect(plan[0]?.lowerFrequencyHz).toBe(88_000_000);
    expect(plan.at(-1)?.upperFrequencyHz).toBe(108_000_000);
    for (let index = 1; index < plan.length; index += 1) {
      expect(plan[index]?.lowerFrequencyHz).toBe(plan[index - 1]?.upperFrequencyHz);
    }
  });

  it("detects a signal above the local median noise floor", () => {
    const plan = planSpectrumScan(9_999_400, 10_000_600, 1_600)[0]!;
    const result = analyzeScanWindow(plan, [frame(10_000_000, 10), frame(10_000_000, 10)], 10);
    expect(result.noiseFloorDb).toBe(-90);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ frequencyHz: 10_000_200, peakDb: -52, bandwidthHz: 200 });
  });

  it("uses max-hold and occupancy detectors for intermittent signals", () => {
    const plan = planSpectrumScan(9_999_400, 10_000_600, 1_600)[0]!;
    const quiet = frame(10_000_000, 3);
    quiet.bins.fill(-90);
    const burst = frame(10_000_000, 10);
    expect(analyzeScanWindow(plan, [quiet, quiet, burst], 15, "average").candidates).toHaveLength(0);
    const maxHold = analyzeScanWindow(plan, [quiet, quiet, burst], 15, "max-hold").candidates;
    expect(maxHold[0]).toMatchObject({ detector: "max-hold", frequencyHz: 10_000_200 });
    const occupancy = analyzeScanWindow(plan, [quiet, quiet, burst], 15, "occupancy").candidates;
    expect(occupancy[0]?.occupancy).toBeCloseTo(1 / 3);
  });

  it("merges overlapping candidates and preserves narrow peaks when compressing", () => {
    const merged = mergeSignalCandidates([
      { frequencyHz: 1000, peakDb: -60, noiseFloorDb: -90, bandwidthHz: 100 },
      { frequencyHz: 1040, peakDb: -50, noiseFloorDb: -88, bandwidthHz: 100 },
      { frequencyHz: 2000, peakDb: -55, noiseFloorDb: -91, bandwidthHz: 50 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.frequencyHz).toBe(1040);
    const points = Array.from({ length: 100 }, (_, index) => ({ frequencyHz: index, powerDb: index === 55 ? -20 : -100 }));
    expect(compressSpectrumPoints(points, 10).some((point) => point.frequencyHz === 55)).toBe(true);
  });

  it("rejects invalid and unbounded scan requests", () => {
    expect(() => planSpectrumScan(100, 100, 1000)).toThrow(/above the start/);
    expect(() => planSpectrumScan(1, 1_000_000, 1000)).toThrow(/narrow it/);
  });
});
