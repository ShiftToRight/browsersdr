import type { SurveyDetectorMode } from "./fieldSurvey";
import type {
  ScanWindowPlan,
  ScanWindowResult,
  SpectrumMeasurement,
} from "./spectrumScan";

export const MONITOR_PRESETS = {
  general: {
    label: "General spectrum",
    description:
      "Conservative grouping for any supported frequency range. Narrow responses remain detectable.",
    dwellMs: 350,
    thresholdDb: 10,
    detector: "average",
    smoothBins: 1,
    gapBins: 2,
    gapDepthDb: 3,
    confirmation: 2,
  },
  narrow: {
    label: "Narrow signals",
    description:
      "Preserve closely spaced carriers and small bandwidths; no spectral gap bridging.",
    dwellMs: 500,
    thresholdDb: 10,
    detector: "average",
    smoothBins: 1,
    gapBins: 0,
    gapDepthDb: 0,
    confirmation: 3,
  },
  wide: {
    label: "Wide signals",
    description:
      "Smooth small notches in broad spectral regions without assuming a modulation or service.",
    dwellMs: 500,
    thresholdDb: 10,
    detector: "average",
    smoothBins: 5,
    gapBins: 3,
    gapDepthDb: 5,
    confirmation: 2,
  },
  bursts: {
    label: "Short bursts",
    description:
      "Max hold within each visit; a single observed burst is shown. Bursts between visits can still be missed.",
    dwellMs: 1000,
    thresholdDb: 12,
    detector: "max-hold",
    smoothBins: 1,
    gapBins: 1,
    gapDepthDb: 3,
    confirmation: 1,
  },
  "fm-balanced": {
    label: "FM · balanced",
    description:
      "Optional broadcast-FM grouping. Frequency alone never identifies a station.",
    dwellMs: 350,
    thresholdDb: 12,
    detector: "average",
    smoothBins: 7,
    gapBins: 16,
    gapDepthDb: 12,
    confirmation: 3,
  },
  "fm-weak": {
    label: "FM · weak signals",
    description:
      "More sensitive FM inspection with a slower revisit and more tentative candidates.",
    dwellMs: 750,
    thresholdDb: 8,
    detector: "average",
    smoothBins: 7,
    gapBins: 16,
    gapDepthDb: 12,
    confirmation: 3,
  },
  "fm-strong": {
    label: "FM · strong signals",
    description:
      "A cleaner FM view; weak real activity can fall below this threshold.",
    dwellMs: 350,
    thresholdDb: 15,
    detector: "average",
    smoothBins: 7,
    gapBins: 16,
    gapDepthDb: 12,
    confirmation: 3,
  },
} as const;
export type MonitorPreset = keyof typeof MONITOR_PRESETS;
export interface MonitorAnalysis {
  version: 1;
  preset: MonitorPreset;
}
export function validateMonitorAnalysis(value: unknown): MonitorAnalysis {
  const v = value as MonitorAnalysis;
  if (!v || v.version !== 1 || !Object.hasOwn(MONITOR_PRESETS, v.preset))
    throw new Error("Unsupported monitoring detector configuration.");
  return { version: 1, preset: v.preset };
}
const quantile = (values: number[], fraction: number) => {
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) * fraction)] ?? -120;
};
/** Versioned monitoring detector. Legacy finite surveys retain their original statistic and plan. */
export function analyzeMonitorWindow(
  plan: ScanWindowPlan,
  measurement: SpectrumMeasurement,
  thresholdDb: number,
  detector: SurveyDetectorMode,
  analysis: MonitorAnalysis,
): ScanWindowResult {
  const preset = MONITOR_PRESETS[validateMonitorAnalysis(analysis).preset];
  const first = measurement.frames[0];
  if (!first)
    throw new Error("No spectrum frames arrived for this tuning window.");
  const n = first.bins.length,
    resolution = first.sampleRateHz / n;
  const sum = new Float64Array(n),
    maximum = new Float64Array(n).fill(-Infinity);
  let frames = 0;
  const frameFloors: number[] = [];
  for (const frame of measurement.frames) {
    if (
      frame.bins.length !== n ||
      frame.sampleRateHz !== first.sampleRateHz ||
      frame.centerFrequencyHz !== first.centerFrequencyHz
    )
      continue;
    const noise: number[] = [];
    for (let i = 0; i < n; i++) {
      const db = frame.bins[i]!;
      if (!Number.isFinite(db))
        throw new Error(
          "Non-finite spectrum levels cannot establish monitoring evidence.",
        );
      sum[i] = (sum[i] ?? 0) + 10 ** (db / 10);
      maximum[i] = Math.max(maximum[i]!, db);
      if (i >= n / 8 && i < (n * 7) / 8 && i % 4 === 0) noise.push(db);
    }
    frameFloors.push(quantile(noise, 0.3));
    frames++;
  }
  if (!frames)
    throw new Error("Spectrum frames changed shape during monitoring.");
  const average = Array.from(
    sum,
    (p) => 10 * Math.log10(Math.max(Number.MIN_VALUE, p / frames)),
  );
  const powers =
    detector === "max-hold" || detector === "occupancy"
      ? Array.from(maximum)
      : average;
  const globalFloor =
    detector === "max-hold" || detector === "occupancy"
      ? quantile(frameFloors, 0.5)
      : quantile(
          average.filter((_, i) => i >= n / 8 && i < (n * 7) / 8),
          0.3,
        );
  // Sparse local floor anchors, capped above a robust capture floor so a wide plateau
  // does not turn into its own background. Guarded FFT edges do not set this floor.
  const floors: number[] = [];
  for (let a = 0; a < n; a += 64) {
    const nearby: number[] = [];
    for (
      let i = Math.max(Math.floor(n / 8), a - 256);
      i < Math.min((n * 7) / 8, a + 256);
      i += 4
    )
      nearby.push(average[i]!);
    floors.push(Math.min(quantile(nearby, 0.3), globalFloor + 6));
  }
  const floor = (i: number) =>
    detector === "max-hold" || detector === "occupancy"
      ? globalFloor
      : (floors[Math.floor(i / 64)] ?? globalFloor);
  // Smoothing never expands reported support beyond bins actually above threshold.
  const radius = Math.floor(preset.smoothBins / 2);
  const smoothed = powers.map((_, i) => {
    let total = 0,
      count = 0;
    for (
      let j = Math.max(0, i - radius);
      j <= Math.min(n - 1, i + radius);
      j++
    ) {
      total += 10 ** (powers[j]! / 10);
      count++;
    }
    return 10 * Math.log10(Math.max(Number.MIN_VALUE, total / count));
  });
  const hz = (i: number) => first.centerFrequencyHz + (i - n / 2) * resolution;
  const lower = Math.max(
    0,
    Math.ceil(
      (plan.lowerFrequencyHz - first.centerFrequencyHz) / resolution + n / 2,
    ),
  );
  const upper = Math.min(
    n - 1,
    Math.floor(
      (plan.upperFrequencyHz - first.centerFrequencyHz) / resolution + n / 2,
    ),
  );
  const above = (i: number) => smoothed[i]! >= floor(i) + thresholdDb;
  const ranges: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = lower; i <= upper + 1; i++) {
    if (i <= upper && above(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push({ start, end: i - 1 });
      start = -1;
    }
  }
  const maxGap = analysis.preset.startsWith("fm-")
    ? Math.min(preset.gapBins, Math.floor(10000 / resolution))
    : preset.gapBins;
  const joined: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const prior = joined.at(-1);
    const gap = prior ? range.start - prior.end - 1 : Infinity;
    let shallow = !!prior && gap <= maxGap;
    if (shallow)
      for (let i = prior!.end + 1; i < range.start; i++)
        if (smoothed[i]! < floor(i) + thresholdDb - preset.gapDepthDb)
          shallow = false;
    if (prior && shallow) prior.end = range.end;
    else joined.push({ ...range });
  }
  const candidates: ScanWindowResult["candidates"] = [];
  for (const group of joined) {
    // Find genuine support after smoothing, including true one-bin carriers.
    let a = group.start,
      b = group.end;
    while (a <= b && powers[a]! < floor(a) + thresholdDb) a++;
    while (b >= a && powers[b]! < floor(b) + thresholdDb) b--;
    if (a > b) continue;
    let peak = a;
    for (let i = a + 1; i <= b; i++) if (powers[i]! > powers[peak]!) peak = i;
    const lowerFrequencyHz = Math.max(
      plan.lowerFrequencyHz,
      hz(a) - resolution / 2,
    );
    const upperFrequencyHz = Math.min(
      plan.upperFrequencyHz,
      hz(b) + resolution / 2,
    );
    const center = (lowerFrequencyHz + upperFrequencyHz) / 2;
    let seen = 0;
    for (const frame of measurement.frames) {
      if (
        frame.bins.length !== n ||
        frame.sampleRateHz !== first.sampleRateHz ||
        frame.centerFrequencyHz !== first.centerFrequencyHz
      )
        continue;
      // Per-frame presence over real supported bins, independent of the max-hold trace.
      let present = false;
      for (let i = a; i <= b; i++)
        if (frame.bins[i]! >= floor(i) + thresholdDb) {
          present = true;
          break;
        }
      if (present) seen++;
    }
    candidates.push({
      frequencyHz: center,
      peakFrequencyHz: hz(peak),
      lowerFrequencyHz,
      upperFrequencyHz,
      bandwidthHz: upperFrequencyHz - lowerFrequencyHz,
      peakDb: powers[peak]!,
      noiseFloorDb: floor(peak),
      detector,
      occupancy: Math.min(1, seen / frames),
      lowerEdgeClipped: a === lower,
      upperEdgeClipped: b === upper,
    });
  }
  return {
    plan,
    points: Array.from({ length: Math.max(0, upper - lower + 1) }, (_, j) => ({
      frequencyHz: hz(lower + j),
      powerDb: powers[lower + j]!,
    })),
    candidates: measurement.status === "complete" ? candidates : [],
    noiseFloorDb: globalFloor,
    frameCount: frames,
    coverage: measurement.coverage,
    missingSamples: measurement.missingSamples,
    status: measurement.status,
  };
}
