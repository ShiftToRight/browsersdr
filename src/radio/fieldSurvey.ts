import type { SignalCandidate } from "./spectrumScan";
import type { SourceSessionMetadata } from "./types";

export const FIELD_SURVEY_VERSION = 1 as const;

export type SurveyDetectorMode = "average" | "max-hold" | "occupancy" | "wideband";
export type SurveyConfidence = "unknown" | "low" | "medium" | "high";

export interface SurveySite {
  label: string;
  latitude?: number;
  longitude?: number;
  antenna?: string;
  notes?: string;
}

export interface SurveyBand {
  id: string;
  name: string;
  startFrequencyHz: number;
  endFrequencyHz: number;
  dwellMs: number;
  thresholdDb: number;
  detector: SurveyDetectorMode;
  captureSeconds: number;
}

export interface SurveySignalAnnotation {
  label?: string;
  modulation?: string;
  encoding?: string;
  confidence: SurveyConfidence;
}

export interface SurveyCaptureContext {
  sessionId?: string;
  profileName?: string;
  site?: SurveySite;
  bandName?: string;
  detector?: SurveyDetectorMode;
  signal?: SurveySignalAnnotation;
}

export interface SurveyProfile {
  version: typeof FIELD_SURVEY_VERSION;
  name: string;
  site: SurveySite;
  bands: SurveyBand[];
}

export interface SurveyCandidateRecord extends SignalCandidate {
  bandId: string;
  bandName: string;
  selected: boolean;
  captured: boolean;
  annotation: SurveySignalAnnotation;
}

export interface SurveyManifest {
  version: typeof FIELD_SURVEY_VERSION;
  sessionId: string;
  startedAt: string;
  completedAt: string;
  status: SurveyRunStatus;
  profile: SurveyProfile;
  receiver: {
    sampleRateHz: number;
    source: string;
    levels: "relative-dB-uncalibrated";
    metadata: SourceSessionMetadata;
  };
  candidates: SurveyCandidateRecord[];
}

export type SurveyRunStatus = "completed" | "cancelled" | "failed" | "insufficient";

export interface SurveyRunSnapshot {
  sessionId: string;
  startedAt: string;
  profile: SurveyProfile;
  receiver: SourceSessionMetadata;
}

export function createSurveyRunSnapshot(
  profile: SurveyProfile,
  effectiveBands: readonly SurveyBand[],
  receiver: SourceSessionMetadata,
  startedAt = new Date().toISOString(),
  sessionId = createSurveySessionId(new Date(startedAt)),
): SurveyRunSnapshot {
  return {
    sessionId,
    startedAt,
    profile: validateSurveyProfile({ ...profile, site: { ...profile.site }, bands: effectiveBands.map((band) => ({ ...band })) }),
    receiver: structuredClone(receiver),
  };
}

export function createSurveyManifest(
  snapshot: SurveyRunSnapshot,
  status: SurveyRunStatus,
  candidates: readonly SurveyCandidateRecord[],
  completedAt = new Date().toISOString(),
): SurveyManifest {
  return {
    version: FIELD_SURVEY_VERSION,
    sessionId: snapshot.sessionId,
    startedAt: snapshot.startedAt,
    completedAt,
    status,
    profile: validateSurveyProfile(snapshot.profile),
    receiver: {
      sampleRateHz: snapshot.receiver.actualSampleRateHz,
      source: snapshot.receiver.source,
      levels: "relative-dB-uncalibrated",
      metadata: structuredClone(snapshot.receiver),
    },
    candidates: candidates.map((candidate) => ({ ...candidate, annotation: { ...candidate.annotation } })),
  };
}

