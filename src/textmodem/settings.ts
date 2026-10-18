import { digitalInputProfile } from "../digital/inputRates";
import {
  validateDigitalChannelConfiguration,
  type DigitalChannelConfiguration,
} from "../digital";

export const TEXT_MODES = ["RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"] as const;
export type TextMode = (typeof TEXT_MODES)[number];
export const isTextMode = (mode: string): mode is TextMode =>
  (TEXT_MODES as readonly string[]).includes(mode);
export interface TextModemSettings {
  /** Offset within the selected RF channel, not an external USB dial frequency. */
  tuningOffsetHz: number;
  baud: 45.45 | 50 | 75;
  shiftHz: 170 | 450 | 850;
  inverted: boolean;
  stopBits: 1 | 1.5 | 2;
  image?: ImageModemSettings;
  cw?: CwTextSettings;
}
export interface ImageModemSettings {
  ioc: 288 | 576;
  lpm: 60 | 90 | 120 | 240;
  shiftHz: 800 | 850;
  automatic: boolean;
  sstvMode: "auto" | "Martin M1" | "Martin M2";
}
export interface CwTextSettings { wpm: number; autoSpeed: boolean; threshold: number; }
export const DEFAULT_IMAGE_SETTINGS: ImageModemSettings = { ioc: 576, lpm: 120, shiftHz: 800, automatic: true, sstvMode: "auto" };
export const DEFAULT_CW_SETTINGS: CwTextSettings = { wpm: 20, autoSpeed: false, threshold: 0.35 };
export const isImageMode = (mode: string): mode is "WEFAX" | "SSTV" => mode === "WEFAX" || mode === "SSTV";
export function imageModemSettings(value: ImageModemSettings = DEFAULT_IMAGE_SETTINGS): ImageModemSettings {
  if (!value || ![288, 576].includes(value.ioc) || ![60, 90, 120, 240].includes(value.lpm) || ![800, 850].includes(value.shiftHz) || typeof value.automatic !== "boolean" || !["auto", "Martin M1", "Martin M2"].includes(value.sstvMode)) throw new Error("Invalid image decoder settings.");
  return { ioc: value.ioc, lpm: value.lpm, shiftHz: value.shiftHz, automatic: value.automatic, sstvMode: value.sstvMode };
}
export function cwTextSettings(value: CwTextSettings = DEFAULT_CW_SETTINGS): CwTextSettings {
  if (!value || !Number.isFinite(value.wpm) || value.wpm < 5 || value.wpm > 60 || typeof value.autoSpeed !== "boolean" || !Number.isFinite(value.threshold) || value.threshold < 0.1 || value.threshold > 0.8) throw new Error("CW text requires 5–60 WPM and a relative threshold of 0.1–0.8.");
  return { wpm: value.wpm, autoSpeed: value.autoSpeed, threshold: value.threshold };
}
export const RTTY_PRESETS = {
  dwd: { baud: 50, shiftHz: 450, stopBits: 1.5, inverted: false },
  amateur: { baud: 45.45, shiftHz: 170, stopBits: 1.5, inverted: false },
} as const;
export function defaultTextModemSettings(): TextModemSettings {
  return { tuningOffsetHz: 0, ...RTTY_PRESETS.dwd };
}
export function normalizeTextModemSettings(
  value: TextModemSettings = defaultTextModemSettings(),
  mode?: TextMode,
): TextModemSettings {
  if (
    !value ||
    !Number.isFinite(value.tuningOffsetHz) ||
    Math.abs(value.tuningOffsetHz) > 3000 ||
    ![45.45, 50, 75].includes(value.baud) ||
    ![170, 450, 850].includes(value.shiftHz) ||
    ![1, 1.5, 2].includes(value.stopBits) ||
    typeof value.inverted !== "boolean"
  )
    throw new Error(
      "Invalid text modem settings: offset ±3,000 Hz, supported RTTY rate/shift/framing and polarity required.",
    );
  if ((mode === "WEFAX" || mode === "SSTV") && Math.abs(value.tuningOffsetHz) > 1500) throw new Error("Image fine tuning must be within ±1,500 Hz so USB image tones fit the channel.");
  if (mode === "CW-TEXT" && value.tuningOffsetHz !== 0) throw new Error("Tune the CW RF channel frequency; CW text fine offset must be zero to preserve narrow channel recordings.");
  return {
    tuningOffsetHz: value.tuningOffsetHz,
    baud: value.baud,
    shiftHz: value.shiftHz,
    stopBits: value.stopBits,
    inverted: value.inverted,
    ...(value.image === undefined ? {} : { image: imageModemSettings(value.image) }),
    ...(value.cw === undefined ? {} : { cw: cwTextSettings(value.cw) }),
  };
}
export interface TextModemConfiguration extends DigitalChannelConfiguration {
  mode: TextMode;
  settings: TextModemSettings;
}
export function textModemConfiguration(
  mode: TextMode,
  settings: TextModemSettings | undefined,
  actualInputSampleRateHz: number,
  generation: number,
  selectedChannelOffsetHz = 0,
): TextModemConfiguration {
  const result: TextModemConfiguration = {
    mode,
    settings: normalizeTextModemSettings(settings, mode),
    actualInputSampleRateHz,
    generation,
    selectedChannelOffsetHz,
    channelBandwidthHz: mode === "ACARS" ? 12_000 : 8_000,
    outputSampleRateHz: digitalInputProfile(actualInputSampleRateHz).narrowRateHz,
  };
  validateTextModemConfiguration(result);
  return result;
}
export function validateTextModemConfiguration(
  value: TextModemConfiguration,
): void {
  validateDigitalChannelConfiguration(value);
  if (!isTextMode(value.mode)) throw new Error("Unknown text modem.");
  normalizeTextModemSettings(value.settings, value.mode);
  if (![60_000, 64_000].includes(value.outputSampleRateHz))
    throw new Error("Text modem channel rate must be 60 or 64 ksample/s.");
}
