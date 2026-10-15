import { isTextMode, normalizeTextModemSettings } from "../textmodem/settings";
import {
  defaultModeSettings,
  modeCapabilities,
  normalizeModeSettings,
  RECEIVER_MODES,
  type ReceiverModeSettings,
} from "./receiverConfig";
import { defaultSrdModeSettings } from "../srd/settings";
import {
  readReceptionCandidate,
  type ReceptionCandidate,
} from "./receptionEvidence";
import type { SourceKind } from "./types";

export const BOOKMARK_KEY = "browsersdr.bookmarks.v1";
export const BOOKMARK_SCHEMA = "browsersdr-bookmarks-v1";
export const MAX_BOOKMARKS = 200;
export const MAX_BOOKMARK_BYTES = 256 * 1024;
export interface Bookmark {
  id: string;
  name: string;
  frequencyHz: number;
  settings: ReceiverModeSettings;
  tags: string[];
  notes: string;
  sourceHint?: SourceKind;
  atlasReference?: ReceptionCandidate;
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid favorite object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(
      `Favorite text must be ${required ? "1–" : "0–"}${max} characters.`,
    );
  return value.trim();
}
// Copy only the supported SRD shape; arbitrary imported properties never enter persistence or DSP.
function shape(value: unknown, template: unknown): unknown {
  if (typeof template !== "object" || template === null) {
    if (
      typeof value !== typeof template ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Invalid SRD favorite settings.");
    return value;
  }
  const row = object(value);
  return Object.fromEntries(
    Object.entries(template).map(([key, child]) => [
      key,
      shape(row[key], child),
    ]),
  );
}
export function validateBookmark(value: unknown): Bookmark {
  const row = object(value);
  if (typeof row.id !== "string" || !uuid.test(row.id))
    throw new Error("Favorite ID must be a UUID.");
  if (
    typeof row.frequencyHz !== "number" ||
    !Number.isSafeInteger(row.frequencyHz) ||
    row.frequencyHz < 1 ||
    row.frequencyHz > 6e9
  )
    throw new Error(
      "Favorite frequency must be integer Hz between 1 Hz and 6 GHz.",
    );
  const raw = object(row.settings);
  if (!RECEIVER_MODES.includes(raw.mode as ReceiverModeSettings["mode"]))
    throw new Error("Unsupported favorite mode.");
  const mode = raw.mode as ReceiverModeSettings["mode"],
    caps = modeCapabilities(mode);
  if (
    typeof raw.bandwidthHz !== "number" ||
    !Number.isFinite(raw.bandwidthHz) ||
    raw.bandwidthHz < caps.minimumBandwidthHz ||
    raw.bandwidthHz > caps.maximumBandwidthHz ||
    typeof raw.squelch !== "number" ||
    !Number.isFinite(raw.squelch) ||
    raw.squelch < 0 ||
    raw.squelch > 6
  )
    throw new Error(
      "Favorite bandwidth or squelch is outside its supported range.",
    );
  let srd: ReceiverModeSettings["srd"];
  if (mode === "SRD") {
    srd = shape(raw.srd, defaultSrdModeSettings()) as NonNullable<typeof srd>;
    if (
      !["ook", "2fsk"].includes(srd.modulation) ||
      !["none", "acurite-592txr", "fineoffset-wh51"].includes(srd.protocol) ||
      !["adaptive", "manual"].includes(srd.threshold.mode) ||
      !["nrz", "manchester"].includes(srd.bitSlice.encoding) ||
      !["normal", "inverted"].includes(srd.bitSlice.polarity)
    )
      throw new Error("Unsupported SRD favorite setting.");
  }
  const settings = normalizeModeSettings({
    mode,
    bandwidthHz: raw.bandwidthHz,
    squelch: raw.squelch,
    ...((mode === "CW" || mode === "CW-TEXT")
      ? {
          beatToneHz: typeof raw.beatToneHz === "number" ? raw.beatToneHz : NaN,
        }
      : {}),
    ...(srd ? { srd } : {}),
    ...(isTextMode(mode) ? { textModem: normalizeTextModemSettings(raw.textModem as import("../textmodem/settings").TextModemSettings | undefined) } : {}),
  });
  if (!Array.isArray(row.tags) || row.tags.length > 10)
    throw new Error("A favorite supports at most 10 tags.");
  const tags = [...new Set(row.tags.map((tag) => text(tag, 32, true)))];
  const sources = [
    "rtl-sdr",
    "hackrf",
    "bladerf",
    "usrp-b205",
    "synthetic",
    "replay",
  ];
  if (row.sourceHint !== undefined && !sources.includes(String(row.sourceHint)))
    throw new Error("Unknown favorite source hint.");
  let atlasReference: ReceptionCandidate | undefined;
  if (row.atlasReference !== undefined) {
    const reference = object(row.atlasReference),
      params = new URLSearchParams();
    for (const key of [
      "station_id",
      "transmission_id",
      "station_name",
      "frequency_hz",
      "bandwidth_hz",
      "mode",
    ])
      if (reference[key] !== undefined) params.set(key, String(reference[key]));
    atlasReference = readReceptionCandidate(params.toString());
    if (
      !atlasReference ||
      atlasReference.frequency_hz !== row.frequencyHz ||
      atlasReference.mode !== mode
    )
      throw new Error("Invalid or mismatched Atlas reference in favorite.");
  }
  return {
    id: row.id,
    name: text(row.name, 100, true),
    frequencyHz: row.frequencyHz,
    settings,
    tags,
    notes: text(row.notes, 1000),
    ...(row.sourceHint ? { sourceHint: row.sourceHint as SourceKind } : {}),
    ...(atlasReference ? { atlasReference } : {}),
  };
}
export function bookmarkFromCandidate(candidate: ReceptionCandidate): Bookmark {
  return validateBookmark({
    id: crypto.randomUUID(),
    name: (
      candidate.station_name ??
      `${candidate.frequency_hz / 1e6} MHz ${candidate.mode}`
    ).slice(0, 100),
    frequencyHz: candidate.frequency_hz,
    settings: normalizeModeSettings({
      ...defaultModeSettings(candidate.mode),
      bandwidthHz: candidate.bandwidth_hz,
    }),
    tags: [],
    notes: "",
    atlasReference: candidate,
  });
}
export function importBookmarks(json: string): Bookmark[] {
  if (new TextEncoder().encode(json).length > MAX_BOOKMARK_BYTES)
    throw new Error("Favorite backup exceeds 256 KiB.");
  const data = object(JSON.parse(json));
  if (data.schema !== BOOKMARK_SCHEMA)
    throw new Error("Unsupported favorite backup version.");
  if (!Array.isArray(data.bookmarks) || data.bookmarks.length > MAX_BOOKMARKS)
    throw new Error(`A backup supports at most ${MAX_BOOKMARKS} favorites.`);
  const bookmarks = data.bookmarks.map(validateBookmark);
  if (new Set(bookmarks.map((item) => item.id)).size !== bookmarks.length)
    throw new Error("Duplicate favorite IDs in backup.");
  return bookmarks;
}
export function exportBookmarks(bookmarks: readonly Bookmark[]): string {
  const json = JSON.stringify(
    { schema: BOOKMARK_SCHEMA, bookmarks: bookmarks.map(validateBookmark) },
    null,
    2,
  );
  importBookmarks(json);
  return json;
}
export function mergeBookmarks(
  existing: readonly Bookmark[],
  incoming: readonly Bookmark[],
): Bookmark[] {
  const result = [...existing];
  for (const item of incoming) {
    const old = result.find((bookmark) => bookmark.id === item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item))
      throw new Error(
        "A favorite ID has different contents. Edit or remove that favorite before importing this backup.",
      );
    if (!old) result.push(item);
  }
  return importBookmarks(exportBookmarks(result));
}