export const DEFAULT_SURVEY_PROFILE: SurveyProfile = {
  version: FIELD_SURVEY_VERSION,
  name: "Portable VHF/UHF survey",
  site: { label: "Unnamed site" },
  bands: [
    { id: "fm-broadcast", name: "FM broadcast", startFrequencyHz: 87_500_000, endFrequencyHz: 108_000_000, dwellMs: 350, thresholdDb: 10, detector: "average", captureSeconds: 10 },
    { id: "airband", name: "Civil airband", startFrequencyHz: 118_000_000, endFrequencyHz: 137_000_000, dwellMs: 1_000, thresholdDb: 6, detector: "max-hold", captureSeconds: 12 },
    { id: "dab-band-iii", name: "DAB+ Band III", startFrequencyHz: 174_000_000, endFrequencyHz: 230_000_000, dwellMs: 500, thresholdDb: 5, detector: "wideband", captureSeconds: 8 },
    { id: "srd-433", name: "433 MHz SRD/ISM", startFrequencyHz: 433_050_000, endFrequencyHz: 434_790_000, dwellMs: 1_000, thresholdDb: 6, detector: "max-hold", captureSeconds: 12 },
    { id: "srd-868", name: "863–870 MHz SRD", startFrequencyHz: 863_000_000, endFrequencyHz: 870_000_000, dwellMs: 1_000, thresholdDb: 6, detector: "occupancy", captureSeconds: 12 },
    { id: "adsb-1090", name: "1090 MHz transponders", startFrequencyHz: 1_089_500_000, endFrequencyHz: 1_090_500_000, dwellMs: 2_000, thresholdDb: 6, detector: "max-hold", captureSeconds: 12 },
  ],
};

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

export function validateSurveyProfile(value: unknown): SurveyProfile {
  if (!value || typeof value !== "object") throw new Error("Survey profile must be an object.");
  const candidate = value as Partial<SurveyProfile>;
  if (candidate.version !== FIELD_SURVEY_VERSION) throw new Error(`Survey profile version must be ${FIELD_SURVEY_VERSION}.`);
  const name = optionalText(candidate.name);
  if (!name) throw new Error("Survey profile needs a name.");
  if (!candidate.site || typeof candidate.site !== "object") throw new Error("Survey profile needs a site.");
  const siteLabel = optionalText(candidate.site.label);
  if (!siteLabel) throw new Error("Survey site needs a label.");
  const latitude = candidate.site.latitude === undefined ? undefined : finiteNumber(candidate.site.latitude, "Latitude");
  const longitude = candidate.site.longitude === undefined ? undefined : finiteNumber(candidate.site.longitude, "Longitude");
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) throw new Error("Latitude must be between -90 and 90.");
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) throw new Error("Longitude must be between -180 and 180.");
  if (!Array.isArray(candidate.bands) || candidate.bands.length === 0 || candidate.bands.length > 64) throw new Error("Survey profile must contain 1–64 bands.");
  const ids = new Set<string>();
  const bands = candidate.bands.map((band, index): SurveyBand => {
    if (!band || typeof band !== "object") throw new Error(`Band ${index + 1} is invalid.`);
    const id = optionalText(band.id);
    const bandName = optionalText(band.name);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`Band ${index + 1} needs a unique safe id.`);
    ids.add(id);
    if (!bandName) throw new Error(`Band ${id} needs a name.`);
    const startFrequencyHz = finiteNumber(band.startFrequencyHz, `${bandName} start frequency`);
    const endFrequencyHz = finiteNumber(band.endFrequencyHz, `${bandName} end frequency`);
    const dwellMs = finiteNumber(band.dwellMs, `${bandName} dwell`);
    const thresholdDb = finiteNumber(band.thresholdDb, `${bandName} threshold`);
    const captureSeconds = finiteNumber(band.captureSeconds, `${bandName} capture duration`);
    if (startFrequencyHz <= 0 || endFrequencyHz <= startFrequencyHz) throw new Error(`${bandName} has an invalid frequency range.`);
    if (dwellMs < 150 || dwellMs > 10_000) throw new Error(`${bandName} dwell must be 150–10,000 ms.`);
    if (thresholdDb < 1 || thresholdDb > 40) throw new Error(`${bandName} threshold must be 1–40 dB.`);
    if (captureSeconds < 1 || captureSeconds > 300) throw new Error(`${bandName} capture duration must be 1–300 seconds.`);
    if (!["average", "max-hold", "occupancy", "wideband"].includes(band.detector)) throw new Error(`${bandName} has an unknown detector.`);
    return { id, name: bandName, startFrequencyHz, endFrequencyHz, dwellMs, thresholdDb, captureSeconds, detector: band.detector };
  });
  return {
    version: FIELD_SURVEY_VERSION,
    name,
    site: {
      label: siteLabel,
      ...(latitude === undefined ? {} : { latitude }),
      ...(longitude === undefined ? {} : { longitude }),
      ...(optionalText(candidate.site.antenna) ? { antenna: optionalText(candidate.site.antenna) } : {}),
      ...(optionalText(candidate.site.notes) ? { notes: optionalText(candidate.site.notes) } : {}),
    },
    bands,
  };
}

