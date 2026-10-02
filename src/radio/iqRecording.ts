import { ChannelRecordingWorker } from "./channelRecordingWorker";
import { CHANNEL_RECORDING_FORMAT, ChannelCaptureFilter, planChannelCapture, validateChannelRecording, type ChannelRecordingFormat, type RecordingOptions } from "./channelRecording";
import { CHANNEL_MAX_SAMPLES } from "./widebandChannel";
import { BLADERF_SC16_RECORDING_FORMAT, BLADERF_SC16_NORMALIZATION, validateBladeRfSc16Format, type BladeRfSc16RecordingFormat } from "./bladerfRecording";
import { isWidebandRate } from "./sourceCapabilities";
import { channelSampleRate } from "./sourceCapabilities";
import { CI8_RECORDING_FORMAT, validateCi8Format, type Ci8RecordingFormat, type HackrfRecordingFormat, type UnknownCi8RecordingFormat } from "./ci8Recording";
import { CI16_RECORDING_FORMAT, validateUsrpB205Ci16Format, type UsrpB205Ci16RecordingFormat } from "./ci16Recording";
import { validateSourceRoute } from "./sourceCapabilities";
import { validateModeSampleRate } from "./receiverConfig";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import {
  CU8_NORMALIZATION,
  decodeCu8Into,
  floatToCu8Byte,
} from "./cu8";
import type { SourceSessionMetadata } from "./types";
import { normalizeGain, normalizeModeSettings, planChannelTune, RECEIVER_MODES, type ReceiverMode } from "./receiverConfig";
import { validateSurveyCaptureContext, type SurveyCaptureContext } from "./fieldSurvey";
import type { SrdModeSettings } from "../srd/settings";
import {
  OpfsRecordingSpool,
  STREAMING_RECORDING_MAX_BYTES,
  recordingStorageUsable,
} from "./recordingSpool";

export const RECORDING_FORMAT = "browsersdr-cu8-v1" as const;
export const RECORDING_MAX_BYTES = 32 * 1024 * 1024;
export const BYTES_PER_COMPLEX_SAMPLE = 2;
export const RECORDING_METADATA_MAX_BYTES = 1024 * 1024;
export const REPLAY_MIN_SAMPLE_RATE_HZ = 8_000;
export const REPLAY_MAX_SAMPLE_RATE_HZ = 3_200_000;
export { CU8_NORMALIZATION } from "./cu8";
export type Cu8Normalization = typeof CU8_NORMALIZATION;

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
export type RecordingSampleFormat = Cu8RecordingFormat | Ci8RecordingFormat | UsrpB205Ci16RecordingFormat | BladeRfSc16RecordingFormat | ChannelRecordingFormat;
export const CU8_FORMAT: Cu8RecordingFormat = { format: RECORDING_FORMAT, sampleEncoding: "unsigned-8-bit", sampleOrder: "interleaved-iq", bytesPerComplexSample: 2, normalization: CU8_NORMALIZATION };
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
  /** Optional for backwards compatibility with recordings created before CW. */
  beatToneHz?: number;
  /** Optional for backwards compatibility with recordings created before SRD. */
  srd?: SrdModeSettings;
  knownGaps: RecordingGap[];
  stopReason: "user" | "capacity" | "source-stop" | "metadata-change" | "import";
  provenance?: string;
  captureWarning?: string;
  survey?: SurveyCaptureContext;
}

export type IqRecordingMetadata = CommonRecordingMetadata & (Cu8RecordingFormat & { source: "rtl-sdr" | "synthetic" | "replay"; gainDb: number | null }
  | HackrfRecordingFormat & { source: "hackrf" | "replay"; gainDb?: never }
  | UnknownCi8RecordingFormat & { source: "replay"; gainDb?: never }
  | UsrpB205Ci16RecordingFormat & { source: "usrp-b205" | "replay"; gainDb?: never }
  | BladeRfSc16RecordingFormat & { source: "bladerf" | "replay"; gainDb?: never }
  | ChannelRecordingFormat & { source: SourceSessionMetadata["source"] });
