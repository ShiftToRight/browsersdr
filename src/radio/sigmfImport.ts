import { AIRSPY_RECORDING_FORMAT } from "./airspyRecording";
import { validateReceiverLocation, type ReceiverLocation } from "./receiverLocation";
import { CHANNEL_RECORDING_FORMAT, type ChannelRecordingFormat } from "./channelRecording";
import { BLADERF_SC16_RECORDING_FORMAT, type BladeRfSc16RecordingFormat } from "./bladerfRecording";
import { CI16_RECORDING_FORMAT, type UsrpB205Ci16RecordingFormat } from "./ci16Recording";
import { channelSampleRate } from "./sourceCapabilities";
import { unknownCi8Format } from "./ci8Recording";
import {
  BYTES_PER_COMPLEX_SAMPLE,
  RECORDING_FORMAT,
  RECORDING_MAX_BYTES,
  RECORDING_METADATA_MAX_BYTES,
  CU8_NORMALIZATION,
  validateRecordingMetadata,
  type IqRecording,
  type RecordingGap,
} from "./iqRecording";
import { normalizeModeSettings, validateModeSampleRate, type ReceiverModeSettings } from "./receiverConfig";
import { hashChunks } from "./hashing";
import { STREAMING_RECORDING_MAX_BYTES } from "./recordingSpool";
import { sha512Hex, SIGMF_VERSION } from "./sigmf";

export interface SigmfImportOptions {
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  modeSettings: ReceiverModeSettings;
  selectedChannelFrequencyHz?: number;
  dataFilename?: string;
  metadataFilename?: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`SigMF ${name} must be an object.`);
  return value as JsonObject;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`SigMF ${name} must be a finite number.`);
  return value;
}

function safeIndex(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`SigMF ${name} must be a non-negative safe integer.`);
  return value as number;
}

function optionalFilename(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 512) throw new Error(`SigMF ${name} is invalid.`);
  return value;
}

function parseMetadata(metadataText: string): JsonObject {
  if (new TextEncoder().encode(metadataText).byteLength > RECORDING_METADATA_MAX_BYTES) {
    throw new Error("SigMF metadata exceeds the 1 MiB limit.");
  }
  try {
    return object(JSON.parse(metadataText) as unknown, "metadata");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("SigMF metadata is not valid JSON.", { cause: error });
    throw error;
  }
}

function validateGlobal(global: JsonObject): { sampleRateHz: number; encoding: "cu8" | "ci8" | "ci16_le"; expectedHash?: string } {
  const encoding = global["core:datatype"];
  if (encoding !== "cu8" && encoding !== "ci8" && encoding !== "ci16_le") throw new Error("SigMF import supports one-channel cu8, ci8, or explicitly described BrowserSDR ci16_le.");
  if (global["core:version"] !== SIGMF_VERSION) throw new Error(`SigMF import supports metadata version ${SIGMF_VERSION}.`);
  const sampleRateHz = finite(global["core:sample_rate"], "sample rate");
  if (sampleRateHz <= 0) throw new Error("SigMF sample rate must be positive.");
  if (global["core:num_channels"] !== undefined && global["core:num_channels"] !== 1) {
    throw new Error("SigMF import supports exactly one complex channel.");
  }
  if (global["core:offset"] !== undefined && global["core:offset"] !== 0) throw new Error("SigMF datasets with a nonzero sample offset are not supported.");
  if (global["core:dataset"] !== undefined || global["core:trailing_bytes"] !== undefined) {
    throw new Error("SigMF non-conforming datasets, alternate dataset names, and trailing bytes are not supported.");
  }
  if (global["core:metadata_only"] === true) throw new Error("SigMF metadata-only recordings cannot be replayed.");

  const extensions = global["core:extensions"];
  if (extensions !== undefined) {
    if (!Array.isArray(extensions)) throw new Error("SigMF core:extensions must be an array.");
    for (const item of extensions) {
      const extension = object(item, "extension");
      if (typeof extension.name !== "string" || typeof extension.version !== "string" || typeof extension.optional !== "boolean") {
        throw new Error("SigMF extension declarations are malformed.");
      }
      if (!extension.optional) throw new Error(`Required SigMF extension ${extension.name} is not supported.`);
    }
  }

  const hash = global["core:sha512"];
  if (hash !== undefined && (typeof hash !== "string" || !/^[0-9a-fA-F]{128}$/.test(hash))) {
    throw new Error("SigMF core:sha512 must contain exactly 128 hexadecimal characters.");
  }
  return { sampleRateHz, encoding, ...(typeof hash === "string" ? { expectedHash: hash.toLowerCase() } : {}) };
}

