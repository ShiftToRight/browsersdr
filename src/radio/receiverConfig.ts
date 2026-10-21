import { normalizePocsagSettings, type PocsagSettings } from "../pocsag/settings";
import { isTextMode, normalizeTextModemSettings, type TextModemSettings } from "../textmodem/settings";
import "@jtarrio/signals/demod/demodulator.js";
import { digitalInputProfile } from "../digital/inputRates";
import { getMode, modeParameters, type Mode } from "@jtarrio/signals/demod/modes.js";
import { DAB_OCCUPIED_BANDWIDTH_HZ, validateDabSampleRate } from "../dab/dabReceiver";
import { ADSB_BANDWIDTH_HZ, validateAdsbSampleRate } from "../adsb/adsbReceiver";
import { AIS_BANDWIDTH_HZ, validateAisSampleRate } from "../ais/aisReceiver";
import {
  defaultSrdModeSettings,
  srdConfigurationForRoute,
  type SrdModeSettings,
} from "../srd/settings";

export type ReceiverMode = "OFF" | "WBFM" | "NBFM" | "AM" | "USB" | "LSB" | "CW" | "DAB" | "ADS-B" | "AIS" | "SRD" | "POCSAG" | "APRS" | "RS41" | "RTTY" | "PSK31" | "NAVTEX" | "ACARS" | "WEFAX" | "SSTV" | "CW-TEXT";

export const CW_FILTER_BANDWIDTHS_HZ = [100, 250, 500, 1_000] as const;
export const CW_DEFAULT_BANDWIDTH_HZ = 500;
export const CW_TONE_MIN_HZ = 300;
export const CW_TONE_MAX_HZ = 1_000;
export const CW_DEFAULT_TONE_HZ = 600;

export interface ReceiverModeSettings {
  mode: ReceiverMode;
  bandwidthHz: number;
  squelch: number;
  /** CW beat-note frequency. Optional only for legacy settings and recordings. */
  beatToneHz?: number;
  /** Decoder-specific settings; absent on legacy recordings/preferences. */
  srd?: SrdModeSettings;
  textModem?: TextModemSettings;
  pocsag?: PocsagSettings;
}

export interface ModeCapabilities {
  bandwidthSettable: boolean;
  minimumBandwidthHz: number;
  maximumBandwidthHz: number;
  squelchSettable: boolean;
}

export const RECEIVER_MODES: readonly ReceiverMode[] = ["OFF", "WBFM", "NBFM", "AM", "USB", "LSB", "CW", "DAB", "ADS-B", "AIS", "SRD", "POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"];
export const SQUELCH_MIN = 0;
export const SQUELCH_MAX = 6;
export const MANUAL_GAIN_MIN_DB = 0;
export const MANUAL_GAIN_MAX_DB = 49.6;

export { CAPTURE_EDGE_GUARD_HZ, captureEdgeGuardHz } from "./captureSpan";
import { captureEdgeGuardHz } from "./captureSpan";

