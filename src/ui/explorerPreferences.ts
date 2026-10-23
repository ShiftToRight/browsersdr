import type { ExplorerScanScope } from "./SpectrumExplorer";
import type { SurveyDetectorMode } from "../radio/fieldSurvey";
import { MONITOR_PRESETS, type MonitorPreset } from "../radio/monitorDetection";
import type { MonitorTargetMode } from "./CustomMonitorTargets";

export const EXPLORER_PREFERENCES_KEY = "browsersdr.explorerPreferences.v1";
export const CUSTOM_TARGET_DRAFT_KEY = "browsersdr.customMonitorDraft.v1";
export interface ExplorerPreferences {
  activity?: "survey" | "monitor";
  monitorTargetMode?: MonitorTargetMode;
  monitorPreset?: MonitorPreset;
  scope?: ExplorerScanScope;
  selectedBandId?: string;
  bandName?: string;
  startMhz?: number;
  endMhz?: number;
  dwellMs?: number;
  thresholdDb?: number;
  detector?: SurveyDetectorMode;
}
export function readPreference(key: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const pending = new Map<string, unknown>();
export const PREFERENCE_EVENT = "browsersdr:preference";
export function preferenceFailures() {
  return pending.size;
}
export function retryPreferences() {
  for (const [key, value] of pending) storePreference(key, value);
}
export function storePreference(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    pending.delete(key);
  } catch {
    pending.set(key, value);
    window.dispatchEvent(
      new CustomEvent(PREFERENCE_EVENT, { detail: { key, saved: false } }),
    );
    return false;
  }
  window.dispatchEvent(
    new CustomEvent(PREFERENCE_EVENT, { detail: { key, saved: true } }),
  );
  return true;
}
export function loadExplorerPreferences(
  v = readPreference(EXPLORER_PREFERENCES_KEY),
): ExplorerPreferences {
  const result: ExplorerPreferences = {};
  if (v.activity === "monitor" || v.activity === "survey")
    result.activity = v.activity;
  if (
    ["window", "band-plan", "range", "frequencies"].includes(
      String(v.monitorTargetMode),
    )
  )
    result.monitorTargetMode = v.monitorTargetMode as MonitorTargetMode;
  if (
    typeof v.monitorPreset === "string" &&
    Object.hasOwn(MONITOR_PRESETS, v.monitorPreset)
  )
    result.monitorPreset = v.monitorPreset as MonitorPreset;
  if (["window", "band-plan", "full"].includes(String(v.scope)))
    result.scope = v.scope as ExplorerScanScope;
  for (const key of ["selectedBandId", "bandName"] as const)
    if (typeof v[key] === "string" && v[key].length <= 200)
      result[key] = v[key];
  for (const key of ["startMhz", "endMhz", "dwellMs", "thresholdDb"] as const) {
    const value = v[key];
    const [min, max] =
      key === "dwellMs"
        ? [150, 10000]
        : key === "thresholdDb"
          ? [1, 40]
          : [0, 100000];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max
    )
      result[key] = value;
  }
  if (
    ["average", "max-hold", "occupancy", "wideband"].includes(
      String(v.detector),
    )
  )
    result.detector = v.detector as SurveyDetectorMode;
  return result;
}

export const PRESENTATION_KEY = "browsersdr.explorerPresentation.v1";
export function presentationValue<T extends string | number | boolean>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): T {
  const value = readPreference(PRESENTATION_KEY)[key];
  return typeof value === typeof fallback &&
    (!allowed || allowed.includes(value as T))
    ? (value as T)
    : fallback;
}
export function savePresentation(
  key: string,
  value: string | number | boolean,
) {
  return storePreference(PRESENTATION_KEY, {
    ...readPreference(PRESENTATION_KEY),
    [key]: value,
  });
}
