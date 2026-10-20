import type { SharedFrequencyGuide } from "./sharedFrequencyGuides";

export type FrequencySourceMode = "automatic" | "live" | "saved";
export interface FrequencySnapshot {
  schema_version: "public-frequency-catalog-v1";
  revision: string;
  published_at: string;
  profiles: SharedFrequencyGuide[];
}
export interface SavedFrequencyCatalog {
  snapshot: FrequencySnapshot;
  checkedAt: string | null;
}
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE = "browsersdr-public-frequency-catalog-v1";
const CACHE_KEY = "/api/v2/public/frequencies";
const MODE_KEY = "browsersdr.frequency-source.v1";
const keys = [
  "id",
  "family",
  "name",
  "aliases",
  "regions",
  "frequencyHz",
  "bandwidthHz",
  "spreadingFactor",
  "codingRate",
  "channel",
  "context",
  "notes",
  "publisher",
  "url",
  "reviewedOn",
  "sourceRevision",
  "plan",
  "direction",
  "frequencyMeaning",
  "recommendedMode",
  "channelSpacingHz",
];
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function validateFrequencySnapshot(
  value: unknown,
): Promise<FrequencySnapshot> {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !==
      "profiles,published_at,revision,schema_version" ||
    value.schema_version !== "public-frequency-catalog-v1" ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    typeof value.published_at !== "string" ||
    !Number.isFinite(Date.parse(value.published_at)) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.published_at) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 5000
  )
    throw new Error("Invalid public frequency catalog");
  const ids = new Set<string>();
  for (const p of value.profiles) {
    if (!record(p) || Object.keys(p).sort().join() !== [...keys].sort().join())
      throw new Error("Invalid frequency profile fields");
    for (const k of [
      "id",
      "family",
      "name",
      "context",
      "notes",
      "publisher",
      "url",
      "reviewedOn",
      "frequencyMeaning",
    ])
      if (
        typeof p[k] !== "string" ||
        (p[k] as string).length >
          (k === "notes"
            ? 8000
            : k === "context"
              ? 1000
              : k === "url"
                ? 2083
                : 300) ||
        (["family", "name", "publisher"].includes(k) && p[k] === "")
      )
        throw new Error("Invalid frequency text");
    if (
      !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(p.id as string) ||
      ids.has(p.id as string)
    )
      throw new Error("Duplicate frequency profile");
    ids.add(p.id as string);
    for (const k of ["aliases", "regions"])
      if (
        !Array.isArray(p[k]) ||
        p[k].length > (k === "aliases" ? 50 : 100) ||
        (k === "regions" && p[k].length === 0) ||
        !p[k].every(
          (v) => typeof v === "string" && v.length >= 1 && v.length <= 300,
        )
      )
        throw new Error("Invalid frequency labels");
    for (const k of ["frequencyHz", "bandwidthHz", "channelSpacingHz"])
      if (
        (k === "frequencyHz" || p[k] !== null) &&
        (typeof p[k] !== "number" ||
          !Number.isSafeInteger(p[k]) ||
          p[k] <= 0 ||
          p[k] > 1e12)
      )
        throw new Error("Invalid frequency");
    if (
      p.spreadingFactor !== null &&
      (typeof p.spreadingFactor !== "number" ||
        !Number.isInteger(p.spreadingFactor) ||
        p.spreadingFactor < 5 ||
        p.spreadingFactor > 12)
    )
      throw new Error("Invalid modem");
    for (const k of [
      "codingRate",
      "channel",
      "sourceRevision",
      "plan",
      "direction",
    ])
      if (
        p[k] !== null &&
        (typeof p[k] !== "string" || p[k].length < 1 || p[k].length > 300)
      )
        throw new Error("Invalid frequency metadata");
    if (
      ![null, "USB", "NBFM", "AM"].includes(p.recommendedMode as null) ||
      ![
        "rf_carrier",
        "channel_center",
        "receiver_dial",
        "receiver_if",
        "allocation",
      ].includes(p.frequencyMeaning as string) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewedOn as string) ||
      !Number.isFinite(Date.parse(p.reviewedOn as string)) ||
      new Date(p.reviewedOn as string).toISOString().slice(0, 10) !==
        p.reviewedOn
    )
      throw new Error("Invalid frequency semantics");
    const url = new URL(p.url as string);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      /\s/.test(p.url as string) ||
      !/^[A-Za-z0-9.-]+$/.test(url.host) ||
      !url.hostname.includes(".") ||
      url.hostname.split(".").some((part) => !part) ||
      /(?:\.localhost|\.local|\.internal|\.invalid|\.test)$/.test(
        url.hostname,
      ) ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) ||
      (url.search &&
        !(
          url.hostname === "www.bundesnetzagentur.de" &&
          url.pathname.startsWith(
            "/DE/Fachthemen/Telekommunikation/Frequenzen/Allgemeinzuteilungen/",
          ) &&
          /^__blob=publicationFile&v=[0-9]{1,3}$/.test(url.search.slice(1))
        ))
    )
      throw new Error("Invalid frequency source URL");
  }
  const body = canonical(value.profiles);
  if (new TextEncoder().encode(body).length > MAX_BYTES)
    throw new Error("Frequency catalog too large");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const revision = [...new Uint8Array(hash)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (revision !== value.revision)
    throw new Error("Frequency catalog checksum mismatch");
  return value as unknown as FrequencySnapshot;
}
export function readFrequencySourceMode(): FrequencySourceMode {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === "live" || mode === "saved" ? mode : "automatic";
  } catch {
    return "automatic";
  }
}
export function saveFrequencySourceMode(mode: FrequencySourceMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* Preference storage is optional. */
  }
}
// Cache.put atomically replaces one complete response. Heavy validation and persistence
// run in the catalog worker; no credential, favorite or station response enters this cache.
export async function readSavedFrequencyCatalog(
  storage = globalThis.caches,
): Promise<SavedFrequencyCatalog | null> {
  try {
    const response = await (await storage.open(CACHE)).match(CACHE_KEY);
    if (!response) return null;
    const saved = await boundedJson(response);
    if (
      !record(saved) ||
      !(
        saved.checkedAt === null ||
        (typeof saved.checkedAt === "string" &&
          Number.isFinite(Date.parse(saved.checkedAt)))
      )
    )
      return null;
    return {
      snapshot: await validateFrequencySnapshot(saved.snapshot),
      checkedAt: saved.checkedAt,
    };
  } catch {
    return null;
  }
}
export async function saveFrequencyCatalog(
  value: SavedFrequencyCatalog,
  storage = globalThis.caches,
): Promise<boolean> {
  try {
    await (await storage.open(CACHE)).put(CACHE_KEY, Response.json(value));
    return true;
  } catch {
    return false;
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("Frequency catalog too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty frequency response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Frequency catalog too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export interface FrequencyCatalogUpdate {
  source: "saved" | "live" | "unavailable";
  revision: string;
  published_at: string;
  checkedAt: string | null;
  order?: string[];
  patch?: SharedFrequencyGuide[];
  complete: boolean;
  saved?: boolean;
}
export async function fetchFrequencyCatalog(
  saved: SavedFrequencyCatalog | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SavedFrequencyCatalog> {
  const response = await fetcher("/api/v2/public/frequencies", {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal,
    headers: saved ? { "If-None-Match": `"${saved.snapshot.revision}"` } : {},
  });
  if (response.status === 304 && saved)
    return { ...saved, checkedAt: new Date().toISOString() };
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new Error("Live public frequency catalog unavailable");
  return {
    snapshot: await validateFrequencySnapshot(await boundedJson(response)),
    checkedAt: new Date().toISOString(),
  };
}