/** Fixed DSP routing uses the nominal profile; capture timing retains RFIC readback. */
export function recordingRoutingSampleRate(metadata: IqRecordingMetadata): number {
  return metadata.format === CHANNEL_RECORDING_FORMAT ? metadata.channelCapture.dspSampleRateHz : metadata.format === BLADERF_SC16_RECORDING_FORMAT ? metadata.nativeSampleRateHz : metadata.sampleRateHz;
}
/** Explicitly copy format fields, excluding mutable reception metadata. */
export function recordingSampleFormat(metadata: IqRecordingMetadata): RecordingSampleFormat {
  if (metadata.format === CHANNEL_RECORDING_FORMAT) {
    const { format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization, provenanceDetails, channelCapture } = metadata;
    return structuredClone({ format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization, provenanceDetails, channelCapture });
  }
  if (metadata.format === RECORDING_FORMAT) return { format: RECORDING_FORMAT, sampleEncoding: "unsigned-8-bit", sampleOrder: metadata.sampleOrder, bytesPerComplexSample: 2, normalization: metadata.normalization };
  if (metadata.format === BLADERF_SC16_RECORDING_FORMAT) {
    const { format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization, nativeSampleRateHz, effectiveSampleRateHz, rateEvidence, hardware, provenanceDetails } = metadata;
    return structuredClone({ format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization, nativeSampleRateHz, effectiveSampleRateHz, rateEvidence, hardware, provenanceDetails });
  }
  if (metadata.format === CI16_RECORDING_FORMAT) {
    const { nativeSampleRateHz, rateEvidence, hardware, provenanceDetails } = metadata;
    return structuredClone({ format: metadata.format, sampleEncoding: metadata.sampleEncoding, sampleOrder: metadata.sampleOrder, bytesPerComplexSample: metadata.bytesPerComplexSample, normalization: metadata.normalization,
      nativeSampleRateHz, rateEvidence, hardware, provenanceDetails });
  }
  const { format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization } = metadata;
  const { nativeSampleRateHz, effectiveSampleRateHz, adcSampleRateHz, fpgaDecimationFactor, hostResampling, rateEvidence, provenanceDetails, hardware, captureSettings } = metadata;
  return structuredClone({ format, sampleEncoding, sampleOrder, bytesPerComplexSample, normalization,
    nativeSampleRateHz, effectiveSampleRateHz, adcSampleRateHz, fpgaDecimationFactor, hostResampling, rateEvidence, provenanceDetails,
    ...(hardware ? { hardware, captureSettings } : {}),
  }) as Ci8RecordingFormat;
}

export interface IqRecording {
  metadata: IqRecordingMetadata;
  data: Uint8Array;
  /** File-backed capture snapshot. `data` remains the legacy in-memory path. */
  dataBlob?: Blob | Promise<Blob>;
  /** Releases file-backed capture storage after all export readers finish. */
  releaseData?: () => Promise<void>;
  importedSigmf?: {
    metadataText: string;
    dataFilename?: string;
    metadataFilename?: string;
  };
}

export function recordingDataByteLength(recording: IqRecording): number {
  return recording.dataBlob
    ? recording.metadata.sampleCount * recording.metadata.bytesPerComplexSample
    : recording.data.byteLength;
}

export async function recordingDataBlob(recording: IqRecording): Promise<Blob> {
  return recording.dataBlob
    ? await recording.dataBlob
    : new Blob([recording.data as Uint8Array<ArrayBuffer>], {
        type: "application/octet-stream",
      });
}

export type RecordingStorageMode = "memory" | "opfs";

export function preferredRecordingStorageMode(override?: RecordingStorageMode): RecordingStorageMode {
  if (override) return override;
  return recordingStorageUsable() ? "opfs" : "memory";
}

export interface RecordingStatus {
  state: "idle" | "recording" | "capacity-reached";
  bytes: number;
  maxBytes: number;
  sampleCount: number;
  storage?: RecordingStorageMode;
  sampleRateHz?: number;
  captureCurrentChannel?: boolean;
}

