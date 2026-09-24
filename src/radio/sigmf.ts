import { validateRecordingMetadata, recordingSampleFormat, RECORDING_FORMAT, RECORDING_METADATA_MAX_BYTES } from "./iqRecording";
import type { IqRecording, RecordingGap } from "./iqRecording";
import { safeSurveySlug } from "./fieldSurvey";

export const SIGMF_VERSION = "1.2.6" as const;
export const SIGMF_RECORDER = "BrowserSDR" as const;

export interface SigmfGlobal {
  "core:datatype": "cu8" | "ci8";
  "core:version": typeof SIGMF_VERSION;
  "core:sample_rate": number;
  "core:recorder": typeof SIGMF_RECORDER;
  "core:sha512": string;
  "core:description": string;
  "core:hw"?: string;
}

export interface SigmfCapture {
  "core:sample_start": number;
  "core:frequency": number;
  "core:datetime"?: string;
  "core:global_index"?: number;
  "core:geolocation"?: { type: "Point"; coordinates: [number, number] };
}

export interface SigmfAnnotation {
  "core:sample_start": number;
  "core:sample_count": number;
  "core:label": string;
  "core:generator": typeof SIGMF_RECORDER;
  "core:comment": string;
  "core:freq_lower_edge"?: number;
  "core:freq_upper_edge"?: number;
}

export interface SigmfMetadata {
  global: SigmfGlobal;
  captures: SigmfCapture[];
  annotations: SigmfAnnotation[];
}

export interface SigmfExport {
  basename: string;
  dataFilename: string;
  metadataFilename: string;
  data: Uint8Array;
  metadata: SigmfMetadata;
  metadataJson: string;
}

interface ConsolidatedGap {
  sampleStart: number;
  knownMissingSamples: number;
  hasUnknownDuration: boolean;
  reasons: string[];
}

function consolidateGaps(gaps: readonly RecordingGap[]): ConsolidatedGap[] {
  const consolidated: ConsolidatedGap[] = [];
  for (const gap of gaps) {
    const previous = consolidated.at(-1);
    const target = previous?.sampleStart === gap.afterSample
      ? previous
      : { sampleStart: gap.afterSample, knownMissingSamples: 0, hasUnknownDuration: false, reasons: [] };
    if (target !== previous) consolidated.push(target);
    if (gap.missingSamples === null) target.hasUnknownDuration = true;
    else target.knownMissingSamples += gap.missingSamples;
    if (!target.reasons.includes(gap.reason)) target.reasons.push(gap.reason);
  }
  return consolidated;
}

function describeRecording(recording: IqRecording): string {
  const { metadata } = recording;
  if (metadata.format !== RECORDING_FORMAT) {
    const origin = metadata.provenanceDetails.originalSource === "hackrf" ? "HackRF Pro native USB bytes unchanged" : "imported CI8 bytes of unknown hardware origin";
    return `BrowserSDR CI8 I/Q capture: ${origin}. Amplitude is not calibrated. Dataset rate is native; stored bytes are unchanged. Playback channel processing is recorded in the format provenance. ${metadata.rateEvidence === "requested-and-acknowledged" ? "Rate and RF center are nominal USB-acknowledged requests, not firmware readbacks or physical measurements." : ""} Adapter reference commit is not an authenticated firmware hash. Capture format/provenance: ${JSON.stringify(recordingSampleFormat(metadata))}. ${metadata.provenance ?? ""}${metadata.survey ? ` Survey context: ${JSON.stringify(metadata.survey)}.` : ""}`;
  }
  let description = "BrowserSDR CU8 I/Q capture.";
  if (metadata.source === "synthetic") {
    description += " Normalized synthetic I/Q floats were quantized with the BrowserSDR CU8 formula byte = clamp(round((float + 0.995) * 128), 0, 255).";
  } else if (metadata.source === "replay") {
    description += ` Existing replay CU8 bytes were copied unchanged; replay normalization is ${metadata.normalization}.`;
  } else {
    description += " The dataset contains the captured interleaved unsigned 8-bit RTL-SDR I/Q transport bytes unchanged.";
  }
  description += " Amplitude is not calibrated.";
  if (metadata.provenance) description += ` Provenance: ${metadata.provenance}`;
  if (metadata.survey?.site) {
    description += ` Survey site: ${metadata.survey.site.label}.`;
    if (metadata.survey.site.antenna) description += ` Antenna: ${metadata.survey.site.antenna}.`;
    if (metadata.survey.site.notes) description += ` Site notes: ${metadata.survey.site.notes}.`;
  }
  if (metadata.survey?.profileName) description += ` Survey profile: ${metadata.survey.profileName}.`;
  return description;
}

