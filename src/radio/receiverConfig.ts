import "@jtarrio/signals/demod/demodulator.js";
import { getMode, modeParameters, type Mode } from "@jtarrio/signals/demod/modes.js";
import { DAB_OCCUPIED_BANDWIDTH_HZ, validateDabSampleRate } from "../dab/dabReceiver";
import { ADSB_BANDWIDTH_HZ, validateAdsbSampleRate } from "../adsb/adsbReceiver";
import { AIS_BANDWIDTH_HZ, validateAisSampleRate } from "../ais/aisReceiver";

export type ReceiverMode = "WBFM" | "NBFM" | "AM" | "USB" | "LSB" | "DAB" | "ADS-B" | "AIS";

export interface ReceiverModeSettings {
  mode: ReceiverMode;
  bandwidthHz: number;
  squelch: number;
}

export interface ModeCapabilities {
  bandwidthSettable: boolean;
  minimumBandwidthHz: number;
  maximumBandwidthHz: number;
  squelchSettable: boolean;
}

export const RECEIVER_MODES: readonly ReceiverMode[] = ["WBFM", "NBFM", "AM", "USB", "LSB", "DAB", "ADS-B", "AIS"];
export const SQUELCH_MIN = 0;
export const SQUELCH_MAX = 6;
export const MANUAL_GAIN_MIN_DB = 0;
export const MANUAL_GAIN_MAX_DB = 49.6;

/**
 * Keeps the complete channel passband away from the capture's Nyquist edge.
 * The 20 kHz guard is wider than the center-to-first-null estimate for the
 * installed 151-tap Hamming FIR at 1.024 MS/s (~13.6 kHz).
 */
export const CAPTURE_EDGE_GUARD_HZ = 20_000;

/** Preserve the conservative 151-tap FIR guard in normalized frequency units. */
export function captureEdgeGuardHz(sampleRateHz: number): number {
  return CAPTURE_EDGE_GUARD_HZ * sampleRateHz / 1_024_000;
}

const MODE_CAPABILITIES: Record<ReceiverMode, ModeCapabilities> = {
  WBFM: { bandwidthSettable: false, minimumBandwidthHz: 150_000, maximumBandwidthHz: 150_000, squelchSettable: false },
  NBFM: { bandwidthSettable: true, minimumBandwidthHz: 250, maximumBandwidthHz: 30_000, squelchSettable: true },
  AM: { bandwidthSettable: true, minimumBandwidthHz: 250, maximumBandwidthHz: 30_000, squelchSettable: true },
  USB: { bandwidthSettable: true, minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true },
  LSB: { bandwidthSettable: true, minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true },
  DAB: { bandwidthSettable: false, minimumBandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, maximumBandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelchSettable: false },
  "ADS-B": { bandwidthSettable: false, minimumBandwidthHz: ADSB_BANDWIDTH_HZ, maximumBandwidthHz: ADSB_BANDWIDTH_HZ, squelchSettable: false },
  AIS: { bandwidthSettable: false, minimumBandwidthHz: AIS_BANDWIDTH_HZ, maximumBandwidthHz: AIS_BANDWIDTH_HZ, squelchSettable: false },
};

export function modeCapabilities(mode: ReceiverMode): ModeCapabilities {
  return MODE_CAPABILITIES[mode];
}

export function defaultModeSettings(mode: ReceiverMode): ReceiverModeSettings {
  if (mode === "DAB") return { mode, bandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelch: 0 };
  if (mode === "ADS-B") return { mode, bandwidthHz: ADSB_BANDWIDTH_HZ, squelch: 0 };
  if (mode === "AIS") return { mode, bandwidthHz: AIS_BANDWIDTH_HZ, squelch: 0 };
  const parameters = modeParameters(getMode(mode));
  return {
    mode,
    bandwidthHz: parameters.getBandwidth(),
    squelch: parameters.hasSquelch() ? parameters.getSquelch() : 0,
  };
}

