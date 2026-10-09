import { KIWI_MODES } from "./kiwiProtocol";
import { receiverUrl, remoteMode, type RemoteTune } from "./openWebRxProtocol";

export type RemoteKind = "openwebrx" | "kiwi";
export interface RemotePreset {
  id: string;
  name: string;
  kind: RemoteKind;
  address: string;
  notes: string;
  tune?: RemoteTune;
  profile?: string;
  zoom?: number;
}
export const REMOTE_PRESET_KEY = "browsersdr.remote-favorites.v1";
export const REMOTE_PRESET_SCHEMA = "browsersdr-remote-favorites-v1";
export const REMOTE_SHARE_SCHEMA = "browsersdr-remote-preset-v1";
export const MAX_REMOTE_PRESET_BYTES = 256 * 1024;
export const MAX_REMOTE_PRESETS = 100;
export const MAX_REMOTE_SHARE_LENGTH = 8192;
function boundedText(value: unknown, limit: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    (required && !value.trim())
  )
    throw new Error("Check the preset name, notes and receiver band.");
  return value.trim();
}
export function validateRemotePreset(value: unknown): RemotePreset {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid remote preset.");
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      row.id,
    )
  )
    throw new Error("Invalid remote preset ID.");
  if (row.kind !== "openwebrx" && row.kind !== "kiwi")
    throw new Error("Choose OpenWebRX or KiwiSDR.");
  if (typeof row.address !== "string")
    throw new Error("Enter a receiver website.");
  // Stored HTTP entries stay portable. Connect enforces the actual page's TLS policy.
  const address = receiverUrl(row.address, "http:").website;
  const result: RemotePreset = {
    id: row.id.toLowerCase(),
    name: boundedText(row.name, 80, true),
    kind: row.kind,
    address,
    notes: boundedText(row.notes ?? "", 2048),
  };
  if (row.tune !== undefined) {
    if (!row.tune || typeof row.tune !== "object" || Array.isArray(row.tune))
      throw new Error("Invalid remote channel.");
    const tune = row.tune as RemoteTune;
    if (
      !remoteMode(tune.mode) ||
      (row.kind === "kiwi" && !KIWI_MODES.some((mode) => mode === tune.mode)) ||
      !Number.isInteger(tune.frequency) ||
      tune.frequency < 0 ||
      tune.frequency > 100e9 ||
      ![tune.lowCut, tune.highCut, tune.squelch].every(Number.isFinite) ||
      tune.lowCut >= tune.highCut ||
      Math.max(Math.abs(tune.lowCut), Math.abs(tune.highCut)) > 100_000 ||
      tune.squelch < -150 ||
      tune.squelch > 0
    )
      throw new Error("Invalid remote frequency, mode or filter.");
    result.tune = {
      frequency: tune.frequency,
      mode: tune.mode,
      lowCut: tune.lowCut,
      highCut: tune.highCut,
      squelch: tune.squelch,
    };
    if (row.profile !== undefined) {
      if (row.kind !== "openwebrx")
        throw new Error("KiwiSDR presets use zoom, not receiver bands.");
      result.profile = boundedText(row.profile, 320, true);
    }
    if (row.zoom !== undefined) {
      if (
        row.kind !== "kiwi" ||
        !Number.isInteger(row.zoom) ||
        (row.zoom as number) < 0 ||
        (row.zoom as number) > 14
      )
        throw new Error("Invalid KiwiSDR zoom.");
      result.zoom = row.zoom as number;
    }
  } else if (row.profile !== undefined || row.zoom !== undefined)
    throw new Error("A saved band or zoom needs channel settings.");
  return result;
}
export function exportRemotePresets(items: RemotePreset[]) {
  if (!Array.isArray(items) || items.length > MAX_REMOTE_PRESETS)
    throw new Error("Keep at most 100 remote favorites.");
  const checked = items.map(validateRemotePreset);
  if (new Set(checked.map((item) => item.id)).size !== checked.length)
    throw new Error("Duplicate remote preset IDs.");
  const json = JSON.stringify(
    { schema: REMOTE_PRESET_SCHEMA, items: checked },
    null,
    2,
  );
  if (new TextEncoder().encode(json).length > MAX_REMOTE_PRESET_BYTES)
    throw new Error("Remote backup exceeds 256 KiB.");
  return json;
}
export function importRemotePresets(json: string): RemotePreset[] {
  if (new TextEncoder().encode(json).length > MAX_REMOTE_PRESET_BYTES)
    throw new Error("Remote backup exceeds 256 KiB.");
  const data = JSON.parse(json);
  if (data?.schema !== REMOTE_PRESET_SCHEMA || !Array.isArray(data.items))
    throw new Error("Unsupported remote backup version.");
  // A full second pass enforces count, IDs and normalized size, with no partial mutation.
  return JSON.parse(exportRemotePresets(data.items)).items as RemotePreset[];
}
export function mergeRemotePresets(
  current: RemotePreset[],
  incoming: RemotePreset[],
) {
  const ids = new Set(current.map((item) => item.id));
  const merged = [...current, ...incoming.filter((item) => !ids.has(item.id))];
  return importRemotePresets(exportRemotePresets(merged));
}
export function hasRemoteShare(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, "")).has("remote");
}
const sharedId = "00000000-0000-4000-8000-000000000000";
export function createRemoteShareUrl(base: string, value: RemotePreset) {
  const { kind, address, tune, profile, zoom } = validateRemotePreset(value);
  const json = JSON.stringify({
    schema: REMOTE_SHARE_SCHEMA,
    kind,
    address,
    tune,
    profile,
    zoom,
  });
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Use an HTTP or HTTPS application address.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = `remote=${encoded}`;
  if (url.hash.length > MAX_REMOTE_SHARE_LENGTH)
    throw new Error("Remote preset link is too large.");
  return url.href;
}
export function readRemoteShare(hash: string): {
  preset?: RemotePreset;
  error?: string;
} {
  if (!hasRemoteShare(hash)) return {};
  try {
    if (hash.length > MAX_REMOTE_SHARE_LENGTH)
      throw new Error("Remote preset link is too large.");
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const encoded = params.get("remote")!;
    if (params.size !== 1 || !/^[A-Za-z0-9_-]+$/.test(encoded))
      throw new Error("Invalid or ambiguous remote preset link.");
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (data?.schema !== REMOTE_SHARE_SCHEMA)
      throw new Error("Unsupported remote preset link version.");
    return {
      preset: validateRemotePreset({
        ...data,
        id: sharedId,
        name: "Shared remote preset",
        notes: "",
      }),
    };
  } catch (reason) {
    return {
      error:
        reason instanceof Error
          ? reason.message
          : "Invalid remote preset link.",
    };
  }
}
