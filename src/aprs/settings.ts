import { digitalInputProfile, type DigitalInputSampleRateHz } from "../digital/inputRates";
import {
  validateDigitalChannelConfiguration,
  type DigitalChannelConfiguration,
} from "../digital";

export interface AprsConfiguration extends DigitalChannelConfiguration {
  stationExpiryInputSamples: number;
  snapshotIntervalInputSamples: number;
  duplicateWindowInputSamples: number;
}

export const APRS_FREQUENCY_PRESETS = [
  {
    region: "IARU Region 1",
    label: "2 m APRS (user-selectable)",
    frequencyHz: 144_800_000,
  },
] as const;

export function defaultAprsConfiguration(
  actualInputSampleRateHz: DigitalInputSampleRateHz,
  generation: number,
  selectedChannelOffsetHz = 0,
): AprsConfiguration {
  return {
    actualInputSampleRateHz,
    selectedChannelOffsetHz,
    generation,
    channelBandwidthHz: 20_000,
    outputSampleRateHz: digitalInputProfile(actualInputSampleRateHz).narrowRateHz,
    stationExpiryInputSamples: actualInputSampleRateHz * 30 * 60,
    snapshotIntervalInputSamples: Math.floor(actualInputSampleRateHz / 10),
    duplicateWindowInputSamples: actualInputSampleRateHz * 2,
  };
}

export function validateAprsConfiguration(
  configuration: AprsConfiguration,
): void {
  validateDigitalChannelConfiguration(configuration);
  if (configuration.outputSampleRateHz < 24_000)
    throw new Error("APRS channel output rate must be at least 24 ksample/s.");
  for (const [name, value] of [
    ["station expiry", configuration.stationExpiryInputSamples],
    ["snapshot interval", configuration.snapshotIntervalInputSamples],
    ["duplicate window", configuration.duplicateWindowInputSamples],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`APRS ${name} must be a positive safe integer.`);
}