const MODE_CAPABILITIES: Record<ReceiverMode, ModeCapabilities> = {
  OFF: { bandwidthSettable: false, minimumBandwidthHz: 1, maximumBandwidthHz: 1, squelchSettable: false },
  WBFM: { bandwidthSettable: false, minimumBandwidthHz: 150_000, maximumBandwidthHz: 150_000, squelchSettable: false },
  NBFM: { bandwidthSettable: true, minimumBandwidthHz: 250, maximumBandwidthHz: 30_000, squelchSettable: true },
  AM: { bandwidthSettable: true, minimumBandwidthHz: 250, maximumBandwidthHz: 30_000, squelchSettable: true },
  USB: { bandwidthSettable: true, minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true },
  LSB: { bandwidthSettable: true, minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true },
  CW: { bandwidthSettable: true, minimumBandwidthHz: 100, maximumBandwidthHz: 1_000, squelchSettable: false },
  DAB: { bandwidthSettable: false, minimumBandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, maximumBandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelchSettable: false },
  "ADS-B": { bandwidthSettable: false, minimumBandwidthHz: ADSB_BANDWIDTH_HZ, maximumBandwidthHz: ADSB_BANDWIDTH_HZ, squelchSettable: false },
  AIS: { bandwidthSettable: false, minimumBandwidthHz: AIS_BANDWIDTH_HZ, maximumBandwidthHz: AIS_BANDWIDTH_HZ, squelchSettable: false },
  POCSAG: { bandwidthSettable: false, minimumBandwidthHz: 20_000, maximumBandwidthHz: 20_000, squelchSettable: false },
  APRS: { bandwidthSettable: false, minimumBandwidthHz: 20_000, maximumBandwidthHz: 20_000, squelchSettable: false },
  RS41: { bandwidthSettable: false, minimumBandwidthHz: 20_000, maximumBandwidthHz: 20_000, squelchSettable: false },
  WEFAX: { bandwidthSettable: false, minimumBandwidthHz: 8_000, maximumBandwidthHz: 8_000, squelchSettable: false },
  SSTV: { bandwidthSettable: false, minimumBandwidthHz: 8_000, maximumBandwidthHz: 8_000, squelchSettable: false },
  "CW-TEXT": { bandwidthSettable: true, minimumBandwidthHz: 100, maximumBandwidthHz: 1_000, squelchSettable: false },
  RTTY: { bandwidthSettable: false, minimumBandwidthHz: 8_000, maximumBandwidthHz: 8_000, squelchSettable: false },
  PSK31: { bandwidthSettable: false, minimumBandwidthHz: 8_000, maximumBandwidthHz: 8_000, squelchSettable: false },
  NAVTEX: { bandwidthSettable: false, minimumBandwidthHz: 8_000, maximumBandwidthHz: 8_000, squelchSettable: false },
  ACARS: { bandwidthSettable: false, minimumBandwidthHz: 12_000, maximumBandwidthHz: 12_000, squelchSettable: false },
  SRD: { bandwidthSettable: false, minimumBandwidthHz: 32_000, maximumBandwidthHz: 32_000, squelchSettable: false },
};

export function modeCapabilities(mode: ReceiverMode): ModeCapabilities {
  return MODE_CAPABILITIES[mode];
}

export function defaultModeSettings(mode: ReceiverMode): ReceiverModeSettings {
  if (mode === "POCSAG") return {mode, bandwidthHz: 20_000, squelch: 0, pocsag: normalizePocsagSettings()};
  if (isTextMode(mode) && mode !== "CW-TEXT") return { mode, bandwidthHz: mode === "ACARS" ? 12_000 : 8_000, squelch: 0, textModem: normalizeTextModemSettings(undefined, mode) };
  if (mode === "OFF") return { mode, bandwidthHz: 1, squelch: 0 };
  if (mode === "CW" || mode === "CW-TEXT") return { mode, bandwidthHz: CW_DEFAULT_BANDWIDTH_HZ, squelch: 0, beatToneHz: CW_DEFAULT_TONE_HZ, ...(mode === "CW-TEXT" ? { textModem: normalizeTextModemSettings(undefined, "CW-TEXT") } : {}) };
  if (mode === "DAB") return { mode, bandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelch: 0 };
  if (mode === "ADS-B") return { mode, bandwidthHz: ADSB_BANDWIDTH_HZ, squelch: 0 };
  if (mode === "AIS") return { mode, bandwidthHz: AIS_BANDWIDTH_HZ, squelch: 0 };
  if (mode === "APRS" || mode === "RS41") return { mode, bandwidthHz: 20_000, squelch: 0 };
  if (mode === "SRD") return { mode, bandwidthHz: 32_000, squelch: 0, srd: defaultSrdModeSettings() };
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
  if (settings.mode === "POCSAG") return {mode: settings.mode, bandwidthHz: 20_000, squelch: 0, pocsag: normalizePocsagSettings(settings.pocsag)};
  if (isTextMode(settings.mode) && settings.mode !== "CW-TEXT") return { mode: settings.mode, bandwidthHz: settings.mode === "ACARS" ? 12_000 : 8_000, squelch: 0, textModem: normalizeTextModemSettings(settings.textModem, settings.mode) };
  if (settings.mode === "OFF") return { mode: "OFF", bandwidthHz: 1, squelch: 0 };
  if (settings.mode === "CW" || settings.mode === "CW-TEXT") {
    const beatToneHz = settings.beatToneHz ?? CW_DEFAULT_TONE_HZ;
    if (!(CW_FILTER_BANDWIDTHS_HZ as readonly number[]).includes(settings.bandwidthHz))
      throw new Error("CW filter bandwidth must be 100, 250, 500 or 1,000 Hz.");
    if (!Number.isFinite(beatToneHz) || beatToneHz < CW_TONE_MIN_HZ || beatToneHz > CW_TONE_MAX_HZ)
      throw new Error(`CW beat tone must be ${CW_TONE_MIN_HZ}–${CW_TONE_MAX_HZ} Hz.`);
    return { mode: settings.mode, bandwidthHz: settings.bandwidthHz, squelch: 0, beatToneHz, ...(settings.mode === "CW-TEXT" ? { textModem: normalizeTextModemSettings(settings.textModem, "CW-TEXT") } : {}) };
  }
  if (settings.mode === "DAB") return { mode: "DAB", bandwidthHz: DAB_OCCUPIED_BANDWIDTH_HZ, squelch: 0 };
  if (settings.mode === "ADS-B") return { mode: "ADS-B", bandwidthHz: ADSB_BANDWIDTH_HZ, squelch: 0 };
  if (settings.mode === "AIS") return { mode: "AIS", bandwidthHz: AIS_BANDWIDTH_HZ, squelch: 0 };
  if (settings.mode === "APRS" || settings.mode === "RS41") return { mode: settings.mode, bandwidthHz: 20_000, squelch: 0 };
  if (settings.mode === "SRD") {
    const srd = structuredClone(settings.srd ?? defaultSrdModeSettings());
    // Reuse the core validator with a representative supported route.
    srdConfigurationForRoute(srd, 1_024_000, 0, 0);
    return { mode: "SRD", bandwidthHz: 32_000, squelch: 0, srd };
  }
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
  if (normalized.mode === "OFF") throw new Error("OFF does not use the analog demodulator.");
  if (["DAB", "ADS-B", "AIS", "SRD", "POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV"].includes(normalized.mode)) throw new Error(`${normalized.mode} uses the digital receiver path, not the analog demodulator.`);
  const parameters = modeParameters(getMode(normalized.mode === "CW-TEXT" ? "CW" : normalized.mode));
  if (parameters.hasBandwidth()) parameters.setBandwidth(normalized.bandwidthHz);
  if (parameters.hasSquelch()) parameters.setSquelch(normalized.squelch);
  if (normalized.mode === "WBFM" && parameters.hasStereo()) parameters.setStereo(true);
  return parameters.mode;
}

