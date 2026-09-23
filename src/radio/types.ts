export type SourceKind = "synthetic" | "rtl-sdr" | "replay";
import type { ReceiverMode } from "./receiverConfig";
export type { DabSnapshot } from "../dab/dabReceiver";
export type { AdsbSnapshot, AdsbTarget } from "../adsb/adsbReceiver";
export type { AisSnapshot, AisTarget } from "../ais/aisReceiver";

export type ReceiverLifecycle =
  | "idle"
  | "connecting"
  | "connected"
  | "requesting-permission"
  | "starting"
  | "tuning"
  | "running"
  | "stopping"
  | "disconnecting"
  | "error";

export type ReceiverCommand =
  | { type: "connect"; source: SourceKind }
  | { type: "start"; source: SourceKind }
  | { type: "stop" }
  | { type: "disconnect" }
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
