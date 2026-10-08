/** Read-only catalog contract. Reception evidence is separate from reference verification. */
export const ATLAS_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface AtlasStationQuery {
  q?: string;
  min_frequency_hz?: number;
  max_frequency_hz?: number;
  cursor?: string;
}
export interface AtlasStationReception {
  last_reception_at: string | null;
  last_reviewed_reception_at: string | null;
  reception_count: number;
  undated_count: number;
  excluded_reviewed_count: number;
  recording_id: string | null;
  recording_revision_id: string | null;
  annotation_id: string | null;
  sample_start: string | null;
  sample_count: string | null;
  review_state:
    "unreviewed" | "provisional" | "reviewed" | "disputed" | "rejected" | null;
  excluded_reviewed_claims: Array<{
    recording_id: string;
    recording_revision_id: string;
    annotation_id: string;
    recording_title: string;
    reason: string;
    can_correct_origin: boolean;
  }>;
}
export interface AtlasStationTransmission {
  id: string;
  frequency_hz: number;
  broadcast_format: string | null;
  bandwidth_hz: number | null;
  site: {
    name: string | null;
    place_name: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  rds_pi: string | null;
  rds_ecc: string | null;
  rds_ps: string | null;
  source: string | null;
  verification_state: "provisional" | "verified";
  verified_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  reception: AtlasStationReception;
}
export interface AtlasStation {
  id: string;
  version: number;
  name: string;
  aliases: string[];
  call_sign: string | null;
  network: string | null;
  service: string | null;
  country: string | null;
  transmitter_notes: string | null;
  transmissions: AtlasStationTransmission[];
  reception: AtlasStationReception;
}
export interface AtlasStationPage {
  items: AtlasStation[];
  next_cursor: string | null;
}

export function stationQueryParams(query: AtlasStationQuery): URLSearchParams {
  const params = new URLSearchParams({ limit: "50" });
  if (query.q !== undefined) {
    if (typeof query.q !== "string" || query.q.length > 200)
      throw new Error("Search text must be at most 200 characters.");
    if (query.q.trim()) params.set("q", query.q.trim());
  }
  const min = query.min_frequency_hz,
    max = query.max_frequency_hz;
  if (min !== undefined || max !== undefined) {
    if (
      min === undefined ||
      max === undefined ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < 0 ||
      max > 1e12 ||
      min >= max
    )
      throw new Error(
        "Enter both frequency bounds, between 0 and 1000000 MHz, with minimum below maximum.",
      );
    params.set("min_frequency_hz", String(min));
    params.set("max_frequency_hz", String(max));
  }
  if (query.cursor !== undefined) {
    if (
      typeof query.cursor !== "string" ||
      !query.cursor.length ||
      query.cursor.length > 32
    )
      throw new Error("Invalid station page cursor. Search again.");
    params.set("cursor", query.cursor);
  }
  return params;
}
export function stationQueryFromMHz(
  q: string,
  minimum: string,
  maximum: string,
): AtlasStationQuery {
  const query: AtlasStationQuery = { q };
  if (minimum.trim() || maximum.trim()) {
    if (!minimum.trim() || !maximum.trim())
      throw new Error("Enter both frequency bounds in MHz.");
    query.min_frequency_hz = Number(minimum) * 1e6;
    query.max_frequency_hz = Number(maximum) * 1e6;
  }
  stationQueryParams(query);
  return query;
}
function bad(): never {
  throw new Error(
    "SigIntAtlas returned an invalid station response. Check the API proxy/version.",
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  return value as Record<string, unknown>;
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100_000;
}
function nullableString(value: unknown): boolean {
  return value === null || string(value);
}
function id(value: unknown): boolean {
  return typeof value === "string" && ATLAS_UUID.test(value);
}
function date(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}
function positive(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1e12
  );
}
function count(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function reception(value: unknown): void {
  const v = record(value);
  for (const k of ["last_reception_at", "last_reviewed_reception_at"])
    if (!date(v[k])) bad();
  for (const k of [
    "reception_count",
    "undated_count",
    "excluded_reviewed_count",
  ])
    if (!count(v[k])) bad();
  for (const k of ["recording_id", "recording_revision_id", "annotation_id"])
    if (v[k] !== null && !id(v[k])) bad();
  for (const k of ["sample_start", "sample_count"])
    if (v[k] !== null && !(typeof v[k] === "string" && /^\d{1,40}$/.test(v[k])))
      bad();
  if (
    v.review_state !== null &&
    !["unreviewed", "provisional", "reviewed", "disputed", "rejected"].includes(
      String(v.review_state),
    )
  )
    bad();
  if (
    !Array.isArray(v.excluded_reviewed_claims) ||
    v.excluded_reviewed_claims.length > 5
  )
    bad();
  for (const claim of v.excluded_reviewed_claims) {
    const c = record(claim);
    if (
      !["recording_id", "recording_revision_id", "annotation_id"].every((k) =>
        id(c[k]),
      ) ||
      !string(c.recording_title) ||
      !string(c.reason) ||
      typeof c.can_correct_origin !== "boolean"
    )
      bad();
  }
}
export function parseAtlasStation(value: unknown): AtlasStation {
  const v = record(value);
  if (
    !id(v.id) ||
    !count(v.version) ||
    v.version === 0 ||
    !string(v.name) ||
    !Array.isArray(v.aliases) ||
    v.aliases.length > 1000 ||
    !v.aliases.every(string)
  )
    bad();
  for (const k of [
    "call_sign",
    "network",
    "service",
    "country",
    "transmitter_notes",
  ])
    if (!nullableString(v[k])) bad();
  reception(v.reception);
  if (!Array.isArray(v.transmissions) || v.transmissions.length > 50) bad();
  const ids = new Set<string>();
  for (const transmission of v.transmissions) {
    const t = record(transmission);
    if (
      !id(t.id) ||
      ids.has(String(t.id)) ||
      !positive(t.frequency_hz) ||
      !(t.bandwidth_hz === null || positive(t.bandwidth_hz)) ||
      !["provisional", "verified"].includes(String(t.verification_state))
    )
      bad();
    ids.add(String(t.id));
    for (const k of [
      "broadcast_format",
      "rds_pi",
      "rds_ecc",
      "rds_ps",
      "source",
    ])
      if (!nullableString(t[k])) bad();
    for (const k of ["verified_at", "valid_from", "valid_to"])
      if (!date(t[k])) bad();
    if (t.site !== null) {
      const s = record(t.site);
      for (const k of ["name", "place_name", "country"])
        if (!nullableString(s[k])) bad();
      if (
        !(s.latitude === null && s.longitude === null) &&
        !(
          typeof s.latitude === "number" &&
          Number.isFinite(s.latitude) &&
          Math.abs(s.latitude) <= 90 &&
          typeof s.longitude === "number" &&
          Number.isFinite(s.longitude) &&
          Math.abs(s.longitude) <= 180
        )
      )
        bad();
    }
    reception(t.reception);
  }
  return v as unknown as AtlasStation;
}
export function parseAtlasStationPage(value: unknown): AtlasStationPage {
  const v = record(value);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !(
      v.next_cursor === null ||
      (typeof v.next_cursor === "string" &&
        v.next_cursor.length > 0 &&
        v.next_cursor.length <= 32)
    )
  )
    bad();
  const items = v.items.map(parseAtlasStation);
  if (new Set(items.map((s) => s.id)).size !== items.length) bad();
  return { items, next_cursor: v.next_cursor as string | null };
}
