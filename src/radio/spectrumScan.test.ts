import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpectrumFrame } from "./types";
import {
  analyzeScanWindow,
  canStartSpectrumScan,
  compressSpectrumPoints,
  collectSpectrumMeasurement,
  mergeSignalCandidates,
  planSpectrumScan,
} from "./spectrumScan";

class MeasurementSource {
  readonly listeners = new Set<(value: SpectrumFrame) => void>();
  subscribeMeasurements(listener: (value: SpectrumFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: SpectrumFrame): void { for (const listener of this.listeners) listener(value); }
}

afterEach(() => vi.useRealTimers());

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
  it("includes the full first wideband averaging interval in dwell", async () => {
    const source = new MeasurementSource();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 4_800_000, dwellMs: 80, signal: new AbortController().signal,
    });
    for (let sequence = 0; sequence < 2; sequence++) source.emit({ ...frame(10_000_000, 3),
      sampleRateHz: 4_800_000, hopSamples: 192_512, sampleIndex: (sequence + 1) * 192_512, sequence });
    expect(await pending).toMatchObject({ sourceSamples: 385_024, coverage: 1, status: "complete" });
  });
  it("completes dwell from source samples while ignoring stale frames", async () => {
    const source = new MeasurementSource();
    const abort = new AbortController();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 200, signal: abort.signal,
    });
    source.emit({ ...frame(10_000_000, 3), sessionGeneration: 2, sampleRateHz: 163_840, sampleIndex: 16_384 });
    source.emit({ ...frame(10_000_000, 3), sampleRateHz: 163_840, sampleIndex: 16_384 });
    source.emit({ ...frame(10_000_000, 3), sampleRateHz: 163_840, sampleIndex: 32_768, sequence: 2 });
    const measurement = await pending;
    expect(measurement).toMatchObject({ targetSamples: 32_768, sourceSamples: 32_768, coverage: 1, status: "complete" });
    expect(measurement.frames).toHaveLength(2);
    expect(source.listeners).toHaveLength(0);
  });

  it("marks known missing input as insufficient and suppresses candidates", async () => {
    const source = new MeasurementSource();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 200, signal: new AbortController().signal,
    });
    source.emit({ ...frame(10_000_000, 10), sampleRateHz: 163_840, sampleIndex: 16_384 });
    source.emit({ ...frame(10_000_000, 10), sampleRateHz: 163_840, sampleIndex: 37_768, missingSamplesBefore: 5_000, sequence: 2 });
    const measurement = await pending;
    expect(measurement.status).toBe("insufficient");
    expect(measurement.coverage).toBeLessThan(0.9);
    const plan = planSpectrumScan(9_999_400, 10_000_600, 163_840)[0]!;
    expect(analyzeScanWindow(plan, measurement.frames, 10, "average", measurement)).toMatchObject({ status: "insufficient", candidates: [] });
  });

  it("fails on no data and removes its subscription", async () => {
    vi.useFakeTimers();
    const source = new MeasurementSource();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 200,
      signal: new AbortController().signal, noDataTimeoutMs: 50,
    });
    const rejection = expect(pending).rejects.toThrow(/input stopped/);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(source.listeners).toHaveLength(0);
  });

  it("cancels before input and during collection without leaving listeners or timers", async () => {
    const source = new MeasurementSource();
    const before = new AbortController();
    before.abort();
    await expect(collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 200, signal: before.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 200, signal: during.signal,
    });
    source.emit({ ...frame(10_000_000, 3), sampleRateHz: 163_840, sampleIndex: 16_384 });
    during.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.listeners).toHaveLength(0);
  });

  it("enforces the retained measurement-frame bound", async () => {
    const source = new MeasurementSource();
    const pending = collectSpectrumMeasurement(source, {
      generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 1_000_000, dwellMs: 60_000,
      signal: new AbortController().signal,
    });
    const rejection = expect(pending).rejects.toThrow(/bounded measurement buffer/);
    for (let sequence = 0; sequence <= 256; sequence += 1) {
      source.emit({ ...frame(10_000_000, 3), sampleRateHz: 1_000_000, sampleIndex: (sequence + 1) * 16_384, sequence });
    }
    await rejection;
    expect(source.listeners).toHaveLength(0);
  });

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

it("plans integer Pro scan centers above 2^32 and rejects out-of-range capture windows", () => {
  const windows = planSpectrumScan(4_300_000_001, 4_302_000_002, 1_024_000, "hackrf");
  expect(windows.every(window => Number.isSafeInteger(window.centerFrequencyHz) && window.centerFrequencyHz > 2 ** 32)).toBe(true);
  expect(() => planSpectrumScan(100_000, 200_000, 1_024_000, "hackrf")).toThrow(/passband/);
  expect(() => planSpectrumScan(5_999_900_000, 6_000_000_000, 1_024_000, "hackrf")).toThrow(/passband/);
  expect(() => planSpectrumScan(6_000_000_000, 6_000_100_000, 1_024_000, "hackrf")).toThrow(/passband/);
});


it("ignores a near old-frequency frame even within the former 2-percent tolerance", async () => {
  const source = new MeasurementSource();
  const pending = collectSpectrumMeasurement(source, { generation: 3, centerFrequencyHz: 10_000_000, sampleRateHz: 163_840, dwellMs: 100, signal: new AbortController().signal });
  const resolved = vi.fn(); void pending.then(resolved);
  source.emit({ ...frame(10_000_001, 8), sampleRateHz: 163_840, sampleIndex: 100_000 });
  await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
  source.emit({ ...frame(10_000_000, 8), sessionGeneration: 2, sampleRateHz: 163_840, sampleIndex: 100_000 });
  await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
  source.emit({ ...frame(10_000_000, 8), sampleRateHz: 163_840, sampleIndex: 16_384 });
  expect((await pending).frames).toHaveLength(1);
});
