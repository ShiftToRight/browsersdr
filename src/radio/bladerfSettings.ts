/** Nuand 35174c3 bladerf2_common.h / rfic_fpga.c. Public overall RX gain,
 * not calibrated RF power; the RFIC wire command uses the raw "full" stage. */
export const BLADERF_GAIN_MODES = {
  "slow-attack-agc": { code: 3, label: "Automatic · slow AGC" },
  "fast-attack-agc": { code: 2, label: "Automatic · fast AGC" },
  "hybrid-agc": { code: 4, label: "Automatic · hybrid AGC" },
  manual: { code: 1, label: "Manual" },
} as const;
export type BladeRfGainMode = keyof typeof BLADERF_GAIN_MODES;
export interface BladeRfRxSettings {
  kind: "bladerf";
  /** Physical connector labels. RFIC addresses are 0 and 2 respectively. */
  rxInput: "RX1" | "RX2";
  gainMode: BladeRfGainMode;
  manualGainDb: number;
}
export const DEFAULT_BLADERF_RX_SETTINGS: BladeRfRxSettings = {
  kind: "bladerf",
  rxInput: "RX1",
  gainMode: "slow-attack-agc",
  manualGainDb: 30,
};
export function bladeRfGainRange(frequencyHz: number) {
  if (
    !Number.isFinite(frequencyHz) ||
    frequencyHz < 70_000_000 ||
    frequencyHz > 6_000_000_000
  )
    throw new Error(
      "bladeRF gain requires an RX frequency from 70 MHz to 6 GHz.",
    );
  // Nuand searches inclusive ranges in this order.
  return frequencyHz <= 1_300_000_000
    ? { min: -16, max: 60, offset: -17 }
    : frequencyHz <= 4_000_000_000
      ? { min: -15, max: 60, offset: -11 }
      : { min: -12, max: 60, offset: -2 };
}
export function validateBladeRfRxSettings(
  value: BladeRfRxSettings,
  frequencyHz: number,
): BladeRfRxSettings {
  const range = bladeRfGainRange(frequencyHz);
  if (
    !value ||
    value.kind !== "bladerf" ||
    !["RX1", "RX2"].includes(value.rxInput) ||
    !Object.hasOwn(BLADERF_GAIN_MODES, value.gainMode) ||
    !Number.isInteger(value.manualGainDb) ||
    value.manualGainDb < range.min ||
    value.manualGainDb > range.max
  )
    throw new Error(
      `Invalid bladeRF RX settings: choose RX1/RX2, a supported gain mode, and ${range.min}–${range.max} dB integer gain.`,
    );
  return {
    kind: "bladerf",
    rxInput: value.rxInput,
    gainMode: value.gainMode,
    manualGainDb: value.manualGainDb,
  };
}
/** Retuning across gain-table bands clamps only the retained manual setpoint. */
export function bladeRfSettingsAtFrequency(
  value: BladeRfRxSettings,
  frequencyHz: number,
): BladeRfRxSettings {
  const range = bladeRfGainRange(frequencyHz);
  return validateBladeRfRxSettings(
    {
      ...value,
      manualGainDb: Math.max(
        range.min,
        Math.min(range.max, value.manualGainDb),
      ),
    },
    frequencyHz,
  );
}
