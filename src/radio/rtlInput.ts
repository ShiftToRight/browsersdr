export interface RtlInputSettings {
  profile:
    | "generic"
    | "nesdr-smart-v5"
    | "rtl-blog-v3"
    | "rtl-blog-v4"
    | "always-on-bias";
  directSampling: "off" | "q";
  /** Device frequency = antenna RF frequency + converter offset. */
  converterOffsetHz: number;
  biasTee: boolean;
}
export const DEFAULT_RTL_INPUT: Readonly<RtlInputSettings> = Object.freeze({
  profile: "generic",
  directSampling: "off",
  converterOffsetHz: 0,
  biasTee: false,
});
export function normalizeRtlInput(
  value: RtlInputSettings = DEFAULT_RTL_INPUT,
): RtlInputSettings {
  if (
    ![
      "generic",
      "nesdr-smart-v5",
      "rtl-blog-v3",
      "rtl-blog-v4",
      "always-on-bias",
    ].includes(value.profile) ||
    !["off", "q"].includes(value.directSampling) ||
    typeof value.biasTee !== "boolean" ||
    !Number.isSafeInteger(value.converterOffsetHz) ||
    Math.abs(value.converterOffsetHz) > 1_000_000_000
  )
    throw new Error("Invalid RTL input or converter settings.");
  if (
    value.directSampling === "q" &&
    !["nesdr-smart-v5", "rtl-blog-v3"].includes(value.profile)
  )
    throw new Error(
      "Q-branch requires a declared compatible NESDR SMArt v5 or RTL-SDR Blog V3.",
    );
  if (value.directSampling === "q" && value.converterOffsetHz !== 0)
    throw new Error("Choose direct sampling or a converter, not both.");
  if (value.biasTee && !["rtl-blog-v3", "rtl-blog-v4"].includes(value.profile))
    throw new Error(
      "Software power requires a declared switchable RTL-SDR Blog V3/V4 bias tee.",
    );
  return {
    profile: value.profile,
    directSampling: value.directSampling,
    converterOffsetHz: value.converterOffsetHz,
    biasTee: value.biasTee,
  };
}
export function rtlDeviceFrequency(
  rfHz: number,
  input: RtlInputSettings,
): number {
  normalizeRtlInput(input);
  const deviceHz = rfHz + input.converterOffsetHz;
  if (
    !Number.isFinite(rfHz) ||
    rfHz <= 0 ||
    !Number.isSafeInteger(Math.round(deviceHz)) ||
    deviceHz <= 0
  )
    throw new Error("Invalid RF/device frequency.");
  if (input.directSampling === "q" && (rfHz < 100_000 || rfHz > 24_000_000))
    throw new Error(
      "This Q-branch profile covers 0.1–24 MHz; use filtering for direct-sampling aliases.",
    );
  if (
    input.converterOffsetHz !== 0 &&
    (deviceHz < 25_000_000 || deviceHz > 1_750_000_000)
  )
    throw new Error(
      "Converter output must fit the declared 25–1750 MHz tuner range.",
    );
  return deviceHz;
}
