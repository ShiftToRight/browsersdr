import type { TextModemSettings } from "../textmodem/settings";
export type SourceKind =
  "synthetic" | "rtl-sdr" | "hackrf" | "bladerf" | "usrp-b205" | "replay";
import type {
  HackrfRxSettings,
  HackrfSessionDetails,
} from "./sourceCapabilities";
import type { BladeRfSessionDetails } from "./bladerfProtocol";
import type { UsrpB205SessionDetails } from "./usrpB205Capabilities";
import type { ReceiverMode } from "./receiverConfig";
export type { DabSnapshot } from "../dab/dabReceiver";
export type { AdsbSnapshot, AdsbTarget } from "../adsb/adsbReceiver";
export type { AisSnapshot, AisTarget } from "../ais/aisReceiver";
export type { SrdSnapshot } from "../srd/types";
import type { SrdModeSettings } from "../srd/settings";

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

export interface SquelchMeterState {
  /** Relative in-channel quality ratio used by the analog squelch, not dB. */
  level: number;
  /** Recent peak held briefly to make intermittent transmissions visible. */
  peak: number;
  open: boolean;
}

export type ReceiverCommand =
  | { type: "connect"; source: SourceKind }
  | { type: "start"; source: SourceKind }
  | { type: "stop" }
  | { type: "disconnect" }
  | { type: "tune"; channelFrequencyHz: number }
  | { type: "set-gain"; gainDb: number | null }
  | { type: "configure-hardware"; settings: HackrfRxSettings };

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
  /** Acquisition/analysis rate. HackRF channel DSP rate is hackrf.effectiveSampleRateHz. */
  actualSampleRateHz: number;
  hardwareCenterFrequencyHz: number;
  selectedChannelFrequencyHz: number;
  mode: ReceiverMode;
  channelBandwidthHz: number;
  squelch: number;
  /** Selected audible CW beat note; absent in recordings made before CW support. */
  beatToneHz?: number;
  srd?: SrdModeSettings;
  textModem?: TextModemSettings;
  /** Legacy RTL scalar. HackRF keeps null for compatibility; this is NOT AGC. */
  gainDb: number | null;
  /** Probed chip family; this does not identify a commercial RTL board. */
  rtlTuner?: "R820T-family" | "R828D";
  /** Required by the HackRF backend; legacy constructors need no new fields. */
  hackrf?: HackrfSessionDetails;
  /** Present only for the receive-only bladeRF 2.0 Micro backend. */
  bladerf?: BladeRfSessionDetails;
  /** Present only for the frozen receive-only USRP B205-mini profile. */
  usrpB205?: UsrpB205SessionDetails;
  sampleFormat: "planar-f32-iq-normalized";
}

export interface BladeRfSourceSessionMetadata extends SourceSessionMetadata {
  source: "bladerf";
  bladerf: BladeRfSessionDetails;
}

/** Stronger construction contract for step 04; common legacy fixtures stay compatible. */
export interface HackrfSourceSessionMetadata extends SourceSessionMetadata {
  source: "hackrf";
  gainDb: null;
  hackrf: HackrfSessionDetails;
}

export interface UsrpB205SourceSessionMetadata extends SourceSessionMetadata {
  source: "usrp-b205";
  gainDb: null;
  usrpB205: UsrpB205SessionDetails;
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
  /** Source samples absent from analysis since the preceding published frame. */
  missingSamplesBefore?: number;
  /** Expected samples per averaged display row; absent for legacy four-window frames. */
  hopSamples?: number;
}
