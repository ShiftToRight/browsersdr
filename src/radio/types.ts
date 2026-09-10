export type SourceKind = "synthetic" | "rtl-sdr" | "replay";
import type { ReceiverMode } from "./receiverConfig";

export type ReceiverLifecycle =
  | "idle"
  | "requesting-permission"
  | "starting"
  | "tuning"
  | "running"
  | "stopping"
  | "error";

export type ReceiverCommand =
  | { type: "start"; source: SourceKind }
  | { type: "stop" }
  | { type: "tune"; channelFrequencyHz: number }
  | { type: "set-gain"; gainDb: number | null };

export interface ReceiverStatus {
  lifecycle: ReceiverLifecycle;
  message: string;
  sessionGeneration: number;
}

export interface RdsSnapshot {
  pi: string | null;
  programmeService: string | null;
  radioText: string | null;
  validGroups: number;
}

/** Immutable metadata attached to one acquisition generation. */
export interface SourceSessionMetadata {
  source: SourceKind;
  sessionGeneration: number;
  requestedSampleRateHz: number;
  actualSampleRateHz: number;
  hardwareCenterFrequencyHz: number;
  selectedChannelFrequencyHz: number;
  mode: ReceiverMode;
  channelBandwidthHz: number;
  squelch: number;
  gainDb: number | null;
  sampleFormat: "planar-f32-iq-normalized";
}

/**
 * One shifted RF spectrum snapshot. `bins` is owned by the frame consumer and
 * is relative power in dB, not calibrated dBFS or dBm.
 */
export interface SpectrumFrame {
  sessionGeneration: number;
  sequence: number;
  timestampMs: number;
  /** End position of this averaged spectrum on the source sample clock. */
  sampleIndex: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  units: "relative-dB";
  bins: Float32Array;
  droppedFramesBefore: number;
}
