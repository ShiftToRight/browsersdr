import { isWidebandRate } from "./sourceCapabilities";
import { channelSampleRate } from "./sourceCapabilities";
import { CI8_RECORDING_FORMAT, validateCi8Format, type Ci8RecordingFormat, type HackrfRecordingFormat, type UnknownCi8RecordingFormat } from "./ci8Recording";
import { validateSourceRoute } from "./sourceCapabilities";
import { validateModeSampleRate } from "./receiverConfig";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SourceSessionMetadata } from "./types";
import { normalizeGain, normalizeModeSettings, planChannelTune, RECEIVER_MODES, type ReceiverMode } from "./receiverConfig";
import { validateSurveyCaptureContext, type SurveyCaptureContext } from "./fieldSurvey";

export const RECORDING_FORMAT = "browsersdr-cu8-v1" as const;
export const RECORDING_MAX_BYTES = 32 * 1024 * 1024;
export const BYTES_PER_COMPLEX_SAMPLE = 2;
export const RECORDING_METADATA_MAX_BYTES = 1024 * 1024;
export const REPLAY_MIN_SAMPLE_RATE_HZ = 8_000;
export const REPLAY_MAX_SAMPLE_RATE_HZ = 3_200_000;
export const LEGACY_CU8_NORMALIZATION = "float = byte / 128 - 0.995" as const;
export const SIGMF_CU8_NORMALIZATION = "float = (byte - 127.5) / 127.5" as const;
export type Cu8Normalization = typeof LEGACY_CU8_NORMALIZATION | typeof SIGMF_CU8_NORMALIZATION;

export interface RecordingGap {
  afterSample: number;
  missingSamples: number | null;
  reason: string;
}

export interface Cu8RecordingFormat {
  format: typeof RECORDING_FORMAT;
  sampleEncoding: "unsigned-8-bit";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 2;
  normalization: Cu8Normalization;
}
export type RecordingSampleFormat = Cu8RecordingFormat | Ci8RecordingFormat;
export const LEGACY_CU8_FORMAT: Cu8RecordingFormat = { format: RECORDING_FORMAT, sampleEncoding: "unsigned-8-bit", sampleOrder: "interleaved-iq", bytesPerComplexSample: 2, normalization: LEGACY_CU8_NORMALIZATION };
interface CommonRecordingMetadata {
  sampleRateHz: number;
  centerFrequencyHz: number;
  selectedChannelFrequencyHz: number;
  captureStartedAt: string;
  sampleCount: number;
  durationSeconds: number;
  mode: ReceiverMode;
  channelBandwidthHz: number;
  squelch: number;
  knownGaps: RecordingGap[];
  stopReason: "user" | "capacity" | "source-stop" | "metadata-change" | "import";
  provenance?: string;
  survey?: SurveyCaptureContext;
}

export type IqRecordingMetadata = CommonRecordingMetadata & (Cu8RecordingFormat & { source: "rtl-sdr" | "synthetic" | "replay"; gainDb: number | null }
  | HackrfRecordingFormat & { source: "hackrf" | "replay"; gainDb?: never }
  | UnknownCi8RecordingFormat & { source: "replay"; gainDb?: never });
/** Explicitly copy format fields, excluding mutable reception metadata. */
export function recordingSampleFormat(metadata: IqRecordingMetadata): RecordingSampleFormat {
  const { format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization } = metadata;
  if (metadata.format === RECORDING_FORMAT) return { format: RECORDING_FORMAT, sampleEncoding: "unsigned-8-bit", sampleOrder, bytesPerComplexSample, normalization: metadata.normalization };
  const { nativeSampleRateHz, effectiveSampleRateHz, adcSampleRateHz, fpgaDecimationFactor, hostResampling, rateEvidence, provenanceDetails, hardware, captureSettings } = metadata;
  return structuredClone({ format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization,
    nativeSampleRateHz, effectiveSampleRateHz, adcSampleRateHz, fpgaDecimationFactor, hostResampling, rateEvidence, provenanceDetails,
    ...(hardware ? { hardware, captureSettings } : {}),
  }) as Ci8RecordingFormat;
}

