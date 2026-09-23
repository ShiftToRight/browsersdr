import type { ReceiverLifecycle, SourceKind, SpectrumFrame } from "./types";
import type { SurveyDetectorMode } from "./fieldSurvey";

export const SCAN_USABLE_FRACTION = 0.75;
export const MAX_SCAN_WINDOWS = 256;
export const MAX_EXPLORER_POINTS = 1_600;

export interface ScanWindowPlan {
  index: number;
  centerFrequencyHz: number;
  lowerFrequencyHz: number;
  upperFrequencyHz: number;
}

export interface SpectrumPoint {
  frequencyHz: number;
  powerDb: number;
}

export interface SignalCandidate {
  frequencyHz: number;
  peakDb: number;
  noiseFloorDb: number;
  bandwidthHz: number;
  detector?: SurveyDetectorMode;
  /** Fraction of collected spectrum frames in which the candidate exceeded the threshold. */
  occupancy?: number;
}

export interface ScanWindowResult {
  plan: ScanWindowPlan;
  points: SpectrumPoint[];
  candidates: SignalCandidate[];
  noiseFloorDb: number;
  frameCount: number;
}

export function canStartSpectrumScan(
  lifecycle: ReceiverLifecycle,
  source: SourceKind | undefined,
  recordingBlocked: boolean,
): boolean {
  return (lifecycle === "connected" || lifecycle === "running")
    && source !== undefined
    && source !== "replay"
    && !recordingBlocked;
}

export function planSpectrumScan(
  lowerFrequencyHz: number,
  upperFrequencyHz: number,
  sampleRateHz: number,
): ScanWindowPlan[] {
  if (!Number.isFinite(lowerFrequencyHz) || lowerFrequencyHz <= 0) throw new Error("Scan start must be above 0 Hz.");
  if (!Number.isFinite(upperFrequencyHz) || upperFrequencyHz <= lowerFrequencyHz) throw new Error("Scan end must be above the start frequency.");
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error("A positive receiver sample rate is required.");
  const rangeHz = upperFrequencyHz - lowerFrequencyHz;
  const usableWindowHz = sampleRateHz * SCAN_USABLE_FRACTION;
  const count = Math.max(1, Math.ceil(rangeHz / usableWindowHz));
  if (count > MAX_SCAN_WINDOWS) {
    throw new Error(`That range needs ${count} tuning windows; narrow it to ${MAX_SCAN_WINDOWS} windows or fewer.`);
  }
  const coveredPerWindowHz = rangeHz / count;
  return Array.from({ length: count }, (_, index) => {
    const lower = lowerFrequencyHz + index * coveredPerWindowHz;
    const upper = index === count - 1 ? upperFrequencyHz : lowerFrequencyHz + (index + 1) * coveredPerWindowHz;
    return {
      index,
      centerFrequencyHz: (lower + upper) / 2,
      lowerFrequencyHz: lower,
      upperFrequencyHz: upper,
    };
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? -120) + (sorted[middle] ?? -120)) / 2
    : sorted[middle] ?? -120;
}

