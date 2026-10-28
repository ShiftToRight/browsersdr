/** Airspy R2/Mini receive controls. Stage values are register indices, not dB. */
export const AIRSPY_USB_FILTER = {
  vendorId: 0x1d50,
  productId: 0x60a1,
} as const;
export const AIRSPY_SAMPLE_RATES = [
  2_500_000, 3_000_000, 6_000_000, 10_000_000,
] as const;
export const AIRSPY_OUTPUT_RATES = [
  ...new Set(
    AIRSPY_SAMPLE_RATES.flatMap((rate) =>
      [1, 2, 4, 8, 16, 32, 64].map((factor) => rate / factor),
    ),
  ),
];
export const isAirspyRate = (rate: number) =>
  AIRSPY_OUTPUT_RATES.includes(rate);
export const airspyChannelRate = (rate: number) =>
  [
    2_400_000, 1_024_000, 512_000, 256_000, 128_000, 64_000, 32_000, 16_000,
    8_000,
  ].find((candidate) => candidate <= rate)!;
export interface AirspySettings {
  kind: "airspy";
  gainMode: "manual" | "linearity" | "sensitivity";
  gain: number;
  lna: number;
  mixer: number;
  vga: number;
  lnaAgc: boolean;
  mixerAgc: boolean;
  biasTee: boolean;
  packing: boolean;
  conversionFilter: "standard" | "sharp";
  decimation: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  ppm: number;
}
export const DEFAULT_AIRSPY_SETTINGS: Readonly<AirspySettings> = Object.freeze({
  kind: "airspy",
  gainMode: "linearity",
  gain: 10,
  lna: 8,
  mixer: 0,
  vga: 10,
  lnaAgc: false,
  mixerAgc: false,
  biasTee: false,
  packing: false,
  conversionFilter: "standard",
  decimation: 1,
  ppm: 0,
});
export interface AirspyIdentity {
  boardId: number;
  firmware: string;
  serial: string;
  sampleRates: number[];
  /** Both models report board ID zero. Infer the rate profile, not a board revision. */
  rateProfile: "r2" | "mini";
}
export interface AirspySessionDetails {
  identity: AirspyIdentity;
  settings: AirspySettings;
  deviceSampleRateHz: number;
  adcSampleRateHz: number;
  outputSampleRateHz: number;
  requestedCenterFrequencyHz: number;
  correctedDeviceFrequencyHz: number;
  rateEvidence: "firmware-advertised-and-usb-acknowledged";
  conversion: "airspy-fs4-real-to-iq-v1";
}
export function validateAirspySettings(value: AirspySettings): AirspySettings {
  if (
    !value ||
    value.kind !== "airspy" ||
    !["manual", "linearity", "sensitivity"].includes(value.gainMode)
  )
    throw new Error("Choose an Airspy gain mode.");
  for (const [name, max] of [
    ["gain", 21],
    ["lna", 14],
    ["mixer", 15],
    ["vga", 15],
  ] as const)
    if (!Number.isInteger(value[name]) || value[name] < 0 || value[name] > max)
      throw new Error(`Airspy ${name} must be an integer from 0 to ${max}.`);
  for (const key of ["lnaAgc", "mixerAgc", "biasTee", "packing"] as const)
    if (typeof value[key] !== "boolean")
      throw new Error(`Airspy ${key} must be boolean.`);
  if (
    ![1, 2, 4, 8, 16, 32, 64].includes(value.decimation) ||
    !["standard", "sharp"].includes(value.conversionFilter)
  )
    throw new Error(
      "Choose a supported Airspy conversion filter and decimation.",
    );
  if (!Number.isFinite(value.ppm) || Math.abs(value.ppm) > 100)
    throw new Error(
      "Airspy frequency correction must be between −100 and 100 ppm.",
    );
  return { ...value };
}
