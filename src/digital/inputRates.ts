/** Explicit acquisition clocks supported by the integer channel reducer. */
export const DIGITAL_SUPPORTED_INPUT_RATES_HZ = [1_024_000, 2_400_000, 3_200_000] as const;
export type DigitalInputSampleRateHz = (typeof DIGITAL_SUPPORTED_INPUT_RATES_HZ)[number];

/** Preserve the existing 64/60 and 128/120 ksample/s profiles. */
export function digitalInputProfile(rate: number): { narrowRateHz: number; sensorRateHz: number } {
  switch (rate) {
    case 1_024_000:
    case 3_200_000:
      return { narrowRateHz: 64_000, sensorRateHz: 128_000 };
    case 2_400_000:
      return { narrowRateHz: 60_000, sensorRateHz: 120_000 };
    default:
      throw new Error("Digital channel input rate must be 1.024, 2.4 or 3.2 MS/s.");
  }
}
