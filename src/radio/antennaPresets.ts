import type { AntennaUnits } from "./antennaGuide";
import {
  DEFAULT_WHIP,
  isAntennaChoice,
  parseWhipLimits,
  convertWhipLimits,
  type AntennaChoice,
  type SelectedAntenna,
  type WhipPreferences,
} from "./antennaDesigns";

export const ANTENNA_PRESETS = [
  {
    id: "ant500",
    name: "Great Scott Gadgets ANT500",
    antenna: "whip",
    minimumM: 0.2,
    maximumM: 0.88,
    fixedSectionM: 0,
    range: [75e6, 1e9],
    note: "ANT500: published total length 20–88 cm, advertised 75 MHz–1 GHz. This is a provisional envelope, not a measured radiator range. Confirm the exposed mast lengths and edit the limits if needed.",
    url: "https://greatscottgadgets.com/ant500/",
    date: "Publication date unknown",
  },
  {
    id: "ant700",
    name: "Great Scott Gadgets ANT700",
    antenna: "whip",
    minimumM: 0.095,
    maximumM: 0.245,
    fixedSectionM: 0,
    range: [300e6, 1100e6],
    note: "ANT700: published total length 9.5–24.5 cm, advertised 300–1100 MHz. This is a provisional envelope; confirm the exposed mast measurements before relying on fit.",
    url: "https://greatscottgadgets.com/ant700/",
    date: "Publication date unknown",
  },
  {
    id: "rtl-long",
    name: "RTL-SDR Blog dipole · long elements",
    antenna: "dipole",
    minimumM: 0.23,
    maximumM: 1,
    fixedSectionM: 0.02,
    note: "Long elements: listed adjustable length 23–100 cm per arm. The kit instructions account for about 2 cm of internal metal per arm; this preset uses that provisional fixed section. Measure the actual feed-point-to-tip length and adjust the values if needed.",
    url: "https://www.rtl-sdr.com/using-our-new-dipole-antenna-kit/",
    date: "26 September 2017 · instructions",
  },
  {
    id: "rtl-short",
    name: "RTL-SDR Blog dipole · short elements",
    antenna: "dipole",
    minimumM: 0.05,
    maximumM: 0.13,
    fixedSectionM: 0.02,
    note: "Short elements: the product lists 5–13 cm per arm, while its instructions' cheat sheet says 14 cm fully extended, plus about 2 cm internal metal. This preset uses the listed 13 cm maximum and a provisional 2 cm fixed section. Confirm the actual kit dimensions.",
    url: "https://www.rtl-sdr.com/product/rtl-sdr-blog-multipurpose-dipole-antenna-kit/",
    date: "22 December 2017 · product listing",
  },
  {
    id: "ratlsnake",
    name: "Nooelec RaTLSnake · telescopic mast",
    antenna: "telescopic",
    fixedSectionM: 0,
    range: [100e6, 800e6],
    note: "RaTLSnake: magnetic-base telescopic setup, advertised approximately 100–800 MHz depending on extension. Mechanical extension limits are not published in the inspected FAQ. Enter measured mast limits; none are assumed here.",
    url: "https://support.nooelec.com/hc/en-us/articles/360005814794-RF-Accessories-Balun-Antennas",
    date: "24 September 2019 · updated FAQ",
  },
] as const;
export type BuiltinPresetId = (typeof ANTENNA_PRESETS)[number]["id"];
export const builtinPreset = (id: string) =>
  ANTENNA_PRESETS.find((p) => p.id === id);
export const dimensionUnitM = (units: AntennaUnits) =>
  units === "metric" ? 0.01 : 0.0254;
export const dimensionText = (m: number | undefined, units: AntennaUnits) =>
  m === undefined ? "" : String(Number((m / dimensionUnitM(units)).toFixed(6)));

