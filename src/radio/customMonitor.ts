import {
  validateSurveyProfile,
  type SurveyBand,
  type SurveyProfile,
} from "./fieldSurvey";
import { SCAN_USABLE_FRACTION } from "./spectrumScan";
import { validateSourceFrequency } from "./sourceCapabilities";
import type { SourceSessionMetadata } from "./types";

export const MAX_MONITOR_TARGETS = 64;
export const WATCHLIST_KEY = "browsersdr.monitor-watchlists.v1";
export interface MonitorTarget {
  id: string;
  kind: "frequency" | "range";
  label: string;
  startFrequencyHz: number;
  endFrequencyHz: number;
}
export interface MonitorWatchlist {
  version: 1;
  id: string;
  name: string;
  targets: MonitorTarget[];
}
export function parseMonitorFrequency(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(Hz|kHz|MHz|GHz)\s*$/i.exec(value);
  if (!match)
    throw new Error("Use an explicit unit, for example 99.77 MHz or 12500 Hz.");
  const hz =
    Number(match[1]) *
    { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }[match[2]!.toLowerCase()]!;
  if (!Number.isSafeInteger(hz) || hz <= 0 || hz > 6e9)
    throw new Error("Enter whole Hz above zero and at most 6 GHz.");
  return hz;
}
export function frequencyTarget(
  frequencyHz: number,
  widthHz: number,
  label = "",
): MonitorTarget {
  return {
    id: crypto.randomUUID(),
    kind: "frequency",
    label,
    startFrequencyHz: frequencyHz - widthHz / 2,
    endFrequencyHz: frequencyHz + widthHz / 2,
  };
}
export function validateMonitorTargets(value: unknown): MonitorTarget[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_MONITOR_TARGETS
  )
    throw new Error("Choose 1–64 monitor targets.");
  const ids = new Set<string>(),
    bounds = new Set<string>();
  return value.map((raw: MonitorTarget) => {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id) ||
      ids.has(raw.id) ||
      !["frequency", "range"].includes(raw.kind) ||
      typeof raw.label !== "string" ||
      raw.label.length > 100 ||
      !Number.isFinite(raw.startFrequencyHz) ||
      !Number.isFinite(raw.endFrequencyHz) ||
      raw.startFrequencyHz <= 0 ||
      raw.endFrequencyHz > 6e9 ||
      raw.endFrequencyHz <= raw.startFrequencyHz
    )
      throw new Error(
        "Invalid monitor target: check IDs, labels and positive frequency bounds.",
      );
    const key = `${raw.startFrequencyHz}:${raw.endFrequencyHz}`;
    if (bounds.has(key))
      throw new Error("Duplicate target bounds. Remove the duplicate entry.");
    ids.add(raw.id);
    bounds.add(key);
    return {
      id: raw.id,
      kind: raw.kind,
      label: raw.label.trim(),
      startFrequencyHz: raw.startFrequencyHz,
      endFrequencyHz: raw.endFrequencyHz,
    };
  });
}
export function targetContains(
  target: MonitorTarget,
  frequencyHz: number,
): boolean {
  return (
    frequencyHz >= target.startFrequencyHz &&
    frequencyHz <= target.endFrequencyHz
  );
}
/** Merge overlaps before grouping nearby targets: one FFT visit contributes only once to a signal. */
export function customMonitorProfile(
  profile: SurveyProfile,
  template: SurveyBand,
  value: unknown,
  receiver: SourceSessionMetadata,
): SurveyProfile {
  const targets = validateMonitorTargets(value);
  const usable = receiver.actualSampleRateHz * SCAN_USABLE_FRACTION;
  const groups: { lower: number; upper: number }[] = [];
  for (const t of [...targets].sort(
    (a, b) => a.startFrequencyHz - b.startFrequencyHz,
  )) {
    validateSourceFrequency(
      receiver.source,
      Math.floor(t.startFrequencyHz),
      0,
      receiver.hackrf?.capabilities.identity,
    );
    validateSourceFrequency(
      receiver.source,
      Math.ceil(t.endFrequencyHz),
      0,
      receiver.hackrf?.capabilities.identity,
    );
    if (
      t.endFrequencyHz - t.startFrequencyHz <
      (2 * receiver.actualSampleRateHz) / 4096
    )
      throw new Error(
        "Watch region is narrower than two FFT bins at this sample rate. Increase watch width or lower the sample rate.",
      );
    if (
      t.kind === "frequency" &&
      t.endFrequencyHz - t.startFrequencyHz > usable
    )
      throw new Error(
        "Watch width exceeds the usable receiver window. Narrow it, increase sample rate, or use Custom range.",
      );
    const last = groups.at(-1);
    if (
      last &&
      (t.startFrequencyHz <= last.upper ||
        Math.max(last.upper, t.endFrequencyHz) - last.lower <= usable)
    )
      last.upper = Math.max(last.upper, t.endFrequencyHz);
    else groups.push({ lower: t.startFrequencyHz, upper: t.endFrequencyHz });
  }
  return validateSurveyProfile({
    ...profile,
    name: "Custom monitor",
    bands: groups.map((g, i) => ({
      ...template,
      id: `custom-${i}`,
      name: `Custom region ${i + 1}`,
      startFrequencyHz: Math.floor(g.lower),
      endFrequencyHz: Math.ceil(g.upper),
    })),
  });
}
export function validateWatchlists(value: unknown): MonitorWatchlist[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    JSON.stringify(value).length > 256_000
  )
    throw new Error(
      "Watchlists exceed the supported size (32 lists / 256 KB).",
    );
  const ids = new Set<string>();
  return value.map((w: MonitorWatchlist) => {
    if (
      !w ||
      w.version !== 1 ||
      typeof w.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(w.id) ||
      ids.has(w.id) ||
      typeof w.name !== "string" ||
      !w.name.trim() ||
      w.name.length > 100
    )
      throw new Error("Invalid watchlist name, ID or version.");
    if (validateMonitorTargets(w.targets).some((t) => t.kind !== "frequency"))
      throw new Error("Watchlists contain individual frequency targets.");
    ids.add(w.id);
    return {
      version: 1,
      id: w.id,
      name: w.name.trim(),
      targets: validateMonitorTargets(w.targets),
    };
  });
}
export function loadWatchlists(): MonitorWatchlist[] {
  const saved = localStorage.getItem(WATCHLIST_KEY);
  return saved ? validateWatchlists(JSON.parse(saved)) : [];
}
export function saveWatchlists(value: MonitorWatchlist[]): MonitorWatchlist[] {
  const lists = validateWatchlists(value);
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(lists));
  return lists;
}