export function analyzeScanWindow(
  plan: ScanWindowPlan,
  frames: readonly SpectrumFrame[],
  thresholdAboveNoiseDb: number,
  detector: SurveyDetectorMode = "average",
): ScanWindowResult {
  if (frames.length === 0) throw new Error("No spectrum frames arrived for this tuning window.");
  const first = frames[0]!;
  const binCount = first.bins.length;
  const powerSum = new Float64Array(binCount);
  const powerMaximum = new Float64Array(binCount).fill(Number.NEGATIVE_INFINITY);
  const occupancyCount = new Uint32Array(binCount);
  const frameFloors: number[] = [];
  let acceptedFrames = 0;
  for (const frame of frames) {
    if (frame.bins.length !== binCount || frame.sampleRateHz !== first.sampleRateHz) continue;
    const frameFloor = median(Array.from(frame.bins));
    frameFloors.push(frameFloor);
    for (let index = 0; index < binCount; index += 1) {
      const power = frame.bins[index] ?? -120;
      powerSum[index] = (powerSum[index] ?? 0) + power;
      powerMaximum[index] = Math.max(powerMaximum[index] ?? -120, power);
      if (power >= frameFloor + Math.max(1, thresholdAboveNoiseDb)) occupancyCount[index] = (occupancyCount[index] ?? 0) + 1;
    }
    acceptedFrames += 1;
  }
  if (acceptedFrames === 0) throw new Error("Spectrum frames changed shape during the scan.");

  const points: SpectrumPoint[] = [];
  const resolutionHz = first.sampleRateHz / binCount;
  for (let index = 0; index < binCount; index += 1) {
    const frequencyHz = first.centerFrequencyHz + (index - binCount / 2) * resolutionHz;
    if (frequencyHz < plan.lowerFrequencyHz || frequencyHz > plan.upperFrequencyHz) continue;
    const averagePower = (powerSum[index] ?? 0) / acceptedFrames;
    const powerDb = detector === "max-hold" || detector === "occupancy"
      ? powerMaximum[index] ?? averagePower
      : averagePower;
    points.push({ frequencyHz, powerDb });
  }
  const guardPowers: number[] = [];
  if (detector === "wideband") {
    for (let index = 0; index < binCount; index += 1) {
      const frequencyHz = first.centerFrequencyHz + (index - binCount / 2) * resolutionHz;
      if (frequencyHz < plan.lowerFrequencyHz || frequencyHz > plan.upperFrequencyHz) guardPowers.push((powerSum[index] ?? 0) / acceptedFrames);
    }
  }
  const noiseFloorDb = detector === "max-hold" || detector === "occupancy"
    ? median(frameFloors)
    : detector === "wideband" && guardPowers.length > 0
      ? median(guardPowers)
      : median(points.map((point) => point.powerDb));
  const thresholdDb = noiseFloorDb + Math.max(1, thresholdAboveNoiseDb);
  const candidates: SignalCandidate[] = [];
  let groupStart = -1;
  for (let index = 0; index <= points.length; index += 1) {
    const point = points[index];
    const sourceIndex = point ? Math.round((point.frequencyHz - first.centerFrequencyHz) / resolutionHz + binCount / 2) : -1;
    const occupancy = sourceIndex >= 0 ? (occupancyCount[sourceIndex] ?? 0) / acceptedFrames : 0;
    const above = index < points.length
      && (point?.powerDb ?? -120) >= thresholdDb
      && (detector !== "occupancy" || occupancy > 0);
    if (above && groupStart < 0) groupStart = index;
    if ((!above || index === points.length) && groupStart >= 0) {
      const groupEnd = index - 1;
      let peak = points[groupStart]!;
      for (let cursor = groupStart + 1; cursor <= groupEnd; cursor += 1) {
        if ((points[cursor]?.powerDb ?? -120) > peak.powerDb) peak = points[cursor]!;
      }
      candidates.push({
        frequencyHz: peak.frequencyHz,
        peakDb: peak.powerDb,
        noiseFloorDb,
        bandwidthHz: Math.max(resolutionHz, (groupEnd - groupStart + 1) * resolutionHz),
        detector,
        occupancy: Math.max(...Array.from({ length: groupEnd - groupStart + 1 }, (_, offset) => {
          const groupPoint = points[groupStart + offset]!;
          const bin = Math.round((groupPoint.frequencyHz - first.centerFrequencyHz) / resolutionHz + binCount / 2);
          return (occupancyCount[bin] ?? 0) / acceptedFrames;
        })),
      });
      groupStart = -1;
    }
  }
  if (detector === "wideband" && candidates.length === 0 && median(points.map((point) => point.powerDb)) >= thresholdDb) {
    const peak = points.reduce((strongest, point) => point.powerDb > strongest.powerDb ? point : strongest, points[0]!);
    candidates.push({
      frequencyHz: (plan.lowerFrequencyHz + plan.upperFrequencyHz) / 2,
      peakDb: peak.powerDb,
      noiseFloorDb,
      bandwidthHz: plan.upperFrequencyHz - plan.lowerFrequencyHz,
      detector,
      occupancy: 1,
    });
  }
  return { plan, points, candidates, noiseFloorDb, frameCount: acceptedFrames };
}

export function mergeSignalCandidates(candidates: readonly SignalCandidate[]): SignalCandidate[] {
  const sorted = [...candidates].sort((left, right) => left.frequencyHz - right.frequencyHz);
  const merged: SignalCandidate[] = [];
  for (const candidate of sorted) {
    const previous = merged.at(-1);
    const previousLower = previous ? previous.frequencyHz - previous.bandwidthHz / 2 : 0;
    const previousUpper = previous ? previous.frequencyHz + previous.bandwidthHz / 2 : 0;
    const candidateLower = candidate.frequencyHz - candidate.bandwidthHz / 2;
    const candidateUpper = candidate.frequencyHz + candidate.bandwidthHz / 2;
    if (previous && candidateLower <= previousUpper) {
      const stronger = candidate.peakDb > previous.peakDb ? candidate : previous;
      previous.frequencyHz = stronger.frequencyHz;
      previous.peakDb = Math.max(previous.peakDb, candidate.peakDb);
      previous.noiseFloorDb = Math.min(previous.noiseFloorDb, candidate.noiseFloorDb);
      previous.bandwidthHz = Math.max(previousUpper, candidateUpper) - Math.min(previousLower, candidateLower);
      previous.occupancy = Math.max(previous.occupancy ?? 0, candidate.occupancy ?? 0);
      previous.detector = stronger.detector ?? previous.detector;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.sort((left, right) => right.peakDb - left.peakDb);
}

export function compressSpectrumPoints(points: readonly SpectrumPoint[], limit = MAX_EXPLORER_POINTS): SpectrumPoint[] {
  if (points.length <= limit) return [...points];
  const result: SpectrumPoint[] = [];
  const bucketSize = points.length / limit;
  for (let bucket = 0; bucket < limit; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
    let peak = points[start]!;
    for (let index = start + 1; index < Math.min(points.length, end); index += 1) {
      if ((points[index]?.powerDb ?? -120) > peak.powerDb) peak = points[index]!;
    }
    result.push(peak);
  }
  return result;
}