/** Validate a decoder before changing the active fan-out route. */
export function validateModeSampleRate(mode: ReceiverMode, sampleRateHz: number): void {
  if (mode === "DAB") validateDabSampleRate(sampleRateHz);
  else if (mode === "ADS-B") validateAdsbSampleRate(sampleRateHz);
  else if (mode === "AIS") validateAisSampleRate(sampleRateHz);
  else if (["SRD", "POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"].includes(mode))
    digitalInputProfile(sampleRateHz);
}

export interface TuningPlan {
  hardwareCenterFrequencyHz: number;
  frequencyOffsetHz: number;
  hardwareRetuneRequired: boolean;
  usableHalfSpanHz: number;
}

export interface ReceiverTuneOptions {
  /** Explicit capture center; the absolute channel frequency is preserved. */
  centerFrequencyHz?: number;
  /** Permit moving the capture window when the complete channel no longer fits. */
  autoRecenter?: boolean;
}

export function planChannelTune(
  currentCenterFrequencyHz: number,
  channelFrequencyHz: number,
  sampleRateHz: number,
  bandwidthHz: number,
  options: ReceiverTuneOptions = {},
): TuningPlan {
  const center = options.centerFrequencyHz ?? currentCenterFrequencyHz;
  if (![currentCenterFrequencyHz, center, channelFrequencyHz, sampleRateHz, bandwidthHz].every(Number.isFinite)
    || currentCenterFrequencyHz <= 0 || center <= 0 || channelFrequencyHz <= 0 || sampleRateHz <= 0 || bandwidthHz <= 0) {
    throw new Error("Frequency, sample rate and bandwidth must be finite positive values.");
  }
  const usableHalfSpanHz = sampleRateHz / 2 - bandwidthHz / 2 - captureEdgeGuardHz(sampleRateHz);
  if (usableHalfSpanHz < 0) throw new Error("The channel bandwidth does not fit in the captured sample rate.");
  const offset = channelFrequencyHz - center;
  if (Math.abs(offset) <= usableHalfSpanHz) {
    return {
      hardwareCenterFrequencyHz: center,
      frequencyOffsetHz: offset,
      hardwareRetuneRequired: center !== currentCenterFrequencyHz,
      usableHalfSpanHz,
    };
  }
  if (options.centerFrequencyHz !== undefined)
    throw new Error("That receiver center would place the selected channel outside the usable RF window. Choose a closer center or use To channel.");
  if (options.autoRecenter === false)
    throw new Error("The complete channel does not fit in the usable RF window. Enable Follow channel or move the receiver frequency.");
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