function assertFinitePositive(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Recording metadata has an invalid ${field}.`);
  }
}

export function recordingCapacitySeconds(sampleRateHz: number, maxBytes = RECORDING_MAX_BYTES, bytesPerComplexSample = BYTES_PER_COMPLEX_SAMPLE): number {
  return maxBytes / (sampleRateHz * bytesPerComplexSample);
}

export function floatToCu8(value: number): number {
  return floatToCu8Byte(value);
}

export function decodeCu8(data: Uint8Array): { I: Float32Array; Q: Float32Array } {
  if (data.byteLength % 2 !== 0) throw new Error("Recording is truncated: CU8 data must contain complete I/Q byte pairs.");
  const length = data.byteLength / 2;
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  decodeCu8Into(data, I, Q);
  return { I, Q };
}

export function signedByteToFloat(byte: number): number { return (byte < 128 ? byte : byte - 256) / 128; }
export function decodeRecordingSamples(data: Uint8Array, format: RecordingSampleFormat): { I: Float32Array; Q: Float32Array } {
  validateSampleEncoding(format);
  if (format.format === RECORDING_FORMAT) return decodeCu8(data);
  if (data.byteLength % format.bytesPerComplexSample) throw new Error("CI8 data must contain complete I/Q pairs.");
  const I = new Float32Array(data.byteLength / format.bytesPerComplexSample), Q = new Float32Array(I.length);
  if (format.format === CI16_RECORDING_FORMAT || format.format === BLADERF_SC16_RECORDING_FORMAT || (format.format === CHANNEL_RECORDING_FORMAT && format.bytesPerComplexSample === 4)) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let n = 0; n < I.length; n++) {
      const scale = format.format === CHANNEL_RECORDING_FORMAT ? 1 / 32768 : format.format === BLADERF_SC16_RECORDING_FORMAT ? 1 / 2048 : 0.9999997558594347 / 32767;
      I[n] = view.getInt16(n * 4, true) * scale;
      Q[n] = view.getInt16(n * 4 + 2, true) * scale;
    }
    return { I, Q };
  }
  for (let n = 0; n < I.length; n++) { I[n] = signedByteToFloat(data[n * 2]!); Q[n] = signedByteToFloat(data[n * 2 + 1]!); }
  return { I, Q };
}
export function validateSampleEncoding(format: RecordingSampleFormat): void {
  if (format.sampleOrder !== "interleaved-iq") throw new Error("Unsupported I/Q layout.");
  if (format.format === RECORDING_FORMAT && format.sampleEncoding === "unsigned-8-bit" && format.normalization === CU8_NORMALIZATION) return;
  if (format.format === CI8_RECORDING_FORMAT && format.bytesPerComplexSample === 2 && format.sampleEncoding === "signed-8-bit" && format.normalization === "float = signedByte / 128") return;
  if (format.format === BLADERF_SC16_RECORDING_FORMAT && format.bytesPerComplexSample === 4 && format.sampleEncoding === "signed-16-bit-little-endian" && format.normalization === BLADERF_SC16_NORMALIZATION) return;
  if (format.format === CI16_RECORDING_FORMAT && format.bytesPerComplexSample === 4 && format.sampleEncoding === "signed-16-bit-little-endian") return;
  if (format.format === CHANNEL_RECORDING_FORMAT && ((format.bytesPerComplexSample === 2 && format.sampleEncoding === "signed-8-bit" && format.normalization === "float = signedByte / 128") || (format.bytesPerComplexSample === 4 && format.sampleEncoding === "signed-16-bit-little-endian" && format.normalization === "float = int16 / 32768"))) return;
  throw new Error("Unsupported recording encoding or normalization.");
}

export class IqRecorder {
  private readonly recordingSource: IqRecordingMetadata["source"];
  private finished?: IqRecording;
  private storage?: Uint8Array<ArrayBuffer>;
  private bytes = 0;
  private gapMetadataBytes = 0;
  private capacityReached = false;
  private captureWarning?: string;
  private gaps: RecordingGap[] = [];
  private readonly maxBytes: number;
  private readonly spool?: OpfsRecordingSpool;
  private readonly inputEncoding: RecordingSampleFormat;
  private readonly channelFilter?: ChannelCaptureFilter;
  private gapRemainder = 0;
  private channelWorker?: ChannelRecordingWorker;
  private channelInputSamples = 0;
  private storedChannelBytes = 0;

  constructor(
    private readonly session: SourceSessionMetadata,
    private captureStartedAt = new Date().toISOString(),
    maxBytes: number | undefined = undefined,
    private readonly provenance?: string,
    private readonly survey?: SurveyCaptureContext,
    private readonly encoding: RecordingSampleFormat = CU8_FORMAT,
    storageMode: RecordingStorageMode = "memory",
    options: RecordingOptions = {},
  ) {
    validateSampleEncoding(encoding);
    if (session.source === "bladerf" && encoding.format !== BLADERF_SC16_RECORDING_FORMAT) throw new Error("bladeRF requires unchanged native SC16 Q11 recording bytes.");
    if (session.source === "hackrf" && encoding.format !== CI8_RECORDING_FORMAT) throw new Error("HackRF requires the native signed-I/Q recording path.");
    if (session.source === "usrp-b205" && encoding.format !== CI16_RECORDING_FORMAT) throw new Error("USRP B205-mini requires the native CI16 recording path.");
    const channelPlan = options.captureCurrentChannel
      ? planChannelCapture(session, encoding.format === CHANNEL_RECORDING_FORMAT ? encoding.channelCapture.dspSampleRateHz : undefined)
      : undefined;
    this.maxBytes = maxBytes ?? (storageMode === "opfs" ? STREAMING_RECORDING_MAX_BYTES : RECORDING_MAX_BYTES);
    this.recordingSource = session.source;
    this.session = structuredClone(session); this.encoding = structuredClone(encoding); this.survey = survey ? structuredClone(survey) : undefined;
    const maximum = storageMode === "opfs" ? STREAMING_RECORDING_MAX_BYTES : RECORDING_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < this.encoding.bytesPerComplexSample || this.maxBytes > maximum) throw new Error(`Recording capacity must be between one complex sample and ${maximum} bytes.`);
    if (encoding.format === CI8_RECORDING_FORMAT) validateCi8Format(encoding, session.source, session.actualSampleRateHz, session.hardwareCenterFrequencyHz);
    if (encoding.format === BLADERF_SC16_RECORDING_FORMAT) validateBladeRfSc16Format(encoding, session.source, session.actualSampleRateHz, session.hardwareCenterFrequencyHz);
    if (encoding.format === CI16_RECORDING_FORMAT) validateUsrpB205Ci16Format(encoding, session.source, session.actualSampleRateHz, session.hardwareCenterFrequencyHz);
    this.inputEncoding = this.encoding;
    if (channelPlan) {
      const plan = channelPlan;
      this.channelFilter = new ChannelCaptureFilter(plan);
      this.maxBytes = Math.min(this.maxBytes, Math.floor(plan.outputSampleRateHz * 3600) * encoding.bytesPerComplexSample);
      const wide = encoding.bytesPerComplexSample === 4;
      this.encoding = { format: CHANNEL_RECORDING_FORMAT, sampleEncoding: wide ? "signed-16-bit-little-endian" : "signed-8-bit",
        sampleOrder: "interleaved-iq", bytesPerComplexSample: wide ? 4 : 2,
        normalization: wide ? "float = int16 / 32768" : "float = signedByte / 128",
        provenanceDetails: { originalSource: session.source, datasetProcessing: "frequency-shift-fir-decimate-v1" }, channelCapture: plan };
      this.session = { ...this.session, actualSampleRateHz: plan.outputSampleRateHz, hardwareCenterFrequencyHz: plan.channelFrequencyHz };
      if (typeof Worker !== "undefined") {
        this.channelWorker = new ChannelRecordingWorker(plan, this.inputEncoding, this.encoding.bytesPerComplexSample, bytes => {
          if (this.spool) {
            if (!this.spool.appendOwned(bytes)) throw new Error("Channel recording storage queue is full or failed.");
          } else {
            this.storage ??= new Uint8Array(this.maxBytes);
            this.storage.set(bytes, this.storedChannelBytes);
          }
          this.storedChannelBytes += bytes.byteLength;
        });
      }
    }
    this.spool = storageMode === "opfs" ? new OpfsRecordingSpool() : undefined;
  }

  setCaptureStartedAt(timestamp: string): void {
    if (this.bytes || this.finished) throw new Error("Capture timestamp is already fixed.");
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid capture timestamp.");
    this.captureStartedAt = timestamp;
  }

  appendCu8(input: ArrayBuffer | Uint8Array): void {
    if (this.inputEncoding.format !== RECORDING_FORMAT) throw new Error("Cannot append CU8 to a CI8 recording.");
    if (this.channelFilter) { this.appendChannelBytes(input); return; }
    this.appendBytes(input);
  }

  appendCi8(input: ArrayBuffer | Uint8Array): void {
    if (this.inputEncoding.format !== CI8_RECORDING_FORMAT && !(this.inputEncoding.format === CHANNEL_RECORDING_FORMAT && this.inputEncoding.bytesPerComplexSample === 2)) throw new Error("Cannot append CI8 to a CU8 recording.");
    if (this.channelFilter) { this.appendChannelBytes(input); return; }
    this.appendBytes(input);
  }

  appendCi16(input: ArrayBuffer | Uint8Array): void {
    if (this.inputEncoding.format !== CI16_RECORDING_FORMAT && this.inputEncoding.format !== BLADERF_SC16_RECORDING_FORMAT && !(this.inputEncoding.format === CHANNEL_RECORDING_FORMAT && this.inputEncoding.bytesPerComplexSample === 4)) throw new Error("Cannot append CI16 to a non-CI16 recording.");
    if (this.channelFilter) { this.appendChannelBytes(input); return; }
    this.appendBytes(input);
  }

  appendBladeRfSc16(input: ArrayBuffer | Uint8Array): void {
    if (this.inputEncoding.format !== BLADERF_SC16_RECORDING_FORMAT) throw new Error("Cannot append bladeRF Q11 to a different recording format.");
    if (this.channelFilter) { this.appendChannelBytes(input); return; }
    this.appendBytes(input);
  }

  /** Convert native B205 Q/I words to SigMF ci16_le I/Q without scaling. */
  appendUsrpSc16(input: ArrayBuffer | Uint8Array): void {
    if (this.inputEncoding.format !== CI16_RECORDING_FORMAT) throw new Error("Cannot append USRP SC16 to a non-CI16 recording.");
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (source.byteLength % 4) throw new Error("USRP SC16 bytes must contain complete Q/I word pairs.");
    const iq = new Uint8Array(source.byteLength);
    for (let offset = 0; offset < source.byteLength; offset += 4) {
      iq[offset] = source[offset + 2]!;
      iq[offset + 1] = source[offset + 3]!;
      iq[offset + 2] = source[offset]!;
      iq[offset + 3] = source[offset + 1]!;
    }
    if (this.channelFilter) { this.appendChannelBytes(iq); return; }
    this.appendBytes(iq, true);
  }

  private appendBytes(input: ArrayBuffer | Uint8Array, owned = false): void {
    if (this.capacityReached || this.finished) return;
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (source.byteLength % this.encoding.bytesPerComplexSample) throw new Error("Native recording bytes must contain complete I/Q pairs.");
    const available = Math.max(0, this.maxBytes - this.bytes);
    const length = Math.floor(Math.min(source.byteLength, available) / this.encoding.bytesPerComplexSample) * this.encoding.bytesPerComplexSample;
    if (this.spool) {
      const accepted = owned && length === source.byteLength && source.buffer instanceof ArrayBuffer
        ? this.spool.appendOwned(source as Uint8Array<ArrayBuffer>)
        : this.spool.append(source.subarray(0, length));
      if (!accepted) {
        this.captureWarning = "Recording stopped early because browser storage could not keep up. The accepted samples are retained if storage succeeds.";
        this.capacityReached = true;
        return;
      }
    } else {
      this.storage ??= new Uint8Array(this.maxBytes);
      this.storage.set(source.subarray(0, length), this.bytes);
    }
    this.bytes += length;
    if (length < source.byteLength || this.bytes + this.encoding.bytesPerComplexSample > this.maxBytes) this.capacityReached = true;
  }

  private appendChannelBytes(input: ArrayBuffer | Uint8Array): void {
    if (this.capacityReached || this.finished) return;
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const stride = this.inputEncoding.bytesPerComplexSample;
    if (bytes.byteLength % stride) throw new Error("Channel input must contain complete I/Q pairs.");
    if (this.channelWorker) {
      this.enqueueChannelWorker(bytes.length / stride, limit => this.channelWorker!.appendBytes(bytes, limit));
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += CHANNEL_MAX_SAMPLES * stride) {
      this.appendChannelNormalized(decodeRecordingSamples(bytes.subarray(offset, offset + CHANNEL_MAX_SAMPLES * stride), this.inputEncoding));
    }
  }

  private enqueueChannelWorker(inputSamples: number, append: (outputLimit: number) => boolean): void {
    if (this.capacityReached || this.finished) return;
    const decimation = this.channelFilter!.plan.decimation;
    const outputSamples = Math.floor((this.channelInputSamples + inputSamples) / decimation) - Math.floor(this.channelInputSamples / decimation);
    const count = Math.min(outputSamples, Math.floor((this.maxBytes - this.bytes) / this.encoding.bytesPerComplexSample));
    if (!append(count)) {
      this.captureWarning = "Recording stopped early because channel processing could not keep up. The accepted samples are retained; reduce the receiver sample rate or CPU load before recording again.";
      this.capacityReached = true; return;
    }
    this.channelInputSamples += inputSamples;
    this.bytes += count * this.encoding.bytesPerComplexSample;
    if (count < outputSamples || this.bytes + this.encoding.bytesPerComplexSample > this.maxBytes) this.capacityReached = true;
  }

  private appendChannelNormalized(block: Pick<SampleBlock, "I" | "Q">): void {
    if (!this.channelFilter || this.capacityReached || this.finished) return;
    if (block.I.length !== block.Q.length) throw new Error("Channel I/Q arrays must have equal lengths.");
    if (this.channelWorker) {
      this.enqueueChannelWorker(block.I.length, limit => this.channelWorker!.appendNormalized(block.I, block.Q, limit));
      return;
    }
    for (let start = 0; start < block.I.length; start += CHANNEL_MAX_SAMPLES) {
      const reduced = this.channelFilter.process(block.I.subarray(start, start + CHANNEL_MAX_SAMPLES), block.Q.subarray(start, start + CHANNEL_MAX_SAMPLES));
      const stride = this.encoding.bytesPerComplexSample;
      const bytes = new Uint8Array(reduced.I.length * stride);
      const view = new DataView(bytes.buffer);
      for (let n = 0; n < reduced.I.length; n++) {
        if (stride === 4) {
          view.setInt16(n * 4, Math.max(-32768, Math.min(32767, Math.round(reduced.I[n]! * 32768))), true);
          view.setInt16(n * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(reduced.Q[n]! * 32768))), true);
        } else {
          view.setInt8(n * 2, Math.max(-128, Math.min(127, Math.round(reduced.I[n]! * 128))));
          view.setInt8(n * 2 + 1, Math.max(-128, Math.min(127, Math.round(reduced.Q[n]! * 128))));
        }
      }
      this.appendBytes(bytes, true);
    }
  }

  appendNormalized(block: Pick<SampleBlock, "I" | "Q">): void {
    if (this.channelFilter) { this.appendChannelNormalized(block); return; }
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
    if (this.channelFilter) {
      if (missingSamples !== null) {
        const scaled = (missingSamples + this.gapRemainder) / this.channelFilter.plan.decimation;
        missingSamples = Math.floor(scaled);
        this.gapRemainder = (scaled - missingSamples) * this.channelFilter.plan.decimation;
      } else this.gapRemainder = 0;
      this.channelFilter.reset();
      this.channelWorker?.reset();
      this.channelInputSamples = 0;
    }
    this.gaps.push({ afterSample: this.bytes / this.encoding.bytesPerComplexSample, missingSamples, reason });
  }

  status(): RecordingStatus {
    if (this.spool?.status.failed || this.channelWorker?.failed) this.capacityReached = true;
    return {
      state: this.capacityReached ? "capacity-reached" : "recording",
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      sampleCount: this.bytes / this.encoding.bytesPerComplexSample,
      storage: this.spool ? "opfs" : "memory",
      sampleRateHz: this.session.actualSampleRateHz,
      captureCurrentChannel: Boolean(this.channelFilter),
    };
  }

  finish(reason: IqRecordingMetadata["stopReason"] = "user"): IqRecording {
    if (this.finished) return this.finished;
    // Full captures need no consolidation. Shrink short captures with the native
    // transfer API where available, preserving the exact-buffer legacy contract.
    const storage = this.storage;
    const buffer = storage?.buffer as (ArrayBuffer & { transferToFixedLength?(length: number): ArrayBuffer }) | undefined;
    const data = this.channelWorker || !storage ? new Uint8Array(0) : storage.length === this.bytes ? storage
      : typeof buffer?.transferToFixedLength === "function"
        ? new Uint8Array(buffer.transferToFixedLength(this.bytes)) : storage.slice(0, this.bytes);
    if (!this.channelWorker) this.storage = undefined;
    const sampleCount = this.bytes / this.encoding.bytesPerComplexSample;
    const dataBlob = this.channelWorker ? this.channelWorker.finish().then(async () => {
      if (this.storedChannelBytes !== this.bytes) throw new Error("Channel recording worker sample count mismatch.");
      if (this.spool) return this.spool.finish(this.bytes);
      const blob = new Blob([this.storage?.slice(0, this.bytes) ?? new Uint8Array(0)]);
      this.storage = undefined;
      return blob;
    }) : this.spool?.finish(this.bytes);
    // Data failures are consumed by the export coordinator, which may run later.
    void dataBlob?.catch(() => undefined);
    this.finished = {
      data,
      ...(dataBlob ? { dataBlob } : {}),
      ...(this.spool ? { releaseData: async () => { await this.channelWorker?.finish().catch(() => undefined); await this.spool!.release(); } } : {}),
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
        ...(this.session.beatToneHz !== undefined ? { beatToneHz: this.session.beatToneHz } : {}),
        ...(this.session.srd !== undefined ? { srd: structuredClone(this.session.srd) } : {}),
        ...(this.encoding.format === RECORDING_FORMAT ? { gainDb: this.session.gainDb } : {}),
        knownGaps: this.gaps.map((gap) => ({ ...gap })),
        stopReason: this.capacityReached ? "capacity" : reason,
        ...(this.captureWarning ? { captureWarning: this.captureWarning } : {}),
        ...(this.provenance ? { provenance: this.channelFilter ? `Processed channel capture. Input source context: ${this.provenance}` : this.provenance } : {}),
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

export function validateRecordingMetadata(
  value: unknown,
  byteLength: number,
  maximumBytes = RECORDING_MAX_BYTES,
): IqRecordingMetadata {
  if (byteLength > maximumBytes) {
    const limit = maximumBytes === RECORDING_MAX_BYTES
      ? "32 MiB"
      : maximumBytes === STREAMING_RECORDING_MAX_BYTES
        ? "2 GiB"
        : `${maximumBytes}-byte`;
    throw new Error(`Recording exceeds the ${limit} limit.`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 2 !== 0) {
    throw new Error("Recording is empty or truncated: data must contain complete complex samples.");
  }
  if (!value || typeof value !== "object") throw new Error("Recording metadata must be a JSON object.");
  const metadata = value as Partial<IqRecordingMetadata>;
  validateSampleEncoding(metadata as RecordingSampleFormat);
  assertFinitePositive(metadata.sampleRateHz, "sample rate");
  assertFinitePositive(metadata.centerFrequencyHz, "center frequency");
  assertFinitePositive(metadata.selectedChannelFrequencyHz, "selected channel frequency");
  assertFinitePositive(metadata.channelBandwidthHz, "channel bandwidth");
  const widebandFormat = ([CI8_RECORDING_FORMAT, CI16_RECORDING_FORMAT, BLADERF_SC16_RECORDING_FORMAT] as string[]).includes(metadata.format!);
  const routingRate = recordingRoutingSampleRate(metadata as IqRecordingMetadata);
  if (metadata.sampleRateHz < REPLAY_MIN_SAMPLE_RATE_HZ || (metadata.sampleRateHz > REPLAY_MAX_SAMPLE_RATE_HZ
    && (!widebandFormat || !isWidebandRate(routingRate)))) {
    throw new Error("Recording sample rate is outside the supported range.");
  }
  if (metadata.centerFrequencyHz > Number.MAX_SAFE_INTEGER || metadata.selectedChannelFrequencyHz > Number.MAX_SAFE_INTEGER) {
    throw new Error("Recording frequency exceeds the supported numeric range.");
  }
  if (!RECEIVER_MODES.includes(metadata.mode as ReceiverMode)) throw new Error("Recording metadata has an unsupported receiver mode.");
  const settings = normalizeModeSettings({ mode: metadata.mode as ReceiverMode, bandwidthHz: metadata.channelBandwidthHz, squelch: metadata.squelch!, beatToneHz: metadata.beatToneHz, srd: metadata.srd });
  if (settings.bandwidthHz !== metadata.channelBandwidthHz || settings.squelch !== metadata.squelch || (metadata.beatToneHz !== undefined && settings.beatToneHz !== metadata.beatToneHz)) throw new Error("Recording has out-of-range mode settings.");
  if (metadata.format === CHANNEL_RECORDING_FORMAT) {
    validateChannelRecording(metadata as ChannelRecordingFormat, metadata.sampleRateHz, metadata.centerFrequencyHz, metadata.channelBandwidthHz);
    if (!["rtl-sdr", "hackrf", "bladerf", "usrp-b205", "synthetic", "replay"].includes(metadata.source!)) throw new Error("Recording has an invalid source.");
    validateModeSampleRate(settings.mode, routingRate);
  } else if (metadata.format === CI8_RECORDING_FORMAT) {
    if ("gainDb" in metadata) throw new Error("CI8 metadata must not contain RTL gainDb.");
    validateCi8Format(metadata as Ci8RecordingFormat, metadata.source!, metadata.sampleRateHz, metadata.centerFrequencyHz);
    validateModeSampleRate(settings.mode, channelSampleRate(metadata.sampleRateHz));
    if (metadata.provenanceDetails?.originalSource === "hackrf") validateSourceRoute("hackrf", settings, metadata.sampleRateHz, metadata.selectedChannelFrequencyHz);
  } else if (metadata.format === BLADERF_SC16_RECORDING_FORMAT) {
    if ("gainDb" in metadata) throw new Error("bladeRF metadata must use its recorded native gain evidence.");
    validateBladeRfSc16Format(metadata as BladeRfSc16RecordingFormat, metadata.source!, metadata.sampleRateHz, metadata.centerFrequencyHz);
    validateModeSampleRate(settings.mode, channelSampleRate(routingRate));
    validateSourceRoute("bladerf", settings, routingRate, metadata.selectedChannelFrequencyHz);
  } else if (metadata.format === CI16_RECORDING_FORMAT) {
    if ("gainDb" in metadata) throw new Error("CI16 metadata must not contain RTL gainDb.");
    validateUsrpB205Ci16Format(metadata as UsrpB205Ci16RecordingFormat, metadata.source!, metadata.sampleRateHz, metadata.centerFrequencyHz);
    validateModeSampleRate(settings.mode, channelSampleRate(metadata.sampleRateHz));
    validateSourceRoute("usrp-b205", settings, metadata.sampleRateHz, metadata.selectedChannelFrequencyHz);
  } else {
    normalizeGain(metadata.gainDb!);
    if (!["rtl-sdr", "synthetic", "replay"].includes(metadata.source!)) throw new Error("Recording has an invalid source.");
  }
  if (planChannelTune(metadata.centerFrequencyHz, metadata.selectedChannelFrequencyHz, routingRate, settings.bandwidthHz).hardwareRetuneRequired) {
    throw new Error("The selected channel lies outside the recorded capture span.");
  }
  if (!["user", "capacity", "source-stop", "metadata-change", "import"].includes(metadata.stopReason!)) throw new Error("Recording has an invalid stop reason.");
  if (metadata.captureWarning !== undefined && (typeof metadata.captureWarning !== "string" || metadata.captureWarning.length > 1024)) throw new Error("Recording has invalid capture warning.");
  if (metadata.provenance !== undefined && (typeof metadata.provenance !== "string" || metadata.provenance.length > 4096)) throw new Error("Recording has invalid provenance.");
  const survey = metadata.survey === undefined ? undefined : validateSurveyCaptureContext(metadata.survey);
  if (typeof metadata.captureStartedAt !== "string" || !Number.isFinite(Date.parse(metadata.captureStartedAt))) throw new Error("Recording metadata has an invalid capture start time.");
  if (!Number.isSafeInteger(metadata.sampleCount) || metadata.sampleCount !== byteLength / metadata.bytesPerComplexSample!) {
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
  return structuredClone({ ...metadata, ...(settings.srd ? { srd: settings.srd } : {}), ...(survey ? { survey } : {}), knownGaps: metadata.knownGaps.map((gap) => ({ ...gap })) }) as IqRecordingMetadata;
}

export function recordingMetadataJson(recording: IqRecording): string {
  const text = `${JSON.stringify(recording.metadata, null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > RECORDING_METADATA_MAX_BYTES) throw new Error("Recording metadata exceeds the 1 MiB limit.");
  return text;
}
