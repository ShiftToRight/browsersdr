import {
  ATLAS_UUID,
  stationQueryParams,
  type AtlasStationQuery,
} from "./atlasStations";

const productionOrigins = new Set([
  "https://browsersdr.com",
  "https://www.browsersdr.com",
]);
/** Deployment-owned web destination only. API credentials always stay same-origin. */
export function atlasStationWebBase(
  browserOrigin = location.origin,
  configured = import.meta.env.VITE_ATLAS_WEB_BASE,
): string {
  if (productionOrigins.has(browserOrigin)) return "https://sigintatlas.com";
  let base: URL;
  try {
    base = new URL(configured || "https://sigintatlas.com");
  } catch {
    throw new Error(
      "Configure a trusted HTTPS Atlas web origin (or loopback HTTP for development).",
    );
  }
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  )
    throw new Error(
      "Configure a trusted HTTPS Atlas web origin (or loopback HTTP for development).",
    );
  return base.origin;
}
export function atlasStationListUrl(
  query: AtlasStationQuery,
  browserOrigin?: string,
  configured?: string,
): string {
  const validated = stationQueryParams({ ...query, cursor: undefined });
  const params = new URLSearchParams();
  if (validated.has("q")) params.set("q", validated.get("q")!);
  if (query.min_frequency_hz !== undefined) {
    params.set("min_mhz", String(query.min_frequency_hz / 1e6));
    params.set("max_mhz", String(query.max_frequency_hz! / 1e6));
  }
  const suffix = params.size ? `?${params}` : "";
  return `${atlasStationWebBase(browserOrigin, configured)}/#/database/stations${suffix}`;
}
export function atlasStationUrl(
  stationId: string,
  transmissionId?: string,
  browserOrigin?: string,
  configured?: string,
): string {
  if (
    !ATLAS_UUID.test(stationId) ||
    (transmissionId !== undefined && !ATLAS_UUID.test(transmissionId))
  )
    throw new Error("Invalid station or transmission ID.");
  const params = new URLSearchParams({ station_id: stationId.toLowerCase() });
  if (transmissionId)
    params.set("transmission_id", transmissionId.toLowerCase());
  return `${atlasStationWebBase(browserOrigin, configured)}/#/database/stations?${params}`;
}