function captureDetails(capturesValue: unknown, sampleCount: number): {
  centerFrequencyHz: number;
  captureStartedAt: string;
  knownGaps: RecordingGap[];
} {
  if (!Array.isArray(capturesValue) || capturesValue.length === 0) {
    throw new Error("SigMF import requires a capture segment at sample index zero with frequency and UTC timestamp.");
  }
  if (capturesValue.length > 10_001) throw new Error("SigMF metadata contains too many capture segments.");
  const captures = capturesValue.map((value) => object(value, "capture segment"));
  const first = captures[0]!;
  const centerFrequencyHz = finite(first["core:frequency"], "capture frequency");
  if (centerFrequencyHz <= 0) throw new Error("SigMF capture frequency must be positive.");
  const captureStartedAt = first["core:datetime"];
  if (typeof captureStartedAt !== "string" || !captureStartedAt.endsWith("Z") || !Number.isFinite(Date.parse(captureStartedAt))) {
    throw new Error("SigMF import requires a valid UTC core:datetime on the first capture segment.");
  }

  const knownGaps: RecordingGap[] = [];
  let previousStart = -1;
  let previousStreamOffset = 0;
  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index]!;
    const sampleStart = safeIndex(capture["core:sample_start"], "capture sample_start");
    if (sampleStart > sampleCount) throw new Error("SigMF capture sample_start lies beyond the dataset.");
    if (index === 0 && sampleStart !== 0) throw new Error("SigMF import requires the first capture segment to start at sample zero.");
    if (sampleStart <= previousStart) throw new Error("SigMF capture segments must have strictly increasing sample_start values.");
    previousStart = sampleStart;
    if (capture["core:header_bytes"] !== undefined && capture["core:header_bytes"] !== 0) {
      throw new Error("SigMF capture headers and non-conforming dataset layouts are not supported.");
    }
    const frequency = finite(capture["core:frequency"], "capture frequency");
    if (frequency !== centerFrequencyHz) throw new Error("SigMF recordings that change capture frequency are not supported.");
    const datetime = capture["core:datetime"];
    if (datetime !== undefined && (typeof datetime !== "string" || !datetime.endsWith("Z") || !Number.isFinite(Date.parse(datetime)))) {
      throw new Error("SigMF capture segment has an invalid UTC core:datetime.");
    }
    const globalIndex = capture["core:global_index"] === undefined
      ? sampleStart
      : safeIndex(capture["core:global_index"], "capture global_index");
    if (globalIndex < sampleStart) throw new Error("SigMF global_index cannot precede its dataset sample_start.");
    const streamOffset = globalIndex - sampleStart;
    if (streamOffset < previousStreamOffset) throw new Error("SigMF global_index moves backwards and cannot be represented by paced replay.");
    const missingSamples = streamOffset - previousStreamOffset;
    if (missingSamples > 0) knownGaps.push({ afterSample: sampleStart, missingSamples, reason: "SigMF global_index discontinuity" });
    previousStreamOffset = streamOffset;
  }
  return { centerFrequencyHz, captureStartedAt, knownGaps };
}

/** Recognize only the bounded gap comments emitted by our exporter. Other
 * annotations remain verbatim metadata, never inferred receiver settings. */
