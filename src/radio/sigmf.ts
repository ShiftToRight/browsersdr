import type { PocsagSettings } from "../pocsag/settings";
import { CHANNEL_RECORDING_FORMAT, type ChannelRecordingFormat } from "./channelRecording";
import { AIRSPY_RECORDING_FORMAT } from "./airspyRecording";
import { BLADERF_SC16_RECORDING_FORMAT, type BladeRfSc16RecordingFormat } from "./bladerfRecording";
import type { UsrpB205Ci16RecordingFormat } from "./ci16Recording";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { recordingDataBlob, recordingDataByteLength, validateRecordingMetadata, recordingSampleFormat, RECORDING_FORMAT, RECORDING_METADATA_MAX_BYTES } from "./iqRecording";
import type { IqRecording, RecordingGap } from "./iqRecording";
import { safeSurveySlug } from "./fieldSurvey";
import { STREAMING_RECORDING_MAX_BYTES } from "./recordingSpool";
import { CI16_RECORDING_FORMAT } from "./ci16Recording";

export const SIGMF_VERSION = "1.2.6" as const;
export const SIGMF_RECORDER = "BrowserSDR" as const;

export interface SigmfGlobal {
  "browsersdr:rtl_input"?: import("./rtlInput").RtlInputSettings;
  "browsersdr:pocsag"?: PocsagSettings;
  "browsersdr:reception"?: import("./receptionEvidence").ReceptionContext;
  "core:datatype": "cu8" | "ci8" | "ci16_le";
  "core:version": typeof SIGMF_VERSION;
  "core:sample_rate": number;
  "core:recorder": typeof SIGMF_RECORDER;
  "core:sha512": string;
  "core:description": string;
  "core:hw"?: string;
  "core:extensions"?: { name: "browsersdr"; version: "1.0.0"; optional: true }[];
  "browsersdr:sample_format"?: import("./airspyRecording").AirspyRecordingFormat | BladeRfSc16RecordingFormat | UsrpB205Ci16RecordingFormat | ChannelRecordingFormat;
}