export interface IqRecording {
  metadata: IqRecordingMetadata;
  data: Uint8Array;
  importedSigmf?: {
    metadataText: string;
    dataFilename?: string;
    metadataFilename?: string;
  };
}

export interface RecordingStatus {
  state: "idle" | "recording" | "capacity-reached";
  bytes: number;
  maxBytes: number;
  sampleCount: number;
}

function assertFinitePositive(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Recording metadata has an invalid ${field}.`);
  }
}

export function recordingCapacitySeconds(sampleRateHz: number, maxBytes = RECORDING_MAX_BYTES): number {
  return maxBytes / (sampleRateHz * BYTES_PER_COMPLEX_SAMPLE);
}

export function floatToCu8(value: number): number {
  return Math.max(0, Math.min(255, Math.round((value + 0.995) * 128)));
}

export function decodeCu8(
  data: Uint8Array,
  normalization: string = LEGACY_CU8_NORMALIZATION,
): { I: Float32Array; Q: Float32Array } {
  if (data.byteLength % 2 !== 0) throw new Error("Recording is truncated: CU8 data must contain complete I/Q byte pairs.");
  if (![LEGACY_CU8_NORMALIZATION, SIGMF_CU8_NORMALIZATION].includes(normalization as Cu8Normalization)) throw new Error("Unsupported CU8 normalization.");
  const length = data.byteLength / 2;
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  const decode = normalization === SIGMF_CU8_NORMALIZATION
    ? (byte: number) => (byte - 127.5) / 127.5
    : (byte: number) => byte / 128 - 0.995;
  for (let index = 0; index < length; index += 1) {
    I[index] = decode(data[index * 2] ?? 0);
    Q[index] = decode(data[index * 2 + 1] ?? 0);
  }
  return { I, Q };
}

export function signedByteToFloat(byte: number): number { return (byte < 128 ? byte : byte - 256) / 128; }
export function decodeRecordingSamples(data: Uint8Array, format: RecordingSampleFormat): { I: Float32Array; Q: Float32Array } {
  validateSampleEncoding(format);
  if (format.format === RECORDING_FORMAT) return decodeCu8(data, format.normalization);
  if (data.byteLength % format.bytesPerComplexSample) throw new Error("CI8 data must contain complete I/Q pairs.");
  const I = new Float32Array(data.byteLength / format.bytesPerComplexSample), Q = new Float32Array(I.length);
  for (let n = 0; n < I.length; n++) { I[n] = signedByteToFloat(data[n * 2]!); Q[n] = signedByteToFloat(data[n * 2 + 1]!); }
  return { I, Q };
}
export function validateSampleEncoding(format: RecordingSampleFormat): void {
  if (format.sampleOrder !== "interleaved-iq" || format.bytesPerComplexSample !== 2) throw new Error("Unsupported I/Q layout.");
  if (format.format === RECORDING_FORMAT && format.sampleEncoding === "unsigned-8-bit" && [LEGACY_CU8_NORMALIZATION, SIGMF_CU8_NORMALIZATION].includes(format.normalization)) return;
  if (format.format === CI8_RECORDING_FORMAT && format.sampleEncoding === "signed-8-bit" && format.normalization === "float = signedByte / 128") return;
  throw new Error("Unsupported recording encoding or normalization.");
}

export class IqRecorder {
  private readonly recordingSource: IqRecordingMetadata["source"];
  private finished?: IqRecording;
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private tailUsed = 0;
  private gapMetadataBytes = 0;
  private capacityReached = false;
  private gaps: RecordingGap[] = [];

  constructor(
    private readonly session: SourceSessionMetadata,
    private captureStartedAt = new Date().toISOString(),
    private readonly maxBytes = RECORDING_MAX_BYTES,
    private readonly provenance?: string,
    private readonly survey?: SurveyCaptureContext,
    private readonly encoding: RecordingSampleFormat = LEGACY_CU8_FORMAT,
  ) {
    validateSampleEncoding(encoding);
    if (session.source === "hackrf" && encoding.format !== CI8_RECORDING_FORMAT) throw new Error("HackRF requires the native signed-I/Q recording path.");
    this.recordingSource = session.source;
    this.session = structuredClone(session); this.encoding = structuredClone(encoding); this.survey = survey ? structuredClone(survey) : undefined;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > RECORDING_MAX_BYTES) throw new Error("Recording capacity must be between one complex sample and 32 MiB.");
    if (encoding.format === CI8_RECORDING_FORMAT) validateCi8Format(encoding, session.source, session.actualSampleRateHz, session.hardwareCenterFrequencyHz);
  }

  setCaptureStartedAt(timestamp: string): void {
    if (this.bytes || this.finished) throw new Error("Capture timestamp is already fixed.");
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid capture timestamp.");
    this.captureStartedAt = timestamp;
  }

  appendCu8(input: ArrayBuffer | Uint8Array): void {
    if (this.encoding.format !== RECORDING_FORMAT) throw new Error("Cannot append CU8 to a CI8 recording.");
    this.appendBytes(input);
  }

  appendCi8(input: ArrayBuffer | Uint8Array): void {
    if (this.encoding.format !== CI8_RECORDING_FORMAT) throw new Error("Cannot append CI8 to a CU8 recording.");
    this.appendBytes(input);
  }

  private appendBytes(input: ArrayBuffer | Uint8Array): void {
    if (this.capacityReached || this.finished) return;
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (source.byteLength % this.encoding.bytesPerComplexSample) throw new Error("Native recording bytes must contain complete I/Q pairs.");
    const available = Math.max(0, this.maxBytes - this.bytes);
    const length = Math.floor(Math.min(source.byteLength, available) / this.encoding.bytesPerComplexSample) * this.encoding.bytesPerComplexSample;
    let offset = 0;
    while (offset < length) {
      let tail = this.chunks.at(-1);
      if (!tail || this.tailUsed === tail.length) {
        tail = new Uint8Array(Math.min(65_536, this.maxBytes - this.bytes));
        this.chunks.push(tail); this.tailUsed = 0;
      }
      const count = Math.min(length - offset, tail.length - this.tailUsed);
      tail.set(source.subarray(offset, offset + count), this.tailUsed);
      this.tailUsed += count; this.bytes += count; offset += count;
    }
    if (length < source.byteLength || this.bytes + 2 > this.maxBytes) this.capacityReached = true;
  }

  appendNormalized(block: Pick<SampleBlock, "I" | "Q">): void {
    if (this.encoding.format !== RECORDING_FORMAT) throw new Error("CI8 recording must preserve native bytes, not quantized floats.");
    if (this.capacityReached || this.finished) return;
    const length = Math.min(block.I.length, block.Q.length, Math.floor((this.maxBytes - this.bytes) / 2));
    const encoded = new Uint8Array(length * 2);
    for (let index = 0; index < length; index += 1) {
      encoded[index * 2] = floatToCu8(block.I[index] ?? 0);
      encoded[index * 2 + 1] = floatToCu8(block.Q[index] ?? 0);
    }
    this.appendCu8(encoded);
  }

  addGap(missingSamples: number | null, reason: string): void {
    if (this.finished) return;
    if (this.gaps.length >= 10_000) throw new Error("Recording contains too many gap entries.");
    if (missingSamples !== null && (!Number.isSafeInteger(missingSamples) || missingSamples < 0)) throw new Error("Invalid gap length.");
    if (typeof reason !== "string" || reason.length > 1024) throw new Error("Invalid gap reason.");
    const gapBytes = new TextEncoder().encode(JSON.stringify(reason)).byteLength + 128;
    if (this.gapMetadataBytes + gapBytes > RECORDING_METADATA_MAX_BYTES / 2) throw new Error("Recording gap metadata capacity reached.");
    this.gapMetadataBytes += gapBytes;
    this.gaps.push({ afterSample: this.bytes / 2, missingSamples, reason });
  }

  status(): RecordingStatus {
    return {
      state: this.capacityReached ? "capacity-reached" : "recording",
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      sampleCount: this.bytes / 2,
    };
  }

  finish(reason: IqRecordingMetadata["stopReason"] = "user"): IqRecording {
    if (this.finished) return this.finished;
    const data = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      const count = Math.min(chunk.byteLength, data.length - offset);
      data.set(chunk.subarray(0, count), offset);
      offset += count;
    }
    this.chunks.length = 0;
    const sampleCount = data.byteLength / this.encoding.bytesPerComplexSample;
    this.finished = {
      data,
      metadata: {
        ...structuredClone(this.encoding),
        sampleRateHz: this.session.actualSampleRateHz,
        centerFrequencyHz: this.session.hardwareCenterFrequencyHz,
        selectedChannelFrequencyHz: this.session.selectedChannelFrequencyHz,
        captureStartedAt: this.captureStartedAt,
        sampleCount,
        durationSeconds: sampleCount / this.session.actualSampleRateHz,
        source: this.recordingSource,
        mode: this.session.mode,
        channelBandwidthHz: this.session.channelBandwidthHz,
        squelch: this.session.squelch,
        ...(this.encoding.format === RECORDING_FORMAT ? { gainDb: this.session.gainDb } : {}),
        knownGaps: this.gaps.map((gap) => ({ ...gap })),
        stopReason: this.capacityReached ? "capacity" : reason,
        ...(this.provenance ? { provenance: this.provenance } : {}),
        ...(this.survey ? { survey: structuredClone(this.survey) } : {}),
      } as IqRecordingMetadata,
    };
    return this.finished;
  }
}

export function parseRecording(metadataText: string, binary: ArrayBuffer | Uint8Array): IqRecording {
  if (new TextEncoder().encode(metadataText).byteLength > RECORDING_METADATA_MAX_BYTES) throw new Error("Recording metadata exceeds the 1 MiB limit.");
  let value: unknown;
  try { value = JSON.parse(metadataText); } catch { throw new Error("Recording metadata is not valid JSON."); }
  const metadata = validateRecordingMetadata(value, binary.byteLength);
  // Validate before duplicating the bounded payload into replay-owned storage.
  const data = binary instanceof Uint8Array ? new Uint8Array(binary) : new Uint8Array(binary.slice(0));
  return { data, metadata };
}

export function validateRecordingMetadata(value: unknown, byteLength: number): IqRecordingMetadata {
  if (byteLength > RECORDING_MAX_BYTES) throw new Error("Replay file exceeds the 32 MiB limit.");
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 2 !== 0) {
    throw new Error("Recording is empty or truncated: CU8 data must contain complete I/Q byte pairs.");
  }
  if (!value || typeof value !== "object") throw new Error("Recording metadata must be a JSON object.");
  const metadata = value as Partial<IqRecordingMetadata>;
  validateSampleEncoding(metadata as RecordingSampleFormat);
  assertFinitePositive(metadata.sampleRateHz, "sample rate");
  assertFinitePositive(metadata.centerFrequencyHz, "center frequency");
  assertFinitePositive(metadata.selectedChannelFrequencyHz, "selected channel frequency");
  assertFinitePositive(metadata.channelBandwidthHz, "channel bandwidth");
  if (metadata.sampleRateHz < REPLAY_MIN_SAMPLE_RATE_HZ || (metadata.sampleRateHz > REPLAY_MAX_SAMPLE_RATE_HZ && !(metadata.format === CI8_RECORDING_FORMAT && isWidebandRate(metadata.sampleRateHz)))) {
    throw new Error("Replay supports sample rates from 8,000 to 3,200,000 samples/s, plus CI8 at 4,800,000 or 9,600,000 samples/s.");
  }
  if (metadata.centerFrequencyHz > Number.MAX_SAFE_INTEGER || metadata.selectedChannelFrequencyHz > Number.MAX_SAFE_INTEGER) {
    throw new Error("Recording frequency exceeds the supported numeric range.");
  }
  if (!RECEIVER_MODES.includes(metadata.mode as ReceiverMode)) throw new Error("Recording metadata has an unsupported receiver mode.");
  const settings = normalizeModeSettings({ mode: metadata.mode as ReceiverMode, bandwidthHz: metadata.channelBandwidthHz, squelch: metadata.squelch! });
  if (settings.bandwidthHz !== metadata.channelBandwidthHz || settings.squelch !== metadata.squelch) throw new Error("Recording has out-of-range mode settings.");
  if (metadata.format === CI8_RECORDING_FORMAT) {
    if ("gainDb" in metadata) throw new Error("CI8 metadata must not contain RTL gainDb.");
    validateCi8Format(metadata as Ci8RecordingFormat, metadata.source!, metadata.sampleRateHz, metadata.centerFrequencyHz);
    validateModeSampleRate(settings.mode, channelSampleRate(metadata.sampleRateHz));
    if (metadata.provenanceDetails?.originalSource === "hackrf") validateSourceRoute("hackrf", settings, metadata.sampleRateHz, metadata.selectedChannelFrequencyHz);
  } else {
    normalizeGain(metadata.gainDb!);
    if (!["rtl-sdr", "synthetic", "replay"].includes(metadata.source!)) throw new Error("Recording has an invalid source.");
  }
  if (planChannelTune(metadata.centerFrequencyHz, metadata.selectedChannelFrequencyHz, metadata.sampleRateHz, settings.bandwidthHz).hardwareRetuneRequired) {
    throw new Error("The selected channel lies outside the recorded capture span.");
  }
  if (!["user", "capacity", "source-stop", "metadata-change", "import"].includes(metadata.stopReason!)) throw new Error("Recording has an invalid stop reason.");
  if (metadata.provenance !== undefined && (typeof metadata.provenance !== "string" || metadata.provenance.length > 4096)) throw new Error("Recording has invalid provenance.");
  const survey = metadata.survey === undefined ? undefined : validateSurveyCaptureContext(metadata.survey);
  if (typeof metadata.captureStartedAt !== "string" || !Number.isFinite(Date.parse(metadata.captureStartedAt))) throw new Error("Recording metadata has an invalid capture start time.");
  if (!Number.isSafeInteger(metadata.sampleCount) || metadata.sampleCount !== byteLength / 2) {
    throw new Error("Recording is truncated or mismatched: metadata sample count does not match the binary file.");
  }
  if (!Number.isFinite(metadata.durationSeconds) || Math.abs(metadata.durationSeconds! - metadata.sampleCount! / metadata.sampleRateHz) > 0.5 / metadata.sampleRateHz) {
    throw new Error("Recording duration does not match its sample count and rate.");
  }
  if (!Array.isArray(metadata.knownGaps)) throw new Error("Recording metadata must contain a known-gaps array.");
  if (metadata.knownGaps.length > 10_000) throw new Error("Recording contains too many gap entries.");
  let previousPosition = -1;
  let missingSamples = 0;
  for (const gap of metadata.knownGaps) {
    if (!gap || !Number.isSafeInteger(gap.afterSample) || gap.afterSample < 0 || gap.afterSample > metadata.sampleCount) throw new Error("Recording metadata contains an invalid gap position.");
    if (gap.missingSamples !== null && (!Number.isSafeInteger(gap.missingSamples) || gap.missingSamples < 0)) throw new Error("Recording metadata contains an invalid gap length.");
    if (gap.afterSample < previousPosition) throw new Error("Recording gap positions must be sorted in ascending order.");
    previousPosition = gap.afterSample;
    missingSamples += gap.missingSamples ?? 0;
    if (typeof gap.reason !== "string" || gap.reason.length > 1024) throw new Error("Recording metadata contains an invalid gap reason.");
  }
  if ((metadata.sampleCount! + missingSamples) / metadata.sampleRateHz > 3600) throw new Error("Replay duration including known gaps exceeds one hour.");
  return structuredClone({ ...metadata, ...(survey ? { survey } : {}), knownGaps: metadata.knownGaps.map((gap) => ({ ...gap })) }) as IqRecordingMetadata;
}

export function recordingMetadataJson(recording: IqRecording): string {
  const text = `${JSON.stringify(recording.metadata, null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > RECORDING_METADATA_MAX_BYTES) throw new Error("Recording metadata exceeds the 1 MiB limit.");
  return text;
}