function importGapAnnotations(annotations: unknown[], captures: RecordingGap[], sampleCount: number): RecordingGap[] {
  if (annotations.length > 10_002) throw new Error("Too many SigMF annotations.");
  const gaps = [...captures];
  for (const value of annotations) {
    const a = object(value, "annotation");
    if (a["core:generator"] !== "BrowserSDR" || a["core:label"] !== "gap" || a["core:sample_count"] !== 0 || typeof a["core:comment"] !== "string") continue;
    const match = /^Gap: (.*); (?:(\d+) (?:known )?missing samples(?: plus (unknown duration))?|(unknown duration))\.$/.exec(a["core:comment"]);
    if (!match) continue;
    const afterSample = safeIndex(a["core:sample_start"], "gap position");
    if (afterSample > sampleCount) throw new Error("SigMF gap is outside the dataset.");
    const existing = gaps.findIndex(g => g.afterSample === afterSample);
    if (existing >= 0) gaps.splice(existing, 1);
    const known = match[2] === undefined ? 0 : Number(match[2]);
    if (known) gaps.push({ afterSample, missingSamples: known, reason: match[1]! });
    if (match[3] || match[4]) gaps.push({ afterSample, missingSamples: null, reason: match[1]! });
    if (!known && !match[3] && !match[4]) gaps.push({ afterSample, missingSamples: 0, reason: match[1]! });
  }
  return gaps.sort((a, b) => a.afterSample - b.afterSample);
}

export async function importSigmfRecording(
  metadataText: string,
  binary: ArrayBuffer | Uint8Array | Blob,
  options: SigmfImportOptions,
): Promise<IqRecording> {
  const byteLength = binary instanceof Blob ? binary.size : binary.byteLength;
  const maximum = binary instanceof Blob ? STREAMING_RECORDING_MAX_BYTES : RECORDING_MAX_BYTES;
  if (byteLength > maximum) throw new Error(binary instanceof Blob ? "SigMF dataset exceeds the 2 GiB replay limit." : "SigMF dataset exceeds the 32 MiB replay limit.");
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % BYTES_PER_COMPLEX_SAMPLE !== 0) {
    throw new Error("SigMF dataset is empty or truncated: cu8 requires complete I/Q byte pairs.");
  }
  const root = parseMetadata(metadataText);
  const global = object(root.global, "global object");
  if (!Array.isArray(root.annotations)) throw new Error("SigMF annotations must be an array.");
  const { sampleRateHz, encoding, expectedHash } = validateGlobal(global);
  const bytesPerComplexSample = encoding === "ci16_le" ? 4 : BYTES_PER_COMPLEX_SAMPLE;
  if (byteLength % bytesPerComplexSample) throw new Error("SigMF dataset is truncated: CI16 requires complete I/Q word pairs.");
  const extension = global["browsersdr:sample_format"];
  const nativeFormat = encoding === "ci16_le" || (extension && typeof extension === "object" && (extension as JsonObject).format === CHANNEL_RECORDING_FORMAT) ? object(extension, "sample format/scaling") : undefined;
  if (nativeFormat && nativeFormat.format !== AIRSPY_RECORDING_FORMAT && nativeFormat.format !== BLADERF_SC16_RECORDING_FORMAT && nativeFormat.format !== CI16_RECORDING_FORMAT && nativeFormat.format !== CHANNEL_RECORDING_FORMAT)
    throw new Error("SigMF CI16 needs a supported explicit sample format/scaling; Q11 is never inferred.");
  const sampleCount = byteLength / bytesPerComplexSample;
  const { centerFrequencyHz, captureStartedAt, knownGaps } = captureDetails(root.captures, sampleCount);
  const mode = normalizeModeSettings({...options.modeSettings, ...(options.modeSettings.mode === "POCSAG" && options.modeSettings.pocsag === undefined && global["browsersdr:pocsag"] !== undefined ? {pocsag:global["browsersdr:pocsag"] as import("../pocsag/settings").PocsagSettings} : {})});
  validateModeSampleRate(mode.mode, encoding === "ci16_le" || encoding === "ci8" ? channelSampleRate(nativeFormat?.format === CHANNEL_RECORDING_FORMAT ? finite(object(nativeFormat.channelCapture, "channel capture").dspSampleRateHz, "channel DSP sample rate") : nativeFormat?.format === BLADERF_SC16_RECORDING_FORMAT ? finite(nativeFormat.nativeSampleRateHz, "nominal bladeRF sample rate") : sampleRateHz) : sampleRateHz);
  const selectedChannelFrequencyHz = options.selectedChannelFrequencyHz ?? centerFrequencyHz;

  const sourceBytes = binary instanceof Uint8Array
    ? new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
    : binary instanceof Blob ? undefined : new Uint8Array(binary);

  const receiverLocation = importReceiverLocation(root.captures, global["core:geolocation"]);
  const metadata = validateRecordingMetadata({
    ...(nativeFormat ? nativeFormat as unknown as BladeRfSc16RecordingFormat | UsrpB205Ci16RecordingFormat | ChannelRecordingFormat : encoding === "ci8" ? unknownCi8Format(sampleRateHz) : {
      format: RECORDING_FORMAT, sampleEncoding: "unsigned-8-bit", sampleOrder: "interleaved-iq", bytesPerComplexSample: BYTES_PER_COMPLEX_SAMPLE,
      normalization: CU8_NORMALIZATION, gainDb: null,
    }),
    ...(global["browsersdr:rtl_input"] ? {rtlInput:global["browsersdr:rtl_input"]} : {}),
    ...(receiverLocation ? { receiverLocation } : {}),
    sampleRateHz,
    centerFrequencyHz,
    selectedChannelFrequencyHz,
    captureStartedAt,
    sampleCount,
    durationSeconds: sampleCount / sampleRateHz,
    source: "replay",
    mode: mode.mode,
    channelBandwidthHz: mode.bandwidthHz,
    squelch: mode.squelch,
    ...(mode.beatToneHz !== undefined ? { beatToneHz: mode.beatToneHz } : {}),
    ...(mode.srd ? { srd: mode.srd } : {}),
    ...(mode.textModem ? { textModem: mode.textModem } : {}),
    ...(mode.pocsag ? {pocsag:mode.pocsag} : {}),
    knownGaps: importGapAnnotations(root.annotations, knownGaps, sampleCount),
    stopReason: "import",
    provenance: "Imported from a local SigMF pair; original metadata text is retained without treating annotations as receiver settings.",
  }, byteLength, maximum);

  if (expectedHash) {
    const digest = binary instanceof Blob
      ? (await hashChunks(byteLength, async (start, end) => new Uint8Array(await binary.slice(start, end).arrayBuffer()), "sha512", byteLength, options.signal, options.onProgress)).digest
      : await sha512Hex(sourceBytes!);
    if (digest !== expectedHash) throw new Error("SigMF SHA-512 does not match the selected dataset.");
  }
  options.signal?.throwIfAborted();
  return {
    metadata,
    data: sourceBytes ? new Uint8Array(sourceBytes) : new Uint8Array(),
    ...(binary instanceof Blob ? { dataBlob: binary } : {}),
    importedSigmf: {
      metadataText,
      ...(optionalFilename(options.dataFilename, "dataset filename") ? { dataFilename: options.dataFilename } : {}),
      ...(optionalFilename(options.metadataFilename, "metadata filename") ? { metadataFilename: options.metadataFilename } : {}),
    },
  };
}

