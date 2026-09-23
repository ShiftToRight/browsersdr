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

export interface RecordingGap {
  afterSample: number;
  missingSamples: number | null;
  reason: string;
}

export interface IqRecordingMetadata {
  format: typeof RECORDING_FORMAT;
  sampleEncoding: "unsigned-8-bit";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 2;
  normalization: "float = byte / 128 - 0.995";
  sampleRateHz: number;
  centerFrequencyHz: number;
  selectedChannelFrequencyHz: number;
  captureStartedAt: string;
  sampleCount: number;
  durationSeconds: number;
  source: "rtl-sdr" | "synthetic" | "replay";
  mode: ReceiverMode;
  channelBandwidthHz: number;
  squelch: number;
  gainDb: number | null;
  knownGaps: RecordingGap[];
  stopReason: "user" | "capacity" | "source-stop" | "metadata-change";
  provenance?: string;
  survey?: SurveyCaptureContext;
}

export interface IqRecording {
  metadata: IqRecordingMetadata;
  data: Uint8Array;
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

export function decodeCu8(data: Uint8Array): { I: Float32Array; Q: Float32Array } {
  if (data.byteLength % 2 !== 0) throw new Error("Recording is truncated: CU8 data must contain complete I/Q byte pairs.");
  const length = data.byteLength / 2;
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    I[index] = (data[index * 2] ?? 0) / 128 - 0.995;
    Q[index] = (data[index * 2 + 1] ?? 0) / 128 - 0.995;
  }
  return { I, Q };
}

export class IqRecorder {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private capacityReached = false;
  private gaps: RecordingGap[] = [];

  constructor(
    private readonly session: SourceSessionMetadata,
    private readonly captureStartedAt = new Date().toISOString(),
    private readonly maxBytes = RECORDING_MAX_BYTES,
    private readonly provenance?: string,
    private readonly survey?: SurveyCaptureContext,
  ) {
    if (maxBytes < 2) throw new Error("Recording capacity must hold at least one complex sample.");
  }

  appendCu8(input: ArrayBuffer | Uint8Array): void {
    if (this.capacityReached) return;
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const available = Math.max(0, this.maxBytes - this.bytes);
    const length = Math.min(source.byteLength, available) & ~1;
    if (length > 0) {
      const copy = new Uint8Array(length);
      copy.set(source.subarray(0, length));
      this.chunks.push(copy);
      this.bytes += length;
    }
    if (length < source.byteLength || this.bytes + 2 > this.maxBytes) this.capacityReached = true;
  }

  appendNormalized(block: Pick<SampleBlock, "I" | "Q">): void {
    if (this.capacityReached) return;
    const length = Math.min(block.I.length, block.Q.length);
    const encoded = new Uint8Array(length * 2);
    for (let index = 0; index < length; index += 1) {
      encoded[index * 2] = floatToCu8(block.I[index] ?? 0);
      encoded[index * 2 + 1] = floatToCu8(block.Q[index] ?? 0);
    }
    this.appendCu8(encoded);
  }

  addGap(missingSamples: number | null, reason: string): void {
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
    const data = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const sampleCount = data.byteLength / 2;
    return {
      data,
      metadata: {
        format: RECORDING_FORMAT,
        sampleEncoding: "unsigned-8-bit",
        sampleOrder: "interleaved-iq",
        bytesPerComplexSample: 2,
        normalization: "float = byte / 128 - 0.995",
        sampleRateHz: this.session.actualSampleRateHz,
        centerFrequencyHz: this.session.hardwareCenterFrequencyHz,
        selectedChannelFrequencyHz: this.session.selectedChannelFrequencyHz,
        captureStartedAt: this.captureStartedAt,
        sampleCount,
        durationSeconds: sampleCount / this.session.actualSampleRateHz,
        source: this.session.source,
        mode: this.session.mode,
        channelBandwidthHz: this.session.channelBandwidthHz,
        squelch: this.session.squelch,
        gainDb: this.session.gainDb,
        knownGaps: this.gaps.map((gap) => ({ ...gap })),
        stopReason: this.capacityReached ? "capacity" : reason,
        ...(this.provenance ? { provenance: this.provenance } : {}),
        ...(this.survey ? { survey: structuredClone(this.survey) } : {}),
      },
    };
  }
}

export function parseRecording(metadataText: string, binary: ArrayBuffer | Uint8Array): IqRecording {
  if (metadataText.length > RECORDING_METADATA_MAX_BYTES) throw new Error("Recording metadata exceeds the 1 MiB limit.");
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
  if (metadata.format !== RECORDING_FORMAT) throw new Error(`Incompatible recording format: expected ${RECORDING_FORMAT}.`);
  if (metadata.sampleEncoding !== "unsigned-8-bit" || metadata.sampleOrder !== "interleaved-iq" || metadata.bytesPerComplexSample !== 2) {
    throw new Error("Incompatible sample format: expected interleaved unsigned 8-bit I,Q pairs.");
  }
  if (metadata.normalization !== "float = byte / 128 - 0.995") throw new Error("Recording uses an unsupported normalization.");
  assertFinitePositive(metadata.sampleRateHz, "sample rate");
  assertFinitePositive(metadata.centerFrequencyHz, "center frequency");
  assertFinitePositive(metadata.selectedChannelFrequencyHz, "selected channel frequency");
  assertFinitePositive(metadata.channelBandwidthHz, "channel bandwidth");
  if (metadata.sampleRateHz < REPLAY_MIN_SAMPLE_RATE_HZ || metadata.sampleRateHz > REPLAY_MAX_SAMPLE_RATE_HZ) {
    throw new Error("Replay supports sample rates from 8,000 to 3,200,000 samples/s.");
  }
  if (metadata.centerFrequencyHz > Number.MAX_SAFE_INTEGER || metadata.selectedChannelFrequencyHz > Number.MAX_SAFE_INTEGER) {
    throw new Error("Recording frequency exceeds the supported numeric range.");
  }
  if (!RECEIVER_MODES.includes(metadata.mode as ReceiverMode)) throw new Error("Recording metadata has an unsupported receiver mode.");
  const settings = normalizeModeSettings({ mode: metadata.mode as ReceiverMode, bandwidthHz: metadata.channelBandwidthHz, squelch: metadata.squelch! });
  if (settings.bandwidthHz !== metadata.channelBandwidthHz || settings.squelch !== metadata.squelch) throw new Error("Recording has out-of-range mode settings.");
  normalizeGain(metadata.gainDb!);
  if (planChannelTune(metadata.centerFrequencyHz, metadata.selectedChannelFrequencyHz, metadata.sampleRateHz, settings.bandwidthHz).hardwareRetuneRequired) {
    throw new Error("The selected channel lies outside the recorded capture span.");
  }
  if (!["rtl-sdr", "synthetic", "replay"].includes(metadata.source!)) throw new Error("Recording has an invalid source.");
  if (!["user", "capacity", "source-stop", "metadata-change"].includes(metadata.stopReason!)) throw new Error("Recording has an invalid stop reason.");
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
  return { ...metadata, ...(survey ? { survey } : {}), knownGaps: metadata.knownGaps.map((gap) => ({ ...gap })) } as IqRecordingMetadata;
}

export function recordingMetadataJson(recording: IqRecording): string {
  return `${JSON.stringify(recording.metadata, null, 2)}\n`;
}