export interface CustomAntennaPreset {
  id: string;
  name: string;
  antenna: SelectedAntenna;
  minimumM?: number;
  maximumM?: number;
  fixedSectionM: number;
  showEighth: boolean;
  originPreset: string;
}
export const customPresetKey = "browsersdr.antenna-presets.v1";
export const MAX_CUSTOM_PRESETS = 20;
export function customNameError(name: string) {
  return !name.trim()
    ? "Enter a name for this preset."
    : name.trim().length > 48 ||
        Array.from(name).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      ? "Use a name of up to 48 characters without control characters."
      : undefined;
}
export function sanitizeCustomPresets(value: unknown): CustomAntennaPreset[] {
  if (!Array.isArray(value)) return [];
  const result: CustomAntennaPreset[] = [];
  for (const item of value.slice(0, MAX_CUSTOM_PRESETS)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      !/^saved-[a-zA-Z0-9-]{1,64}$/.test(p.id) ||
      typeof p.name !== "string" ||
      customNameError(p.name) ||
      !isAntennaChoice(p.antenna) ||
      p.antenna === "recommended"
    )
      continue;
    const validLength = (v: unknown, allowZero = false) =>
      typeof v === "number" &&
      Number.isFinite(v) &&
      v >= (allowZero ? 0 : Number.MIN_VALUE) &&
      v <= 1000;
    if (
      (p.minimumM !== undefined && !validLength(p.minimumM)) ||
      (p.maximumM !== undefined && !validLength(p.maximumM)) ||
      !validLength(p.fixedSectionM, true) ||
      (typeof p.minimumM === "number" &&
        typeof p.maximumM === "number" &&
        p.minimumM > p.maximumM)
    )
      continue;
    if (
      result.some(
        (prev) =>
          prev.id === p.id ||
          prev.name.toLowerCase() === (p.name as string).trim().toLowerCase(),
      )
    )
      continue;
    result.push({
      id: p.id,
      name: p.name.trim(),
      antenna: p.antenna,
      minimumM: p.minimumM as number | undefined,
      maximumM: p.maximumM as number | undefined,
      fixedSectionM: p.fixedSectionM as number,
      showEighth: p.showEighth === true,
      originPreset:
        typeof p.originPreset === "string" &&
        builtinPreset(p.originPreset)?.antenna === p.antenna
          ? p.originPreset
          : "",
    });
  }
  return result;
}
export function readCustomPresets(): CustomAntennaPreset[] {
  try {
    const saved = JSON.parse(localStorage.getItem(customPresetKey) ?? "null");
    return saved?.version === 1 ? sanitizeCustomPresets(saved.presets) : [];
  } catch {
    return [];
  }
}
export function fixedSectionM(
  preferences: WhipPreferences,
  units: AntennaUnits,
): number | undefined {
  const text = preferences.fixedSection.trim();
  if (!text || /^0+(?:[.,]0+)?$/.test(text)) return 0;
  const parsed = parseWhipLimits(text, "", units);
  return parsed.error ? undefined : parsed.minimumM;
}
export function presetSettings(
  id: string,
  units: AntennaUnits,
  custom: readonly CustomAntennaPreset[] = [],
): (WhipPreferences & { antenna: AntennaChoice }) | undefined {
  const entry = builtinPreset(id) ?? custom.find((p) => p.id === id);
  if (!entry) return undefined;
  return {
    preset: entry.id,
    antenna: entry.antenna,
    minimum: dimensionText(
      "minimumM" in entry ? entry.minimumM : undefined,
      units,
    ),
    maximum: dimensionText(
      "maximumM" in entry ? entry.maximumM : undefined,
      units,
    ),
    fixedSection: dimensionText(entry.fixedSectionM, units),
    showEighth: "showEighth" in entry ? entry.showEighth : false,
    originPreset: "originPreset" in entry ? entry.originPreset : entry.id,
  };
}
export function convertPresetDimensions(
  prefs: WhipPreferences,
  from: AntennaUnits,
  to: AntennaUnits,
) {
  const canonical = builtinPreset(prefs.preset)
    ? presetSettings(prefs.preset, to)
    : undefined;
  return canonical
    ? {
        ...prefs,
        minimum: canonical.minimum,
        maximum: canonical.maximum,
        fixedSection: canonical.fixedSection,
      }
    : convertWhipLimits(prefs, from, to);
}
export function customPresetFromSettings(
  id: string,
  name: string,
  antenna: AntennaChoice,
  prefs: WhipPreferences,
  units: AntennaUnits,
): CustomAntennaPreset | string {
  const error = customNameError(name);
  if (error) return error;
  if (antenna === "recommended")
    return "Choose a specific antenna type before saving.";
  const dimensionsApply =
    antenna === "whip" || antenna === "telescopic" || antenna === "dipole";
  const limits = dimensionsApply
    ? parseWhipLimits(prefs.minimum, prefs.maximum, units)
    : {};
  if (limits.error) return limits.error;
  const fixed = antenna === "dipole" ? fixedSectionM(prefs, units) : 0;
  if (fixed === undefined)
    return "Enter a non-negative fixed feed section up to 1,000 m.";
  return {
    id,
    name: name.trim(),
    antenna,
    minimumM: limits.minimumM,
    maximumM: limits.maximumM,
    fixedSectionM: fixed,
    showEighth: prefs.showEighth,
    originPreset: prefs.originPreset,
  };
}
export function compatiblePreset(
  id: string,
  antenna: AntennaChoice,
  custom: readonly CustomAntennaPreset[],
) {
  return (
    (builtinPreset(id) ?? custom.find((p) => p.id === id))?.antenna === antenna
  );
}
export function resetDimensions(showEighth: boolean) {
  return { ...DEFAULT_WHIP, showEighth };
}