export function normalizeModeSettings(settings: ReceiverModeSettings): ReceiverModeSettings {
  if (!RECEIVER_MODES.includes(settings.mode)) throw new Error(`Unsupported receiver mode: ${String(settings.mode)}`);
  if (!Number.isFinite(settings.bandwidthHz)) throw new Error("Enter a valid channel bandwidth.");
  if (!Number.isFinite(settings.squelch)) throw new Error("Enter a valid squelch level.");
  if (settings.mode === "DAB") return { mode: "DAB", bandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelch: 0 };
  if (settings.mode === "ADS-B") return { mode: "ADS-B", bandwidthHz: ADSB_BANDWIDTH_HZ, squelch: 0 };
  if (settings.mode === "AIS") return { mode: "AIS", bandwidthHz: AIS_BANDWIDTH_HZ, squelch: 0 };
  const parameters = modeParameters(getMode(settings.mode));
  if (parameters.hasBandwidth()) parameters.setBandwidth(settings.bandwidthHz);
  if (parameters.hasSquelch()) parameters.setSquelch(settings.squelch);
  return {
    mode: settings.mode,
    bandwidthHz: parameters.getBandwidth(),
    squelch: parameters.hasSquelch() ? parameters.getSquelch() : 0,
  };
}

export function createSignalsMode(settings: ReceiverModeSettings): Mode {
  const normalized = normalizeModeSettings(settings);
  if (["DAB", "ADS-B", "AIS"].includes(normalized.mode)) throw new Error(`${normalized.mode} uses the digital receiver path, not the analog demodulator.`);
  const parameters = modeParameters(getMode(normalized.mode));
  if (parameters.hasBandwidth()) parameters.setBandwidth(normalized.bandwidthHz);
  if (parameters.hasSquelch()) parameters.setSquelch(normalized.squelch);
  if (normalized.mode === "WBFM" && parameters.hasStereo()) parameters.setStereo(false);
  return parameters.mode;
}

/** Validate a decoder before changing the active fan-out route. */
export function validateModeSampleRate(mode: ReceiverMode, sampleRateHz: number): void {
  if (mode === "DAB") validateDabSampleRate(sampleRateHz);
  else if (mode === "ADS-B") validateAdsbSampleRate(sampleRateHz);
  else if (mode === "AIS") validateAisSampleRate(sampleRateHz);
}

export interface TuningPlan {
  hardwareCenterFrequencyHz: number;
  frequencyOffsetHz: number;
  hardwareRetuneRequired: boolean;
  usableHalfSpanHz: number;
}

export function planChannelTune(
  currentCenterFrequencyHz: number,
  channelFrequencyHz: number,
  sampleRateHz: number,
  bandwidthHz: number,
): TuningPlan {
  if (![currentCenterFrequencyHz, channelFrequencyHz, sampleRateHz, bandwidthHz].every(Number.isFinite)
    || currentCenterFrequencyHz <= 0 || channelFrequencyHz <= 0 || sampleRateHz <= 0 || bandwidthHz <= 0) {
    throw new Error("Frequency, sample rate and bandwidth must be finite positive values.");
  }
  const usableHalfSpanHz = sampleRateHz / 2 - bandwidthHz / 2 - captureEdgeGuardHz(sampleRateHz);
  if (usableHalfSpanHz < 0) throw new Error("The channel bandwidth does not fit in the captured sample rate.");
  const offset = channelFrequencyHz - currentCenterFrequencyHz;
  if (Math.abs(offset) <= usableHalfSpanHz) {
    return {
      hardwareCenterFrequencyHz: currentCenterFrequencyHz,
      frequencyOffsetHz: offset,
      hardwareRetuneRequired: false,
      usableHalfSpanHz,
    };
  }
  return {
    hardwareCenterFrequencyHz: channelFrequencyHz,
    frequencyOffsetHz: 0,
    hardwareRetuneRequired: true,
    usableHalfSpanHz,
  };
}

export function normalizeGain(gainDb: number | null): number | null {
  if (gainDb === null) return null;
  if (!Number.isFinite(gainDb) || gainDb < MANUAL_GAIN_MIN_DB || gainDb > MANUAL_GAIN_MAX_DB) {
    throw new Error(`Manual RF gain must be ${MANUAL_GAIN_MIN_DB.toFixed(1)}–${MANUAL_GAIN_MAX_DB.toFixed(1)} dB.`);
  }
  return gainDb;
}
