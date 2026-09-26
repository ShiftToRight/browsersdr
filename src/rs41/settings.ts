import {
  validateDigitalChannelConfiguration,
  type DigitalChannelConfiguration,
} from "../digital";

export interface Rs41Configuration extends DigitalChannelConfiguration {
  syncBitErrors: number;
  sondeExpiryInputSamples: number;
  snapshotIntervalInputSamples: number;
}

export function defaultRs41Configuration(
  actualInputSampleRateHz: 1_024_000 | 2_400_000,
  generation: number,
  selectedChannelOffsetHz = 0,
): Rs41Configuration {
  return {
    actualInputSampleRateHz,
    selectedChannelOffsetHz,
    generation,
    channelBandwidthHz: 20_000,
    outputSampleRateHz: actualInputSampleRateHz === 1_024_000 ? 64_000 : 60_000,
    syncBitErrors: 4,
    sondeExpiryInputSamples: actualInputSampleRateHz * 30 * 60,
    snapshotIntervalInputSamples: Math.floor(actualInputSampleRateHz / 10),
  };
}

export function validateRs41Configuration(
  configuration: Rs41Configuration,
): void {
  validateDigitalChannelConfiguration(configuration);
  if (configuration.outputSampleRateHz < 48_000)
    throw new Error("RS41 output rate must be at least 48 ksample/s.");
  if (
    !Number.isSafeInteger(configuration.syncBitErrors) ||
    configuration.syncBitErrors < 0 ||
    configuration.syncBitErrors > 8
  )
    throw new Error(
      "RS41 sync tolerance must be an integer from 0 through 8 bits.",
    );
  for (const [label, value] of [
    ["sonde expiry", configuration.sondeExpiryInputSamples],
    ["snapshot interval", configuration.snapshotIntervalInputSamples],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`RS41 ${label} must be a positive safe integer.`);
}
