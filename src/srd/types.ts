import type { DigitalProvenance, DigitalPublication } from "../digital";

export const SRD_MAX_TRACE_POINTS = 512;
export const SRD_MAX_PULSES_PER_BURST = 128;
export const SRD_MAX_BURST_HISTORY = 4;
export const SRD_MAX_READING_HISTORY = 32;
export const SRD_MAX_DEVICES = 32;
export const SRD_MAX_EVENTS = 64;

export type SrdModulation = "ook" | "2fsk";
export type SrdProtocol = "none" | "acurite-592txr" | "fineoffset-wh51";

export interface SrdThresholdSettings {
  mode: "adaptive" | "manual";
  /** Linear magnitude for the carrier gate in manual mode. */
  carrierLevel: number;
  /** Linear magnitude above the adaptive noise estimate. */
  minimumCarrierMargin: number;
  /** Adaptive carrier gate multiplier. */
  carrierNoiseRatio: number;
  /** Linear magnitude hysteresis for the carrier gate. */
  carrierHysteresis: number;
  /** Discriminator decision threshold in Hz (manual mode and adaptive seed). */
  discriminatorHz: number;
  /** Discriminator hysteresis in Hz. */
  discriminatorHysteresisHz: number;
}

export interface SrdBurstSettings {
  minimumDurationUs: number;
  maximumDurationUs: number;
  endGapUs: number;
}

export interface SrdTraceSettings {
  /** Retain one point for every N reduced-channel samples. */
  decimation: number;
  maximumPoints: number;
  /** Cached snapshots advance no faster than this many input-clock samples. */
  publicationIntervalInputSamples: number;
}

export interface SrdBitSliceSettings {
  enabled: boolean;
  symbolUs: number;
  encoding: "nrz" | "pwm-pulse-width";
  polarity: "normal" | "inverted";
}

export interface SrdPulse {
  level: 0 | 1;
  durationUs: number;
  firstInputSampleIndex: number;
  lastInputSampleIndex: number;
}

export interface SrdTimingCandidate {
  symbolUs: number;
  support: number;
  /** This is a duration-cluster estimate, never a protocol identification. */
  basis: "pulse-duration-cluster";
}

export interface SrdBitSlice {
  bits: string;
  symbolUs: number;
  encoding: "nrz" | "pwm-pulse-width";
  polarity: "normal" | "inverted";
  truncated: boolean;
}

export interface SrdBurst {
  id: number;
  modulation: SrdModulation;
  pulses: readonly SrdPulse[];
  pulseOverflow: number;
  truncated: boolean;
  truncationReason?: "discontinuity" | "maximum-duration" | "reset";
  timingCandidates: readonly SrdTimingCandidate[];
  bitSlice?: SrdBitSlice;
  provenance: DigitalProvenance;
}

export interface SrdTracePoint {
  inputSampleIndex: number;
  envelope: number;
  discriminatorHz: number;
  carrier: boolean;
  level: 0 | 1;
}

interface SrdReadingBase {
  protocol: Exclude<SrdProtocol, "none">;
  deviceId: string;
  integrity: "checksum+parity" | "crc8+checksum";
  provenance: DigitalProvenance;
}

export interface Acurite592Reading extends SrdReadingBase {
  protocol: "acurite-592txr";
  channel: "A" | "B" | "C";
  batteryOk: boolean;
  temperatureC: number;
  humidityPercent?: number;
}

export interface FineOffsetWh51Reading extends SrdReadingBase {
  protocol: "fineoffset-wh51";
  batteryMillivolts: number;
  batteryLevel: 0 | 0.1 | 0.5 | 0.9 | 1;
  moisturePercent: number;
  boost: number;
  adRaw: number;
}

export type SrdSensorReading = Acurite592Reading | FineOffsetWh51Reading;

export interface SrdDeviceState {
  key: string;
  reading: SrdSensorReading;
  readings: number;
  lastInputSampleIndex: number;
}

export interface SrdSnapshot {
  modulation: SrdModulation;
  protocol: SrdProtocol;
  configured: boolean;
  activeBurst: boolean;
  trace: readonly SrdTracePoint[];
  bursts: readonly SrdBurst[];
  devices: readonly SrdDeviceState[];
  recentReadings: readonly SrdSensorReading[];
  counters: {
    bursts: number;
    truncatedBursts: number;
    validatedReadings: number;
    rejectedProtocolFrames: number;
    duplicateReadings: number;
    tracePointsDropped: number;
  };
}

export type SrdEvent =
  | { type: "burst"; burst: SrdBurst }
  | { type: "reading"; reading: SrdSensorReading };

export type SrdSnapshotPublication = DigitalPublication<SrdSnapshot>;
export type SrdEventPublication = DigitalPublication<SrdEvent>;
