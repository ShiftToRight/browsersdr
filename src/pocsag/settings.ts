import { digitalInputProfile } from "../digital/inputRates";
import {
  validateDigitalChannelConfiguration,
  type DigitalChannelConfiguration,
} from "../digital";
export interface PocsagSettings {
  rate: "auto" | 512 | 1200 | 2400;
  polarity: "auto" | "normal" | "inverted";
  interpretation: "function" | "numeric" | "alpha" | "raw";
  correction: 0 | 1 | 2;
}
export const defaultPocsagSettings = (): PocsagSettings => ({
  rate: "auto",
  polarity: "auto",
  interpretation: "function",
  correction: 2,
});
export function normalizePocsagSettings(
  input?: PocsagSettings,
): PocsagSettings {
  if (input === undefined) return defaultPocsagSettings();
  if (
    !input ||
    !["auto", 512, 1200, 2400].includes(input.rate) ||
    !["auto", "normal", "inverted"].includes(input.polarity) ||
    !["function", "numeric", "alpha", "raw"].includes(input.interpretation) ||
    ![0, 1, 2].includes(input.correction)
  )
    throw new Error("Invalid POCSAG settings.");
  return {
    rate: input.rate,
    polarity: input.polarity,
    interpretation: input.interpretation,
    correction: input.correction,
  };
}
export interface PocsagConfiguration extends DigitalChannelConfiguration {
  pocsag: PocsagSettings;
  snapshotIntervalInputSamples: number;
}
export function pocsagConfiguration(
  input: PocsagSettings | undefined,
  rate: number,
  generation: number,
  offset = 0,
): PocsagConfiguration {
  return {
    actualInputSampleRateHz: rate,
    generation,
    selectedChannelOffsetHz: offset,
    channelBandwidthHz: 20_000,
    outputSampleRateHz: digitalInputProfile(rate).narrowRateHz,
    pocsag: normalizePocsagSettings(input),
    snapshotIntervalInputSamples: Math.floor(rate / 10),
  };
}
export function validatePocsagConfiguration(c: PocsagConfiguration): void {
  validateDigitalChannelConfiguration(c);
  normalizePocsagSettings(c.pocsag);
  if (
    c.outputSampleRateHz !==
      digitalInputProfile(c.actualInputSampleRateHz).narrowRateHz ||
    c.channelBandwidthHz !== 20_000 ||
    !Number.isSafeInteger(c.snapshotIntervalInputSamples) ||
    c.snapshotIntervalInputSamples < 1
  )
    throw new Error("Invalid POCSAG input clock or publication interval.");
}
