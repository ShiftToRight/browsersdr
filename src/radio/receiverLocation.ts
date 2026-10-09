/** WGS84 reception site, never a transmitter position. Browser source is device
 * geolocation, not a claim of GNSS or of physical antenna co-location. */
export interface ReceiverLocation {
  version: 1;
  latitude: number;
  longitude: number;
  source: "manual" | "browser" | "imported";
  observedAt?: string;
  accuracyMeters?: number;
  /** Retained WGS84 ellipsoid height for imported sites; optional. */
  altitudeMeters?: number;
  label?: string;
  snapshotAt?: string;
  stale?: boolean;
}
export const LOCATION_STALE_MS = 5 * 60_000;
export function validateReceiverLocation(value: unknown): ReceiverLocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid antenna site.");
  const v = value as ReceiverLocation;
  if (
    v.version !== 1 ||
    typeof v.latitude !== "number" ||
    !Number.isFinite(v.latitude) ||
    Math.abs(v.latitude) > 90 ||
    typeof v.longitude !== "number" ||
    !Number.isFinite(v.longitude) ||
    Math.abs(v.longitude) > 180 ||
    !["manual", "browser", "imported"].includes(v.source)
  )
    throw new Error("Enter valid WGS84 latitude and longitude.");
  for (const field of ["observedAt", "snapshotAt"] as const) {
    if (
      v[field] !== undefined &&
      (typeof v[field] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/.test(v[field]!) ||
        !Number.isFinite(Date.parse(v[field]!)))
    )
      throw new Error("Invalid antenna-site timestamp.");
  }
  if (v.source === "browser" && !v.observedAt)
    throw new Error("Browser location needs its original fix time.");
  if (
    v.accuracyMeters !== undefined &&
    (typeof v.accuracyMeters !== "number" ||
      !Number.isFinite(v.accuracyMeters) ||
      v.accuracyMeters < 0)
  )
    throw new Error("Invalid location accuracy.");
  if (
    v.altitudeMeters !== undefined &&
    (typeof v.altitudeMeters !== "number" || !Number.isFinite(v.altitudeMeters))
  )
    throw new Error("Invalid location altitude.");
  if (
    v.label !== undefined &&
    (typeof v.label !== "string" || v.label.length > 120)
  )
    throw new Error("Site label must be at most 120 characters.");
  if (v.stale !== undefined && typeof v.stale !== "boolean")
    throw new Error("Invalid location age state.");
  return {
    version: 1,
    latitude: v.latitude,
    longitude: v.longitude,
    source: v.source,
    ...(v.observedAt === undefined ? {} : { observedAt: v.observedAt }),
    ...(v.accuracyMeters === undefined
      ? {}
      : { accuracyMeters: v.accuracyMeters }),
    ...(v.altitudeMeters === undefined
      ? {}
      : { altitudeMeters: v.altitudeMeters }),
    ...(v.label === undefined ? {} : { label: v.label }),
    ...(v.snapshotAt === undefined ? {} : { snapshotAt: v.snapshotAt }),
    ...(v.stale === undefined ? {} : { stale: v.stale }),
  };
}
export function locationIsStale(
  site: ReceiverLocation,
  now = Date.now(),
): boolean {
  return (
    site.source === "browser" &&
    (!site.observedAt ||
      now - Date.parse(site.observedAt) > LOCATION_STALE_MS ||
      Date.parse(site.observedAt) > now + 60_000)
  );
}
export function snapshotReceiverLocation(
  site: ReceiverLocation | undefined,
  at = new Date().toISOString(),
): ReceiverLocation | undefined {
  if (!site) return undefined;
  const validated = validateReceiverLocation(site);
  return {
    ...validated,
    snapshotAt: at,
    stale: locationIsStale(validated, Date.parse(at)),
  };
}
export function locationFromBrowser(
  position: Pick<GeolocationPosition, "coords" | "timestamp">,
): ReceiverLocation {
  if (
    !Number.isFinite(position.timestamp) ||
    position.timestamp < 0 ||
    position.timestamp > Date.now() + 60_000
  )
    throw new Error("The browser returned an invalid fix time.");
  return validateReceiverLocation({
    version: 1,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    source: "browser",
    observedAt: new Date(position.timestamp).toISOString(),
    ...(position.coords.accuracy == null
      ? {}
      : { accuracyMeters: position.coords.accuracy }),
  });
}