export function parseSurveyProfile(text: string): SurveyProfile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Survey profile is not valid JSON."); }
  return validateSurveyProfile(value);
}

export function validateSurveyCaptureContext(value: unknown): SurveyCaptureContext {
  if (!value || typeof value !== "object") throw new Error("Survey capture context must be an object.");
  const candidate = value as SurveyCaptureContext;
  const confidence = candidate.signal?.confidence ?? "unknown";
  if (!["unknown", "low", "medium", "high"].includes(confidence)) throw new Error("Survey confidence is invalid.");
  let site: SurveySite | undefined;
  if (candidate.site) {
    const label = optionalText(candidate.site.label);
    if (!label) throw new Error("Survey capture site needs a label.");
    const latitude = candidate.site.latitude === undefined ? undefined : finiteNumber(candidate.site.latitude, "Latitude");
    const longitude = candidate.site.longitude === undefined ? undefined : finiteNumber(candidate.site.longitude, "Longitude");
    if (latitude !== undefined && (latitude < -90 || latitude > 90)) throw new Error("Latitude must be between -90 and 90.");
    if (longitude !== undefined && (longitude < -180 || longitude > 180)) throw new Error("Longitude must be between -180 and 180.");
    site = {
      label,
      ...(latitude === undefined ? {} : { latitude }),
      ...(longitude === undefined ? {} : { longitude }),
      ...(optionalText(candidate.site.antenna) ? { antenna: optionalText(candidate.site.antenna) } : {}),
      ...(optionalText(candidate.site.notes) ? { notes: optionalText(candidate.site.notes) } : {}),
    };
  }
  return {
    ...(optionalText(candidate.sessionId) ? { sessionId: optionalText(candidate.sessionId) } : {}),
    ...(optionalText(candidate.profileName) ? { profileName: optionalText(candidate.profileName) } : {}),
    ...(site ? { site } : {}),
    ...(optionalText(candidate.bandName) ? { bandName: optionalText(candidate.bandName) } : {}),
    ...(candidate.detector && ["average", "max-hold", "occupancy", "wideband"].includes(candidate.detector) ? { detector: candidate.detector } : {}),
    ...(candidate.signal ? { signal: {
      ...(optionalText(candidate.signal.label) ? { label: optionalText(candidate.signal.label) } : {}),
      ...(optionalText(candidate.signal.modulation) ? { modulation: optionalText(candidate.signal.modulation) } : {}),
      ...(optionalText(candidate.signal.encoding) ? { encoding: optionalText(candidate.signal.encoding) } : {}),
      confidence,
    } } : {}),
  };
}

export function createSurveySessionId(now = new Date()): string {
  return `survey-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export function safeSurveySlug(value: string, fallback = "survey"): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || fallback;
}

export function surveyProfileJson(profile: SurveyProfile): string {
  return `${JSON.stringify(validateSurveyProfile(profile), null, 2)}\n`;
}

export function surveyManifestJson(manifest: SurveyManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function surveyManifestCsv(manifest: SurveyManifest): string {
  const headers = ["session_id", "run_status", "started_at", "completed_at", "site", "source", "sample_rate_hz", "band", "frequency_hz", "peak_relative_db", "above_floor_db", "bandwidth_hz", "occupancy", "detector", "selected", "captured", "label", "modulation", "encoding", "confidence"];
  const rows = manifest.candidates.map((candidate) => [
    manifest.sessionId,
    manifest.status,
    manifest.startedAt,
    manifest.completedAt,
    manifest.profile.site.label,
    manifest.receiver.source,
    manifest.receiver.sampleRateHz,
    candidate.bandName,
    candidate.frequencyHz,
    candidate.peakDb,
    candidate.peakDb - candidate.noiseFloorDb,
    candidate.bandwidthHz,
    candidate.occupancy ?? "",
    candidate.detector,
    candidate.selected,
    candidate.captured,
    candidate.annotation.label ?? "",
    candidate.annotation.modulation ?? "",
    candidate.annotation.encoding ?? "",
    candidate.annotation.confidence,
  ]);
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
