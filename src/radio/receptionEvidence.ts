import type { RdsSnapshot, SourceKind } from "./types";
import type { PreparedRecordingExport } from "./recordingExportFormat";

export type CaptureOrigin = "real" | "synthetic" | "unknown";
export interface ReceptionCandidate {
  station_id?: string;
  transmission_id?: string;
  station_name?: string;
  frequency_hz: number;
  bandwidth_hz: number;
  mode: "WBFM" | "AM" | "NBFM";
}
export interface DecodedIdentityEvidence {
  decoder: "BrowserSDR RDS";
  validation: "crc-offset-validated";
  observed_at: string;
  sample_start: string;
  sample_count: string;
  pi: string;
  ps: string | null;
  radio_text: string | null;
  valid_groups: number;
  coverage: "capture-prefix";
}
export interface ReceptionContext {
  source_kind: CaptureOrigin;
  candidate?: ReceptionCandidate;
  decoded_evidence: DecodedIdentityEvidence[];
}
export function captureOrigin(source: SourceKind): CaptureOrigin {
  return source === "synthetic"
    ? "synthetic"
    : source === "replay"
      ? "unknown"
      : "real";
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** A link can propose settings, never start hardware or confirm a station. */
export function readReceptionCandidate(
  search: string,
): ReceptionCandidate | undefined {
  const p = new URLSearchParams(search),
    frequency = Number(p.get("frequency_hz"));
  if (
    !p.has("station_id") ||
    !uuid.test(p.get("station_id") ?? "") ||
    !Number.isFinite(frequency) ||
    frequency < 100000 ||
    frequency > 6e9
  )
    return undefined;
  const bandwidth = Number(p.get("bandwidth_hz") ?? 200000),
    mode = p.get("mode") ?? "WBFM";
  if (
    !Number.isFinite(bandwidth) ||
    bandwidth < 250 ||
    bandwidth > 300000 ||
    !["WBFM", "AM", "NBFM"].includes(mode)
  )
    return undefined;
  if (
    p.has("transmission_id") &&
    p.get("transmission_id") &&
    !uuid.test(p.get("transmission_id")!)
  )
    return undefined;
  return {
    station_id: p.get("station_id")!,
    transmission_id: p.get("transmission_id") || undefined,
    station_name: p.get("station_name")?.slice(0, 300),
    frequency_hz: frequency,
    bandwidth_hz: bandwidth,
    mode: mode as ReceptionCandidate["mode"],
  };
}
export function preparedReception(
  prepared: PreparedRecordingExport,
): ReceptionContext | undefined {
  const file = prepared.files.find((f) => f.name.endsWith(".sigmf-meta"));
  if (typeof file?.contents !== "string") return undefined;
  try {
    return (
      JSON.parse(file.contents) as {
        global?: { "browsersdr:reception"?: ReceptionContext };
      }
    ).global?.["browsersdr:reception"];
  } catch {
    return undefined;
  }
}
/** Observations come from an independent decoder started at the capture boundary.
 * A prefix is supporting sample coverage, not the location of individual RDS bits. */
export class CaptureRdsEvidence {
  private observations: DecodedIdentityEvidence[] = [];
  observe(
    state: RdsSnapshot,
    sampleCount: number,
    observedAt = new Date().toISOString(),
  ): void {
    if (
      !state.validGroups ||
      !state.pi ||
      !/^[A-F0-9]{4}$/.test(state.pi) ||
      !Number.isSafeInteger(sampleCount) ||
      sampleCount <= 0
    )
      return;
    const evidence: DecodedIdentityEvidence = {
      decoder: "BrowserSDR RDS",
      validation: "crc-offset-validated",
      observed_at: observedAt,
      sample_start: "0",
      sample_count: String(sampleCount),
      pi: state.pi,
      ps: state.programmeService,
      radio_text: state.radioText,
      valid_groups: state.validGroups,
      coverage: "capture-prefix",
    };
    const last = this.observations.at(-1);
    if (
      last &&
      last.pi === evidence.pi &&
      last.ps === evidence.ps &&
      last.radio_text === evidence.radio_text
    )
      this.observations[this.observations.length - 1] = evidence;
    else {
      this.observations.push(evidence);
      if (this.observations.length > 20) this.observations.shift();
    }
  }
  finish(savedSamples: number): DecodedIdentityEvidence[] {
    return this.observations
      .filter((e) => BigInt(e.sample_count) <= BigInt(savedSamples))
      .map((e) => ({ ...e }));
  }
}