function importReceiverLocation(captures: unknown, globalPoint: unknown): ReceiverLocation | undefined {
  let first: ReceiverLocation | undefined;
  for (const value of captures as JsonObject[]) {
    const point = value["core:geolocation"] === undefined ? globalPoint : value["core:geolocation"];
    const provenance = value["browsersdr:receiver_location"];
    if (point === undefined && provenance === undefined) continue;
    if (!first && value !== (captures as JsonObject[])[0]) throw new Error("Replay currently requires a site at the first capture segment; moving location tracks are unsupported.");
    const p = object(point, "capture geolocation");
    if (p.type !== "Point" || !Array.isArray(p.coordinates) || p.coordinates.length < 2 || p.coordinates.length > 3) throw new Error("Invalid SigMF capture geolocation.");
    const site = validateReceiverLocation(provenance ?? { version: 1, longitude: p.coordinates[0], latitude: p.coordinates[1], ...(p.coordinates.length === 3 ? { altitudeMeters: p.coordinates[2] } : {}), source: "imported" });
    if (site.longitude !== p.coordinates[0] || site.latitude !== p.coordinates[1] || site.altitudeMeters !== p.coordinates[2]) throw new Error("SigMF site provenance disagrees with core:geolocation.");
    if (first && JSON.stringify(first) !== JSON.stringify(site)) throw new Error("Replay currently supports one acquisition site, not moving location tracks.");
    first = site;
  }
  return first;
}
