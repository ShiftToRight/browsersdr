/** Wire-field interpretation; no station identity or cross-source association. */
export type AdsbAddressType = "icao" | "other" | "track-file" | "unknown";
export type AdsbOrigin = "ads-b" | "ads-b-non-transponder" | "tis-b" | "ads-r";
export interface AdsbAddress {
  id: string;
  address: string;
  icao: string | null;
  addressType: AdsbAddressType;
  origin: AdsbOrigin;
  downlinkFormat: 17 | 18;
  controlField: number | null;
}
export function readBits(
  bytes: Uint8Array,
  start: number,
  length: number,
): number {
  let value = 0;
  for (let bit = 0; bit < length; bit++)
    value =
      value * 2 +
      ((bytes[(start + bit) >> 3]! >> (7 - ((start + bit) & 7))) & 1);
  return value;
}

export function classifyAdsbAddress(
  bytes: Uint8Array,
): AdsbAddress | undefined {
  const df = bytes[0]! >> 3;
  if (df !== 17 && df !== 18) return undefined;
  const cf = df === 18 ? bytes[0]! & 7 : null;
  // Coarse TIS-B has another payload layout; management/reserved CFs are not ES.
  if (cf === 3 || cf === 4 || cf === 7) return undefined;
  const address = Array.from(bytes.subarray(1, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  const origin: AdsbOrigin =
    cf === null
      ? "ads-b"
      : cf === 0
        ? "ads-b-non-transponder"
        : cf === 2 || cf === 5
          ? "tis-b"
          : cf === 6
            ? "ads-r"
            : "ads-b";
  let addressType: AdsbAddressType = cf === 1 || cf === 5 ? "other" : "icao";
  if (cf === 2 || cf === 6) {
    const tc = readBits(bytes, 32, 5),
      subtype = readBits(bytes, 37, 3);
    // IMF is type-dependent. Where the supported payload has no IMF, retain
    // an unqualified namespace rather than borrowing another target's ICAO.
    const imfAt =
      tc >= 5 && tc <= 8
        ? 52
        : (tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)
          ? 39
          : tc === 19 && subtype >= 1 && subtype <= 4
            ? 40
            : tc === 28 && subtype === 1
              ? 87
              : tc === 31
                ? 87
                : tc === 29
                  ? 82
                  : undefined;
    addressType =
      imfAt === undefined
        ? "unknown"
        : readBits(bytes, imfAt, 1)
          ? cf === 2
            ? "track-file"
            : "other"
          : "icao";
  }
  return {
    id: `${df}:${cf ?? "direct"}:${addressType}:${address}`,
    address,
    icao: addressType === "icao" ? address : null,
    addressType,
    origin,
    downlinkFormat: df,
    controlField: cf,
  };
}

export interface AdsbQuality {
  version: number;
  nacP: number | null;
  sil: number | null;
  silBasis: "per-hour" | "per-sample" | "unknown";
  reportedAtMs: number;
}
export function decodeAdsbQuality(
  bytes: Uint8Array,
  time: number,
): AdsbQuality | undefined {
  if (readBits(bytes, 32, 5) !== 31 || readBits(bytes, 37, 3) > 1)
    return undefined;
  const version = readBits(bytes, 72, 3);
  const nacP = readBits(bytes, 76, 4);
  return {
    version,
    nacP: (version === 1 || version === 2) && nacP <= 11 ? nacP : null,
    sil: version === 1 || version === 2 ? readBits(bytes, 82, 2) : null,
    silBasis:
      version === 2
        ? readBits(bytes, 86, 1)
          ? "per-sample"
          : "per-hour"
        : "unknown",
    reportedAtMs: time,
  };
}

export interface CprFrame {
  lat: number;
  lon: number;
  time: number;
}
export interface Position {
  latitude: number;
  longitude: number;
}
const mod = (value: number, n: number) => ((value % n) + n) % n;
function nl(latitude: number): number {
  if (Math.abs(latitude) >= 87) return Math.abs(latitude) > 87 ? 1 : 2;
  return Math.floor(
    (2 * Math.PI) /
      Math.acos(
        1 -
          (1 - Math.cos(Math.PI / 30)) /
            Math.cos((Math.PI / 180) * latitude) ** 2,
      ),
  );
}
export function distanceNm(a: Position, b: Position): number {
  const rad = Math.PI / 180,
    dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dlon / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Surface pairs need a nearby independently established reference. */
export function decodeGlobalCpr(
  even?: CprFrame,
  odd?: CprFrame,
  surfaceReference?: Position,
): Position | undefined {
  if (
    !even ||
    !odd ||
    Math.abs(even.time - odd.time) > (surfaceReference ? 5_000 : 10_000)
  )
    return undefined;
  const scale = surfaceReference ? 90 : 360;
  const j = Math.floor(
    (59 * even.lat) / 131072 - (60 * odd.lat) / 131072 + 0.5,
  );
  let latEven = (scale / 60) * (mod(j, 60) + even.lat / 131072);
  let latOdd = (scale / 59) * (mod(j, 59) + odd.lat / 131072);
  if (surfaceReference) {
    if (
      Math.abs(latEven - 90 - surfaceReference.latitude) <
      Math.abs(latEven - surfaceReference.latitude)
    )
      latEven -= 90;
    if (
      Math.abs(latOdd - 90 - surfaceReference.latitude) <
      Math.abs(latOdd - surfaceReference.latitude)
    )
      latOdd -= 90;
  } else {
    if (latEven >= 270) latEven -= 360;
    if (latOdd >= 270) latOdd -= 360;
  }
  if (
    Math.abs(latEven) > 90 ||
    Math.abs(latOdd) > 90 ||
    nl(latEven) !== nl(latOdd)
  )
    return undefined;
  const useOdd = odd.time > even.time,
    latitude = useOdd ? latOdd : latEven;
  const zones = Math.max(1, nl(latitude) - (useOdd ? 1 : 0));
  const m = Math.floor(
    (even.lon * (nl(latitude) - 1)) / 131072 -
      (odd.lon * nl(latitude)) / 131072 +
      0.5,
  );
  let longitude =
    (scale / zones) * (mod(m, zones) + (useOdd ? odd.lon : even.lon) / 131072);
  if (surfaceReference)
    longitude += 90 * Math.round((surfaceReference.longitude - longitude) / 90);
  longitude = mod(longitude + 180, 360) - 180;
  const result = { latitude, longitude };
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    (surfaceReference && distanceNm(result, surfaceReference) > 45)
  )
    return undefined;
  return result;
}

/** Movement is a quantized interval, including an open-ended >=175 kt code. */
export function surfaceMovement(
  code: number,
  version?: number,
): readonly [number, number | null] | null {
  if (code === 0 || code >= 125) return null;
  if (code === 1) return [0, 0.125];
  if (code === 124) return [175, null];
  // Version 2 changed the sub-1 kt bins. Without a supported version, show
  // only the common enclosing interval rather than guessing the quantizer.
  if (code < 9) {
    if (version === 2) {
      if (code === 2) return [0, 0.125];
      return [0.125 + (code - 3) * 0.875 / 6, 0.125 + (code - 2) * 0.875 / 6];
    }
    if (version !== 0 && version !== 1) return [0, 1];
  }
  const bands = [
    [2, 9, 0.125, 0.125],
    [9, 13, 1, 0.25],
    [13, 39, 2, 0.5],
    [39, 94, 15, 1],
    [94, 109, 70, 2],
    [109, 124, 100, 5],
  ];
  for (const [start, end, base, step] of bands)
    if (code >= start! && code < end!) {
      const lower = base! + (code - start!) * step!;
      return [lower, lower + step!];
    }
  return null;
}
