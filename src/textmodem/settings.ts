import {
  validateDigitalChannelConfiguration,
  type DigitalChannelConfiguration,
} from "../digital";

export const TEXT_MODES = ["RTTY", "PSK31", "NAVTEX", "ACARS"] as const;
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
  return {
    tuningOffsetHz: value.tuningOffsetHz,
    baud: value.baud,
    shiftHz: value.shiftHz,
    stopBits: value.stopBits,
    inverted: value.inverted,
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
    settings: normalizeTextModemSettings(settings),
    actualInputSampleRateHz,
    generation,
    selectedChannelOffsetHz,
    channelBandwidthHz: mode === "ACARS" ? 12_000 : 8_000,
    outputSampleRateHz: actualInputSampleRateHz === 1_024_000 ? 64_000 : 60_000,
  };
  validateTextModemConfiguration(result);
  return result;
}
export function validateTextModemConfiguration(
  value: TextModemConfiguration,
): void {
  validateDigitalChannelConfiguration(value);
  if (!isTextMode(value.mode)) throw new Error("Unknown text modem.");
  normalizeTextModemSettings(value.settings);
  if (![60_000, 64_000].includes(value.outputSampleRateHz))
    throw new Error("Text modem channel rate must be 60 or 64 ksample/s.");
}