export interface SigmfCapture {
  "browsersdr:receiver_location"?: import("./receiverLocation").ReceiverLocation;
  "core:sample_start": number;
  "core:frequency": number;
  "core:datetime"?: string;
  "core:global_index"?: number;
  "core:geolocation"?: { type: "Point"; coordinates: [number, number] | [number, number, number] };
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
  dataBlob?: Blob;
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
  if (metadata.format === AIRSPY_RECORDING_FORMAT) return `BrowserSDR Airspy converted I/Q, int16/32768. DC removal, Fs/4 translation, FIR filtering and optional decimation applied; not unchanged ADC bytes. ${metadata.provenance ?? ""}`;
  if (metadata.format === CHANNEL_RECORDING_FORMAT) {
    return `BrowserSDR current-channel I/Q from ${metadata.provenanceDetails.originalSource}; frequency shifted, FIR filtered and decimated, then requantized. Amplitude is uncalibrated. Capture processing: ${JSON.stringify(metadata.channelCapture)}. ${metadata.provenance ?? ""}`;
  }
  if (metadata.format === BLADERF_SC16_RECORDING_FORMAT) {
    return `BrowserSDR native bladeRF ${metadata.hardware.identity.model} SC16 Q11 I/Q. Little-endian signed words are retained unchanged; playback divides by 2048. Amplitude is uncalibrated. Capture sample rate and RF center are RFIC readbacks, not measured clock accuracy. Native DSP rate is ${metadata.nativeSampleRateHz} Hz. Host timing/accounting cannot prove hardware continuity. ${metadata.provenance ?? ""}`;
  }
  if (metadata.format === CI16_RECORDING_FORMAT) {
    return `BrowserSDR CI16 I/Q capture: USRP B205-mini native little-endian Q/I words were reordered losslessly to SigMF ci16_le I/Q without scaling. Amplitude is not calibrated. Rate and RF center use the validated B205 receive-session evidence. Capture format/provenance: ${JSON.stringify(recordingSampleFormat(metadata))}. ${metadata.provenance ?? ""}${metadata.survey ? ` Survey context: ${JSON.stringify(metadata.survey)}.` : ""}`;
  }
  if (metadata.format !== RECORDING_FORMAT) {
    const origin = metadata.provenanceDetails.originalSource === "hackrf" ? `${metadata.hardware?.kind === "hackrf-one" ? "HackRF One" : "HackRF Pro"} native USB bytes unchanged` : "imported CI8 bytes of unknown hardware origin";
    return `BrowserSDR CI8 I/Q capture: ${origin}. Amplitude is not calibrated. Dataset rate is native; stored bytes are unchanged. Playback channel processing is recorded in the format provenance. ${metadata.rateEvidence === "requested-and-acknowledged" ? "Rate and RF center are nominal USB-acknowledged requests, not firmware readbacks or physical measurements." : ""} Adapter reference commit is not an authenticated firmware hash. Capture format/provenance: ${JSON.stringify(recordingSampleFormat(metadata))}. ${metadata.provenance ?? ""}${metadata.survey ? ` Survey context: ${JSON.stringify(metadata.survey)}.` : ""}`;
  }
  let description = "BrowserSDR CU8 I/Q capture.";
  if (metadata.source === "synthetic") {
    description += " Normalized synthetic I/Q floats were quantized with the BrowserSDR CU8 formula byte = clamp(round(float * 128 + 127.5), 0, 255).";
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
    return `Receiver settings: selected channel ${metadata.selectedChannelFrequencyHz} Hz; bandwidth ${metadata.channelBandwidthHz} Hz; source ${metadata.source}; mode ${metadata.mode}; squelch ${metadata.squelch}${metadata.beatToneHz === undefined ? "" : `; CW beat tone ${metadata.beatToneHz} Hz`}; stop reason ${metadata.stopReason}. ${metadata.captureWarning ?? ""} Accepted settings and provenance: ${JSON.stringify(recordingSampleFormat(metadata))}. Not measured or calibrated RF gain.`;
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
    ...(metadata.captureWarning ? [metadata.captureWarning] : []),
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

async function recordingSha512Hex(recording: IqRecording): Promise<string> {
  if (!recording.dataBlob) return sha512Hex(recording.data);
  const hasher = sha512.create();
  const reader = (await recordingDataBlob(recording)).stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return bytesToHex(hasher.digest());
}

export async function buildSigmfMetadata(recording: IqRecording): Promise<SigmfMetadata> {
  const metadata = validateRecordingMetadata(recording.metadata, recordingDataByteLength(recording), STREAMING_RECORDING_MAX_BYTES);
  const gaps = consolidateGaps(metadata.knownGaps);
  const captures: SigmfCapture[] = [{
    "core:sample_start": 0,
    "core:frequency": metadata.centerFrequencyHz,
    "core:datetime": metadata.captureStartedAt,
    "core:global_index": 0,
    ...(metadata.receiverLocation ? {
      "core:geolocation": { type: "Point" as const, coordinates: (metadata.receiverLocation.altitudeMeters === undefined ? [metadata.receiverLocation.longitude, metadata.receiverLocation.latitude] : [metadata.receiverLocation.longitude, metadata.receiverLocation.latitude, metadata.receiverLocation.altitudeMeters]) as [number, number] | [number, number, number] },
      "browsersdr:receiver_location": metadata.receiverLocation,
    } : metadata.survey?.site?.latitude !== undefined && metadata.survey.site.longitude !== undefined
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
      "core:datatype": metadata.sampleEncoding === "signed-16-bit-little-endian"
        ? "ci16_le"
        : metadata.sampleEncoding === "signed-8-bit" ? "ci8" : "cu8",
      "core:version": SIGMF_VERSION,
      "core:sample_rate": metadata.sampleRateHz,
      "core:recorder": SIGMF_RECORDER,
      ...(metadata.rtlInput ? {"browsersdr:rtl_input": metadata.rtlInput, "core:extensions": [{ name: "browsersdr" as const, version: "1.0.0" as const, optional: true as const }] } : {}),
      "core:sha512": await recordingSha512Hex(recording),
      "core:description": describeRecording(recording),
      ...(metadata.mode === "POCSAG" && metadata.pocsag ? {"core:extensions": [{name:"browsersdr" as const,version:"1.0.0" as const,optional:true as const}], "browsersdr:pocsag":metadata.pocsag} : {}),
      ...(metadata.format !== CHANNEL_RECORDING_FORMAT && metadata.format !== RECORDING_FORMAT && metadata.format !== CI16_RECORDING_FORMAT && metadata.format !== BLADERF_SC16_RECORDING_FORMAT && metadata.hardware ? { "core:hw": `${metadata.hardware?.kind === "hackrf-one" ? "HackRF One" : "HackRF Pro"} via WebUSB; board ${metadata.hardware.boardId}; revision ${metadata.hardware.boardRevisionRaw}; API ${metadata.hardware.usbApiVersion}; firmware ${metadata.hardware.firmwareVersion}; serial ${metadata.hardware.serialWords.map(word => word.toString(16).padStart(8, "0")).join("")}` } : {}),
      ...(metadata.format === CI16_RECORDING_FORMAT ? { "core:hw": `USRP B205-mini via WebUSB; ${metadata.hardware.capabilities.identity.productName}; serial ${metadata.hardware.capabilities.identity.serialNumber ?? "unavailable"}; FPGA SHA-256 ${metadata.hardware.capabilities.fpga.imageSha256}; UHD profile ${metadata.hardware.capabilities.protocolProfile}` } : {}),
      ...(metadata.format === BLADERF_SC16_RECORDING_FORMAT ? {
        "core:hw": `bladeRF 2.0 Micro ${metadata.hardware.identity.model} via WebUSB; firmware ${metadata.hardware.identity.firmware.major}.${metadata.hardware.identity.firmware.minor}; FPGA ${metadata.hardware.identity.fpga.major}.${metadata.hardware.identity.fpga.minor}.${metadata.hardware.identity.fpga.patch}; ${metadata.hardware.rxInput ?? "RX1"}; image SHA-256 ${metadata.hardware.identity.volatileImage?.sha256 ?? "unknown; preconfigured"}`,
      } : {}),
      ...(metadata.format === AIRSPY_RECORDING_FORMAT || metadata.format === CHANNEL_RECORDING_FORMAT || metadata.format === BLADERF_SC16_RECORDING_FORMAT || metadata.format === CI16_RECORDING_FORMAT ? {
        "core:extensions": [{ name: "browsersdr" as const, version: "1.0.0" as const, optional: true as const }],
        "browsersdr:sample_format": recordingSampleFormat(metadata) as import("./airspyRecording").AirspyRecordingFormat | BladeRfSc16RecordingFormat | UsrpB205Ci16RecordingFormat | ChannelRecordingFormat,
      } : {}),
      ...(metadata.format === AIRSPY_RECORDING_FORMAT ? { "core:hw": `Airspy ${metadata.airspy.identity.rateProfile.toUpperCase()} via WebUSB; firmware ${metadata.airspy.identity.firmware}` } : {}),
      ...(metadata.source === "rtl-sdr" ? { "core:hw": "RTL-SDR via WebUSB" } : {}),
      ...(metadata.receiverLocation ? { "core:extensions": [{ name: "browsersdr" as const, version: "1.0.0" as const, optional: true as const }] } : {}),
      ...(metadata.reception ? {
        "core:extensions": [{ name: "browsersdr" as const, version: "1.0.0" as const, optional: true as const }],
        "browsersdr:reception": metadata.reception,
      } : {}),
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
    ...(recording.dataBlob ? { dataBlob: await recordingDataBlob(recording) } : {}),
    metadata,
    metadataJson: `${JSON.stringify(metadata, null, 2)}\n`,
  };
}
