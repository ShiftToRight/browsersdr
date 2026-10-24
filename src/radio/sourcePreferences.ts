import { normalizeRtlInput, type RtlInputSettings } from "./rtlInput";
import { DEFAULT_BLADERF_RX_SETTINGS, type BladeRfRxSettings } from "./bladerfSettings";
import { defaultModeSettings, normalizeModeSettings, validateModeSampleRate, type ReceiverMode, type ReceiverModeSettings } from "./receiverConfig";
import { channelSampleRate, DEFAULT_HACKRF_RX_SETTINGS, sourceCapabilities, validateSourceConfiguration, type HackrfRxSettings } from "./sourceCapabilities";
import { DEFAULT_USRP_B205_RX_SETTINGS, type UsrpB205RxSettings } from "./usrpB205Capabilities";
import type { SourceKind } from "./types";

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export interface SourcePreferences {
  frequencyHz: number;
  modeSettings: ReceiverModeSettings;
  sampleRateHz: number;
  gainDb?: number | null;
  rtlInput?: RtlInputSettings;
  hardwareSettings?: HackrfRxSettings;
  usrpSettings?: UsrpB205RxSettings;
  bladerfSettings?: BladeRfRxSettings;
}
const key = (source: SourceKind) => `browsersdr.source.v1.${source}`;
export function compatibleSourceRate(source: SourceKind, mode: ReceiverMode, preferred: number): number | undefined {
  const caps = sourceCapabilities(source);
  if (!caps.modes.includes(mode)) return undefined;
  const rates = caps.rates.kind === "choices" ? caps.rates.valuesHz : [preferred];
  return [preferred, ...rates].find((rate) => {
    if (!rates.includes(rate)) return false;
    try { validateModeSampleRate(mode, source === "hackrf" || source === "bladerf" || source === "usrp-b205" || source === "replay" ? channelSampleRate(rate) : rate); return true; } catch { return false; }
  });
}
export function sourcePreferenceDefaults(source: SourceKind): SourcePreferences {
  const caps = sourceCapabilities(source);
  return { frequencyHz: 100_000_000, modeSettings: defaultModeSettings("WBFM"), sampleRateHz: caps.rates.kind === "choices" ? caps.rates.defaultHz : 1_024_000,
    ...(source === "bladerf" ? { bladerfSettings: { ...DEFAULT_BLADERF_RX_SETTINGS } } : {}),
    ...(source === "rtl-sdr" ? { gainDb: null } : {}),
    ...(source === "hackrf" ? { hardwareSettings: { ...DEFAULT_HACKRF_RX_SETTINGS } } : {}),
    ...(source === "usrp-b205" ? { usrpSettings: { ...DEFAULT_USRP_B205_RX_SETTINGS } } : {}) };
}
function validate(source: SourceKind, value: SourcePreferences): SourcePreferences {
  if (!value || !value.modeSettings || typeof value.sampleRateHz !== "number") throw new Error("Invalid source preferences");
  validateSourceConfiguration({ source, channelFrequencyHz: value.frequencyHz, modeSettings: value.modeSettings, sampleRateHz: value.sampleRateHz, gainDb: value.gainDb, rtlInput: value.rtlInput, hardwareSettings: value.hardwareSettings, usrpSettings: value.usrpSettings, bladerfSettings: value.bladerfSettings });
  if (compatibleSourceRate(source, value.modeSettings.mode, value.sampleRateHz) !== value.sampleRateHz) throw new Error("Incompatible saved rate");
  return { frequencyHz: value.frequencyHz, modeSettings: normalizeModeSettings(value.modeSettings), sampleRateHz: value.sampleRateHz,
    ...(source === "bladerf" ? { bladerfSettings: { ...(value.bladerfSettings ?? DEFAULT_BLADERF_RX_SETTINGS) } } : {}),
    ...(source === "rtl-sdr" ? { gainDb: value.gainDb ?? null, rtlInput: {...normalizeRtlInput(value.rtlInput),biasTee:false} } : {}),
    ...(source === "hackrf" ? { hardwareSettings: { ...(value.hardwareSettings ?? DEFAULT_HACKRF_RX_SETTINGS), antennaPowerEnabled:false } } : {}),
    ...(source === "usrp-b205" ? { usrpSettings: { ...(value.usrpSettings ?? DEFAULT_USRP_B205_RX_SETTINGS) } } : {}) };
}
export function loadSourcePreferences(storage: StorageAccess, source: SourceKind): SourcePreferences {
  const defaults = sourcePreferenceDefaults(source);
  try {
    const saved = storage.getItem(key(source));
    if (saved !== null) return validate(source, JSON.parse(saved) as SourcePreferences);
    // Unscoped settings belonged exclusively to RTL; never migrate them into another source.
    if (source === "rtl-sdr") {
      const number = (name: string, fallback: number) => { const raw = storage.getItem(`browsersdr.${name}`); return raw === null ? fallback : Number(raw); };
      const mode = (storage.getItem("browsersdr.mode") ?? "WBFM") as ReceiverMode;
      const settings = defaultModeSettings(mode);
      const rawGain = storage.getItem("browsersdr.gainDb");
      return validate(source, { frequencyHz: number("channelFrequencyMhz", number("fmFrequencyMhz", 100)) * 1_000_000,
        modeSettings: { mode, bandwidthHz: number("bandwidthHz", settings.bandwidthHz), squelch: number("squelch", settings.squelch) },
        sampleRateHz: compatibleSourceRate(source, mode, number("sampleRateHz", defaults.sampleRateHz)) ?? defaults.sampleRateHz,
        gainDb: rawGain === null || rawGain === "auto" ? null : Number(rawGain) });
    }
  } catch { /* Malformed, unavailable or incompatible storage uses safe source defaults. */ }
  return defaults;
}
export function saveSourcePreferences(storage: StorageAccess, source: SourceKind, value: SourcePreferences): void {
  try { storage.setItem(key(source), JSON.stringify(validate(source, value))); if (source !== "replay") storage.setItem("browsersdr.selectedSource", source); } catch { /* Never persist invalid drafts; storage is optional. */ }
}


export function sourceModeUnavailableReason(source: SourceKind, mode: ReceiverMode, rate: number, fixedRate: boolean): string | undefined {
  const caps = sourceCapabilities(source);
  if (!caps.modes.includes(mode)) return `Unavailable with ${caps.label}`;
  try {
    if (fixedRate) validateModeSampleRate(mode, source === "hackrf" || source === "bladerf" || source === "usrp-b205" || source === "replay" ? channelSampleRate(rate) : rate);
    else if (compatibleSourceRate(source, mode, rate) === undefined) throw new Error("No compatible rate");
  } catch { return source === "replay" ? "Requires a recording with a compatible sample rate" : "Requires a compatible sample rate"; }
}


export function loadSourceSelection(storage: StorageAccess): SourceKind {
  try { const value = storage.getItem("browsersdr.selectedSource"); if (value === "hackrf" || value === "bladerf" || value === "usrp-b205" || value === "synthetic") return value; } catch { /* Optional preference. */ }
  // Replay needs a file chosen during this page session.
  return "rtl-sdr";
}
