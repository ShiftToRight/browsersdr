import {
  type DigitalChannelConfiguration,
  validateDigitalChannelConfiguration,
} from "../digital";
import {
  SRD_MAX_TRACE_POINTS,
  type SrdBitSliceSettings,
  type SrdBurstSettings,
  type SrdModulation,
  type SrdProtocol,
  type SrdThresholdSettings,
  type SrdTraceSettings,
} from "./types";

export interface SrdConfiguration extends DigitalChannelConfiguration {
  modulation: SrdModulation;
  protocol: SrdProtocol;
  threshold: SrdThresholdSettings;
  burst: SrdBurstSettings;
  trace: SrdTraceSettings;
  bitSlice: SrdBitSliceSettings;
}

/** Persisted/user-facing SRD settings. Runtime rate, offset and generation are
 * deliberately supplied by the receiver route, never by UI state. */
export type SrdModeSettings = Omit<
  SrdConfiguration,
  | "actualInputSampleRateHz"
  | "selectedChannelOffsetHz"
  | "generation"
  | "outputSampleRateHz"
>;

export function defaultSrdModeSettings(): SrdModeSettings {
  const configuration = defaultSrdConfiguration(1_024_000, 0);
  const {
    actualInputSampleRateHz: _rate,
    selectedChannelOffsetHz: _offset,
    generation: _generation,
    outputSampleRateHz: _outputRate,
    ...settings
  } = configuration;
  return settings;
}

export function srdConfigurationForRoute(
  settings: SrdModeSettings,
  actualInputSampleRateHz: 1_024_000 | 2_400_000,
  selectedChannelOffsetHz: number,
  generation: number,
): SrdConfiguration {
  const outputSampleRateHz =
    actualInputSampleRateHz === 1_024_000 ? 128_000 : 120_000;
  const configuration = {
    ...structuredClone(settings),
    actualInputSampleRateHz,
    selectedChannelOffsetHz,
    generation,
    outputSampleRateHz,
  };
  validateSrdConfiguration(configuration);
  return configuration;
}

export function defaultSrdConfiguration(
  actualInputSampleRateHz: 1_024_000 | 2_400_000,
  generation: number,
  selectedChannelOffsetHz = 0,
): SrdConfiguration {
  return {
    actualInputSampleRateHz,
    selectedChannelOffsetHz,
    generation,
    channelBandwidthHz: 32_000,
    outputSampleRateHz:
      actualInputSampleRateHz === 1_024_000 ? 128_000 : 120_000,
    modulation: "ook",
    protocol: "none",
    threshold: {
      mode: "adaptive",
      carrierLevel: 0.2,
      minimumCarrierMargin: 0.025,
      carrierNoiseRatio: 3,
      carrierHysteresis: 0.01,
      discriminatorHz: 0,
      discriminatorHysteresisHz: 500,
    },
    burst: {
      minimumDurationUs: 500,
      maximumDurationUs: 250_000,
      endGapUs: 4_000,
    },
    trace: {
      decimation: 8,
      maximumPoints: 512,
      publicationIntervalInputSamples: Math.round(actualInputSampleRateHz / 10),
    },
    bitSlice: {
      enabled: false,
      symbolUs: 500,
      encoding: "nrz",
      polarity: "normal",
    },
  };
}

export function validateSrdConfiguration(
  configuration: SrdConfiguration,
): void {
  validateDigitalChannelConfiguration(configuration);
  if (
    (["acurite-592txr", "fineoffset-wh2"].includes(configuration.protocol) &&
      configuration.modulation !== "ook") ||
    (configuration.protocol === "fineoffset-wh51" &&
      configuration.modulation !== "2fsk")
  )
    throw new Error(
      "The selected SRD protocol does not match the selected modulation.",
    );
  const threshold = configuration.threshold;
  for (const [name, value] of Object.entries(threshold)) {
    if (name === "mode") continue;
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`SRD threshold ${name} must be finite and non-negative.`);
  }
  if (threshold.carrierNoiseRatio <= 1)
    throw new Error("SRD adaptive carrier ratio must be greater than one.");
  const burst = configuration.burst;
  if (
    !Number.isFinite(burst.minimumDurationUs) ||
    !Number.isFinite(burst.maximumDurationUs) ||
    !Number.isFinite(burst.endGapUs) ||
    burst.minimumDurationUs <= 0 ||
    burst.maximumDurationUs < burst.minimumDurationUs ||
    burst.endGapUs <= 0
  )
    throw new Error("SRD burst durations are invalid.");
  if (
    !Number.isInteger(configuration.trace.decimation) ||
    configuration.trace.decimation < 1 ||
    !Number.isInteger(configuration.trace.maximumPoints) ||
    configuration.trace.maximumPoints < 1 ||
    configuration.trace.maximumPoints > SRD_MAX_TRACE_POINTS ||
    !Number.isSafeInteger(
      configuration.trace.publicationIntervalInputSamples,
    ) ||
    configuration.trace.publicationIntervalInputSamples < 1
  )
    throw new Error("SRD trace bounds or publication interval are invalid.");
  if (
    configuration.bitSlice.enabled &&
    (!Number.isFinite(configuration.bitSlice.symbolUs) ||
      configuration.bitSlice.symbolUs <= 0)
  )
    throw new Error(
      "SRD bit-slice symbol duration must be positive and finite.",
    );
}