function receiverSettingsComment(recording: IqRecording): string {
  const { metadata } = recording;
  if (metadata.format !== RECORDING_FORMAT) {
    return `Receiver settings: selected channel ${metadata.selectedChannelFrequencyHz} Hz; bandwidth ${metadata.channelBandwidthHz} Hz; source ${metadata.source}; mode ${metadata.mode}; squelch ${metadata.squelch}; stop reason ${metadata.stopReason}. Accepted settings and provenance: ${JSON.stringify(recordingSampleFormat(metadata))}. Not measured or calibrated RF gain.`;
  }
  const gain = metadata.gainDb === null
    ? "automatic RF gain"
    : `requested manual RF gain ${metadata.gainDb} dB`;
  return [
    `Receiver settings: selected channel ${metadata.selectedChannelFrequencyHz} Hz`,
    `bandwidth ${metadata.channelBandwidthHz} Hz`,
    `source ${metadata.source}`,
    gain,
    `squelch ${metadata.squelch}`,
    `stop reason ${metadata.stopReason}`,
  ].join("; ") + ". These are receiver settings, not calibrated RF measurements.";
}

function gapComment(gap: ConsolidatedGap): string {
  const reason = gap.reasons.length === 1 ? gap.reasons[0]! : gap.reasons.join("; ");
  const duration = gap.hasUnknownDuration
    ? gap.knownMissingSamples > 0
      ? `${gap.knownMissingSamples} known missing samples plus unknown duration`
      : "unknown duration"
    : `${gap.knownMissingSamples} missing samples`;
  return `Gap: ${reason}; ${duration}.`;
}

