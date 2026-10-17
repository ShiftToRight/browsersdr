import type { SignalCandidate, SpectrumMeasurement } from "./spectrumScan";

export const MAX_GROUP_COMPONENTS = 16;
export const CENTER_EVIDENCE_LIMIT = 9;
export interface SpectralComponent {
  lowerHz: number;
  upperHz: number;
  peakHz: number;
  peakDb: number;
}
export interface AdaptiveGroup {
  binSpacingHz: number;
  componentCount: number;
  components: SpectralComponent[];
  reason: "contiguous-support" | "supported-notch";
  associationUncertain?: boolean;
}
export interface CenterEvidence {
  at: string;
  lowerHz: number;
  upperHz: number;
  binSpacingHz: number;
}
export const median = (values: readonly number[]): number => {
  const a = [...values].sort((a, b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length ? (a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2) : 0;
};
export function stableCenter(evidence: readonly CenterEvidence[]) {
  const centers = evidence.map((e) => (e.lowerHz + e.upperHz) / 2);
  return {
    centerHz: median(centers),
    spreadHz: centers.length ? Math.max(...centers) - Math.min(...centers) : 0,
    widthHz: median(evidence.map((e) => e.upperHz - e.lowerHz)),
  };
}

/** Same-visit envelopes only: original support, bounded gaps, and frame co-presence. */
export function adaptiveCandidates(options: {
  powers: number[];
  floor: (i: number) => number;
  frames: SpectrumMeasurement["frames"];
  lower: number;
  upper: number;
  hz: (i: number) => number;
  resolution: number;
  thresholdDb: number;
  narrow: boolean;
  detector: SignalCandidate["detector"];
  planLower: number;
  planUpper: number;
}): SignalCandidate[] {
  const {
    powers,
    floor,
    frames,
    lower,
    upper,
    hz,
    resolution,
    thresholdDb,
    narrow,
  } = options;
  type Part = { a: number; b: number; peak: number; seen: Set<number> };
  const parts: Part[] = [];
  const support = thresholdDb - (narrow ? 0 : 3);
  let a = -1;
  for (let i = lower; i <= upper + 1; i++) {
    if (i <= upper && powers[i]! >= floor(i) + support) {
      if (a < 0) a = i;
    } else if (a >= 0) {
      const b = i - 1;
      let peak = a;
      for (let j = a + 1; j <= b; j++) if (powers[j]! > powers[peak]!) peak = j;
      if (powers[peak]! >= floor(peak) + thresholdDb) {
        const seen = new Set<number>();
        frames.forEach((f, k) => {
          for (let j = a; j <= b; j++)
            if (f.bins[j]! >= floor(j) + thresholdDb) {
              seen.add(k);
              break;
            }
        });
        parts.push({ a, b, peak, seen });
      }
      a = -1;
    }
  }
  type Envelope = {
    parts: Part[];
    a: number;
    b: number;
    maxWidth: number;
    supportBins: number;
    seen: Set<number>;
    coSeen: Set<number>;
  };
  const envelopes: Envelope[] = [];
  for (const part of parts) {
    const prior = envelopes.at(-1);
    const width = part.b - part.a + 1;
    const gap = prior ? part.a - prior.b - 1 : Infinity;
    // A narrow resolved component is never absorbed merely because a wide neighbor exists.
    const gapLimit = prior
      ? Math.max(2, Math.floor(0.15 * Math.min(prior.maxWidth, width)))
      : 0;
    let join =
      !narrow && !!prior && width > 4 && prior.maxWidth > 4 && gap <= gapLimit;
    if (join && prior) {
      const span = part.b - prior.a + 1;
      join =
        span <= 3 * Math.max(prior.maxWidth, width) &&
        span - prior.supportBins - width <= 0.2 * (prior.supportBins + width);
      for (let j = prior.b + 1; join && j < part.a; j++)
        if (powers[j]! < floor(j) + thresholdDb - 8) join = false;
      const common = [...part.seen].filter((k) => prior.coSeen.has(k)).length;
      join =
        join &&
        common > 0 &&
        common / Math.max(1, Math.min(prior.coSeen.size, part.seen.size)) >=
          0.6;
    }
    if (join && prior) {
      prior.coSeen = new Set([...prior.coSeen].filter((k) => part.seen.has(k)));
      prior.parts.push(part);
      prior.b = part.b;
      prior.maxWidth = Math.max(prior.maxWidth, width);
      prior.supportBins += width;
      for (const k of part.seen) prior.seen.add(k);
    } else
      envelopes.push({
        parts: [part],
        a: part.a,
        b: part.b,
        maxWidth: width,
        supportBins: width,
        seen: new Set(part.seen),
        coSeen: new Set(part.seen),
      });
  }
  return envelopes.map((e) => {
    const peak = e.parts.reduce(
      (best, p) => (powers[p.peak]! > powers[best]! ? p.peak : best),
      e.parts[0]!.peak,
    );
    const lowerHz = Math.max(options.planLower, hz(e.a) - resolution / 2);
    const upperHz = Math.min(options.planUpper, hz(e.b) + resolution / 2);
    return {
      frequencyHz: (lowerHz + upperHz) / 2,
      bandwidthHz: upperHz - lowerHz,
      lowerFrequencyHz: lowerHz,
      upperFrequencyHz: upperHz,
      peakFrequencyHz: hz(peak),
      peakDb: powers[peak]!,
      noiseFloorDb: floor(peak),
      detector: options.detector,
      occupancy: e.seen.size / Math.max(1, frames.length),
      lowerEdgeClipped: e.a === lower,
      upperEdgeClipped: e.b === upper,
      group: {
        binSpacingHz: resolution,
        componentCount: e.parts.length,
        reason: e.parts.length > 1 ? "supported-notch" : "contiguous-support",
        components: e.parts.slice(0, MAX_GROUP_COMPONENTS).map((p) => ({
          lowerHz: Math.max(options.planLower, hz(p.a) - resolution / 2),
          upperHz: Math.min(options.planUpper, hz(p.b) + resolution / 2),
          peakHz: hz(p.peak),
          peakDb: powers[p.peak]!,
        })),
      },
    };
  });
}

interface TrackRegion {
  id: string;
  frequencyHz: number;
  bandwidthHz: number;
  lowerFrequencyHz?: number;
  upperFrequencyHz?: number;
  lowerEdgeClipped?: boolean;
  upperEdgeClipped?: boolean;
  centerEvidence?: CenterEvidence[];
}
/** Visit-wide deterministic assignment: ranked edges rather than candidate iteration order. */
export function associateAdaptive(
  tracks: TrackRegion[],
  candidates: SignalCandidate[],
  resolution: number,
) {
  const pairs: {
    track: TrackRegion;
    candidate: SignalCandidate;
    score: number;
  }[] = [];
  for (const t of tracks)
    for (const c of candidates) {
      if (t.lowerFrequencyHz === undefined || t.upperFrequencyHz === undefined)
        continue;
      const cl = c.lowerFrequencyHz!,
        cu = c.upperFrequencyHz!;
      const overlap =
        Math.min(t.upperFrequencyHz, cu) - Math.max(t.lowerFrequencyHz, cl);
      const stable = t.centerEvidence?.length
        ? stableCenter(t.centerEvidence)
        : undefined;
      const width = stable?.widthHz || t.bandwidthHz;
      const distance = Math.abs(
        (t.lowerFrequencyHz + t.upperFrequencyHz) / 2 - c.frequencyHz,
      );
      const gate = Math.max(2 * resolution, width * 0.2);
      const touching =
        (t.upperEdgeClipped &&
          c.lowerEdgeClipped &&
          Math.abs(t.upperFrequencyHz - cl) <= resolution) ||
        (t.lowerEdgeClipped &&
          c.upperEdgeClipped &&
          Math.abs(t.lowerFrequencyHz - cu) <= resolution);
      const clipped =
        c.lowerEdgeClipped ||
        c.upperEdgeClipped ||
        t.lowerEdgeClipped ||
        t.upperEdgeClipped;
      const widthRatio =
        Math.max(width, c.bandwidthHz) / Math.min(width, c.bandwidthHz);
      const narrowPair =
        Math.max(width, c.bandwidthHz) <= 4 * resolution &&
        distance <= 2 * resolution;
      if (
        !touching &&
        !narrowPair &&
        !(
          widthRatio <= 3 &&
          overlap >= 0.5 * Math.min(t.bandwidthHz, c.bandwidthHz) &&
          (distance <= gate ||
            (clipped && distance <= Math.max(width, c.bandwidthHz) * 0.6))
        )
      )
        continue;
      pairs.push({
        track: t,
        candidate: c,
        score: touching
          ? 0.5
          : distance / Math.max(resolution, width) +
            1 -
            Math.max(0, overlap) / Math.max(t.bandwidthHz, c.bandwidthHz),
      });
    }
  pairs.sort(
    (a, b) =>
      a.score - b.score ||
      a.candidate.frequencyHz - b.candidate.frequencyHz ||
      a.track.frequencyHz - b.track.frequencyHz ||
      a.track.id.localeCompare(b.track.id),
  );
  const assigned = new Map<SignalCandidate, string>();
  const used = new Set<string>();
  for (const p of pairs)
    if (!used.has(p.track.id) && !assigned.has(p.candidate)) {
      assigned.set(p.candidate, p.track.id);
      used.add(p.track.id);
    }
  const uncertain = new Set<SignalCandidate>();
  for (const c of candidates) {
    const eligible = pairs.filter((p) => p.candidate === c);
    if (eligible.length > 1 && eligible[1]!.score - eligible[0]!.score < 0.1)
      uncertain.add(c);
  }
  return { assigned, uncertain };
}
