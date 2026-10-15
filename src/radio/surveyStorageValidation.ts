import {
  validateSurveyProfile,
  type SurveyCandidateRecord,
} from "./fieldSurvey";
import type { SignalCandidate, ScanWindowResult } from "./spectrumScan";
import type { PersistedSurveyRun } from "./surveyStorage";

const invalid = () =>
  new Error(
    "Stored survey is invalid or unsupported. Start a new scan; the previous stored data has not been applied.",
  );
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown) => finite(v) && v > 0;
const integer = (v: unknown) => finite(v) && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown) =>
  typeof v === "string" && v.length > 0 && v.length <= 500;
const date = (v: unknown) =>
  text(v) && Number.isFinite(Date.parse(v as string));
const detector = (v: unknown) =>
  ["average", "max-hold", "occupancy", "wideband"].includes(v as string);
function candidate(c: SignalCandidate) {
  if (
    !c ||
    !positive(c.frequencyHz) ||
    !finite(c.peakDb) ||
    !finite(c.noiseFloorDb) ||
    !positive(c.bandwidthHz) ||
    (c.detector !== undefined && !detector(c.detector)) ||
    (c.occupancy !== undefined &&
      (!finite(c.occupancy) || c.occupancy < 0 || c.occupancy > 1))
  )
    throw invalid();
}
function record(c: SurveyCandidateRecord) {
  candidate(c);
  if (
    !text(c.bandId) ||
    !text(c.bandName) ||
    typeof c.selected !== "boolean" ||
    typeof c.captured !== "boolean" ||
    !c.annotation ||
    !["unknown", "low", "medium", "high"].includes(c.annotation.confidence)
  )
    throw invalid();
  for (const field of [
    c.annotation.label,
    c.annotation.modulation,
    c.annotation.encoding,
  ])
    if (field !== undefined && typeof field !== "string") throw invalid();
}
function windowResult(w: ScanWindowResult) {
  const p = w?.plan;
  if (
    !p ||
    !integer(p.index) ||
    !positive(p.centerFrequencyHz) ||
    !finite(p.lowerFrequencyHz) ||
    !finite(p.upperFrequencyHz) ||
    p.lowerFrequencyHz >= p.upperFrequencyHz ||
    !finite(w.noiseFloorDb) ||
    !integer(w.frameCount) ||
    !integer(w.missingSamples) ||
    !finite(w.coverage) ||
    w.coverage < 0 ||
    w.coverage > 1 ||
    !["complete", "insufficient", "failed"].includes(w.status) ||
    !Array.isArray(w.points) ||
    w.points.length > 65536 ||
    !Array.isArray(w.candidates) ||
    w.candidates.length > 65536 ||
    (w.error !== undefined && typeof w.error !== "string")
  )
    throw invalid();
  for (const point of w.points)
    if (!point || !finite(point.frequencyHz) || !finite(point.powerDb))
      throw invalid();
  w.candidates.forEach(candidate);
}
/** Validate the complete restored presentation graph before any React state is applied. */
export function validatePersistedSurveyRun(value: unknown): PersistedSurveyRun {
  let nodes = 0;
  function bounded(v: unknown, depth: number) {
    if (++nodes > 5_000_000 || depth > 20) throw invalid();
    if (typeof v === "string" && v.length > 16_384) throw invalid();
    if (typeof v === "number" && !finite(v)) throw invalid();
    if (v && typeof v === "object")
      for (const child of Object.values(v)) bounded(child, depth + 1);
  }
  bounded(value, 0);
  const run = value as PersistedSurveyRun;
  const s = run?.snapshot;
  if (
    !run ||
    run.version !== 1 ||
    run.key !== "latest" ||
    !date(run.savedAt) ||
    !["window", "band-plan", "full"].includes(run.scope) ||
    !["running", "completed", "cancelled", "failed", "insufficient"].includes(
      run.status,
    ) ||
    !s ||
    !text(s.sessionId) ||
    !date(s.startedAt) ||
    !Array.isArray(run.windows) ||
    run.windows.length > 32768 ||
    !Array.isArray(run.records) ||
    run.records.length > 65536 ||
    !run.progress ||
    !integer(run.progress.completed) ||
    !integer(run.progress.total) ||
    run.progress.completed > run.progress.total
  )
    throw invalid();
  validateSurveyProfile(s.profile);
  const r = s.receiver;
  if (
    !r ||
    ![
      "synthetic",
      "rtl-sdr",
      "hackrf",
      "bladerf",
      "usrp-b205",
      "replay",
    ].includes(r.source) ||
    !integer(r.sessionGeneration) ||
    !positive(r.actualSampleRateHz) ||
    !positive(r.requestedSampleRateHz) ||
    !positive(r.hardwareCenterFrequencyHz) ||
    !positive(r.selectedChannelFrequencyHz) ||
    ![
      "OFF",
      "WBFM",
      "NBFM",
      "AM",
      "USB",
      "LSB",
      "CW",
      "DAB",
      "ADS-B",
      "AIS",
      "SRD",
      "APRS",
      "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT",
    ].includes(r.mode) ||
    !finite(r.channelBandwidthHz) ||
    !finite(r.squelch) ||
    !(r.gainDb === null || finite(r.gainDb)) ||
    r.sampleFormat !== "planar-f32-iq-normalized"
  )
    throw invalid();
  run.windows.forEach(windowResult);
  run.records.forEach(record);
  if (run.manifest) {
    const m = run.manifest;
    if (
      m.version !== 1 ||
      m.sessionId !== s.sessionId ||
      !date(m.startedAt) ||
      !date(m.completedAt) ||
      !["completed", "cancelled", "failed", "insufficient"].includes(
        m.status,
      ) ||
      !m.receiver ||
      !positive(m.receiver.sampleRateHz) ||
      m.receiver.source !== r.source ||
      m.receiver.levels !== "relative-dB-uncalibrated" ||
      !Array.isArray(m.candidates) ||
      m.candidates.length > 65536
    )
      throw invalid();
    validateSurveyProfile(m.profile);
    m.candidates.forEach(record);
    // Restore the already validated acquisition context; never trust a second divergent copy.
    return {
      ...run,
      manifest: { ...m, receiver: { ...m.receiver, metadata: r } },
    };
  }
  return run;
}