export function createSafeRecordingBasename(captureStartedAt: string): string {
  const timestamp = captureStartedAt.replace(/[:.]/g, "-");
  const safe = `browsersdr-${timestamp}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 180);
  return safe || "browsersdr-recording";
}

export function createSurveyRecordingBasename(recording: IqRecording): string {
  const timestamp = recording.metadata.captureStartedAt.replace(/[:.]/g, "-");
  const site = safeSurveySlug(recording.metadata.survey?.site?.label ?? "site");
  const frequencyKhz = Math.round(recording.metadata.selectedChannelFrequencyHz / 1_000).toString().padStart(6, "0");
  const signal = safeSurveySlug(recording.metadata.survey?.signal?.label ?? recording.metadata.mode, recording.metadata.mode.toLowerCase());
  return `browsersdr-${site}-${frequencyKhz}khz-${signal}-${timestamp}`.slice(0, 180).replace(/[.-]+$/g, "");
}

export async function sha512Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-512 processing requires the Web Crypto API in a secure browser context.");
  const stableCopy = new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-512", stableCopy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildSigmfMetadata(recording: IqRecording): Promise<SigmfMetadata> {
  const metadata = validateRecordingMetadata(recording.metadata, recording.data.byteLength);
  const gaps = consolidateGaps(metadata.knownGaps);
  const captures: SigmfCapture[] = [{
    "core:sample_start": 0,
    "core:frequency": metadata.centerFrequencyHz,
    "core:datetime": metadata.captureStartedAt,
    "core:global_index": 0,
    ...(metadata.survey?.site?.latitude !== undefined && metadata.survey.site.longitude !== undefined
      ? { "core:geolocation": { type: "Point" as const, coordinates: [metadata.survey.site.longitude, metadata.survey.site.latitude] as [number, number] } }
      : {}),
  }];
  let cumulativeKnownMissingSamples = 0;
  let globalIndexKnown = true;
  for (const gap of gaps) {
    cumulativeKnownMissingSamples += gap.knownMissingSamples;
    if (gap.hasUnknownDuration) globalIndexKnown = false;
    if (gap.sampleStart === 0) {
      if (globalIndexKnown) captures[0]!["core:global_index"] = cumulativeKnownMissingSamples;
      else delete captures[0]!["core:global_index"];
    } else if (globalIndexKnown && gap.knownMissingSamples > 0) {
      captures.push({
        "core:sample_start": gap.sampleStart,
        "core:frequency": metadata.centerFrequencyHz,
        ...(globalIndexKnown ? { "core:global_index": gap.sampleStart + cumulativeKnownMissingSamples } : {}),
      });
    }
  }

  const annotations: SigmfAnnotation[] = [{
    "core:sample_start": 0,
    "core:sample_count": metadata.sampleCount,
    "core:freq_lower_edge": metadata.selectedChannelFrequencyHz - metadata.channelBandwidthHz / 2,
    "core:freq_upper_edge": metadata.selectedChannelFrequencyHz + metadata.channelBandwidthHz / 2,
    "core:label": metadata.mode,
    "core:generator": SIGMF_RECORDER,
    "core:comment": receiverSettingsComment(recording),
  }];
  if (metadata.survey?.signal) {
    const signal = metadata.survey.signal;
    const details = [
      signal.modulation ? `modulation ${signal.modulation}` : "modulation unconfirmed",
      signal.encoding ? `encoding ${signal.encoding}` : "encoding unconfirmed",
      `identification confidence ${signal.confidence}`,
      metadata.survey.bandName ? `survey band ${metadata.survey.bandName}` : undefined,
      metadata.survey.detector ? `detector ${metadata.survey.detector}` : undefined,
    ].filter(Boolean).join("; ");
    annotations.push({
      "core:sample_start": 0,
      "core:sample_count": metadata.sampleCount,
      "core:freq_lower_edge": metadata.selectedChannelFrequencyHz - metadata.channelBandwidthHz / 2,
      "core:freq_upper_edge": metadata.selectedChannelFrequencyHz + metadata.channelBandwidthHz / 2,
      "core:label": signal.label || "Unidentified signal",
      "core:generator": SIGMF_RECORDER,
      "core:comment": `Survey annotation: ${details}. Receiver mode is not treated as proof of over-the-air modulation.`,
    });
  }
  for (const gap of gaps) {
    annotations.push({
      "core:sample_start": gap.sampleStart,
      "core:sample_count": 0,
      "core:label": "gap",
      "core:generator": SIGMF_RECORDER,
      "core:comment": gapComment(gap),
    });
  }

  captures.sort((left, right) => left["core:sample_start"] - right["core:sample_start"]);
  annotations.sort((left, right) => left["core:sample_start"] - right["core:sample_start"]);
  const result: SigmfMetadata = {
    global: {
      "core:datatype": metadata.sampleEncoding === "signed-8-bit" ? "ci8" : "cu8",
      "core:version": SIGMF_VERSION,
      "core:sample_rate": metadata.sampleRateHz,
      "core:recorder": SIGMF_RECORDER,
      "core:sha512": await sha512Hex(recording.data),
      "core:description": describeRecording(recording),
      ...(metadata.format !== RECORDING_FORMAT && metadata.hardware ? { "core:hw": `HackRF Pro via WebUSB; board ${metadata.hardware.boardId}; revision ${metadata.hardware.boardRevisionRaw}; API ${metadata.hardware.usbApiVersion}; firmware ${metadata.hardware.firmwareVersion}; serial ${metadata.hardware.serialWords.map(word => word.toString(16).padStart(8, "0")).join("")}` } : {}),
      ...(metadata.source === "rtl-sdr" ? { "core:hw": "RTL-SDR via WebUSB" } : {}),
    },
    captures,
    annotations,
  };
  if (new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength + 1 > RECORDING_METADATA_MAX_BYTES) throw new Error("SigMF metadata exceeds the 1 MiB limit.");
  return result;
}

export async function createSigmfExport(recording: IqRecording): Promise<SigmfExport> {
  const basename = recording.metadata.survey ? createSurveyRecordingBasename(recording) : createSafeRecordingBasename(recording.metadata.captureStartedAt);
  const metadata = await buildSigmfMetadata(recording);
  return {
    basename,
    dataFilename: `${basename}.sigmf-data`,
    metadataFilename: `${basename}.sigmf-meta`,
    data: recording.data,
    metadata,
    metadataJson: `${JSON.stringify(metadata, null, 2)}\n`,
  };
}
