import type { DigitalProvenance } from "../digital";
import { correctRs41Frame } from "./reedSolomon";
import type { Rs41DecodedFrame, Rs41Position } from "./types";

const STATUS = 0x039;
const PTU = 0x065;
const GPS_INFO = 0x093;
const GPS_RAW = 0x0b5;
const GPS_POSITION = 0x112;

export function rs41Crc16(data: Uint8Array): number {
  let remainder = 0xffff;
  for (const byte of data) {
    remainder ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      remainder =
        (remainder & 0x8000) !== 0
          ? ((remainder << 1) ^ 0x1021) & 0xffff
          : (remainder << 1) & 0xffff;
  }
  return remainder;
}

function validSubblock(
  frame: Uint8Array,
  offset: number,
  id: number,
  length: number,
): boolean {
  if (
    offset + length + 4 > frame.length ||
    frame[offset] !== id ||
    frame[offset + 1] !== length
  )
    return false;
  const expected =
    frame[offset + 2 + length]! | (frame[offset + 3 + length]! << 8);
  return (
    rs41Crc16(frame.subarray(offset + 2, offset + 2 + length)) === expected
  );
}

function u16(frame: Uint8Array, offset: number): number {
  return frame[offset]! | (frame[offset + 1]! << 8);
}
function i16(frame: Uint8Array, offset: number): number {
  const value = u16(frame, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}
function u32(frame: Uint8Array, offset: number): number {
  return (
    (frame[offset]! |
      (frame[offset + 1]! << 8) |
      (frame[offset + 2]! << 16) |
      (frame[offset + 3]! << 24)) >>>
    0
  );
}
function i32(frame: Uint8Array, offset: number): number {
  return u32(frame, offset) | 0;
}

export function ecefToWgs84(
  xMeters: number,
  yMeters: number,
  zMeters: number,
):
  | {
      latitudeDegrees: number;
      longitudeDegrees: number;
      altitudeMeters: number;
    }
  | undefined {
  if (
    ![xMeters, yMeters, zMeters].every(Number.isFinite) ||
    Math.hypot(xMeters, yMeters, zMeters) < 6_000_000
  )
    return undefined;
  const a = 6_378_137;
  const b = 6_356_752.31424518;
  const e2 = (a * a - b * b) / (a * a);
  const ep2 = (a * a - b * b) / (b * b);
  const longitude = Math.atan2(yMeters, xMeters);
  const p = Math.hypot(xMeters, yMeters);
  const theta = Math.atan2(zMeters * a, p * b);
  const latitude = Math.atan2(
    zMeters + ep2 * b * Math.sin(theta) ** 3,
    p - e2 * a * Math.cos(theta) ** 3,
  );
  const radius = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2);
  const altitude = p / Math.cos(latitude) - radius;
  if (!Number.isFinite(altitude) || altitude < -1000 || altitude > 80_000)
    return undefined;
  return {
    latitudeDegrees: (latitude * 180) / Math.PI,
    longitudeDegrees: (longitude * 180) / Math.PI,
    altitudeMeters: altitude,
  };
}

function decodePosition(frame: Uint8Array): Rs41Position | undefined {
  const x = i32(frame, 0x114) / 100;
  const y = i32(frame, 0x118) / 100;
  const z = i32(frame, 0x11c) / 100;
  const geodetic = ecefToWgs84(x, y, z);
  if (!geodetic) return undefined;
  const vx = i16(frame, 0x120) / 100;
  const vy = i16(frame, 0x122) / 100;
  const vz = i16(frame, 0x124) / 100;
  const latitude = (geodetic.latitudeDegrees * Math.PI) / 180;
  const longitude = (geodetic.longitudeDegrees * Math.PI) / 180;
  const north =
    -vx * Math.sin(latitude) * Math.cos(longitude) -
    vy * Math.sin(latitude) * Math.sin(longitude) +
    vz * Math.cos(latitude);
  const east = -vx * Math.sin(longitude) + vy * Math.cos(longitude);
  const up =
    vx * Math.cos(latitude) * Math.cos(longitude) +
    vy * Math.cos(latitude) * Math.sin(longitude) +
    vz * Math.sin(latitude);
  const horizontal = Math.hypot(north, east);
  const heading =
    horizontal < 0.01
      ? null
      : ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return {
    ...geodetic,
    northVelocityMetersPerSecond: north,
    eastVelocityMetersPerSecond: east,
    upVelocityMetersPerSecond: up,
    horizontalSpeedMetersPerSecond: horizontal,
    headingDegrees: heading,
    satellitesUsed: frame[0x126]!,
    speedAccuracyMetersPerSecond: frame[0x127]! / 10,
    positionDilutionOfPrecision: frame[0x128]! / 10,
  };
}

export function decodeRs41Frame(
  input: Uint8Array,
  provenance: DigitalProvenance,
  invertedPolarity = false,
): Rs41DecodedFrame {
  const fec = correctRs41Frame(input);
  const frame = fec.frame;
  // A sub-block CRC is not a sufficient trust boundary after the outer RS
  // codeword has been rejected: uncorrected bytes can coincidentally retain a
  // valid CRC. Keep rejected frames inspectable, but expose no telemetry from
  // them as integrity-validated data.
  const integrity =
    fec.status === "rejected"
      ? {
          status: false,
          ptu: false,
          gpsInfo: false,
          gpsRaw: false,
          gpsPosition: false,
        }
      : {
          status: validSubblock(frame, STATUS, 0x79, 0x28),
          ptu: validSubblock(frame, PTU, 0x7a, 0x2a),
          gpsInfo: validSubblock(frame, GPS_INFO, 0x7c, 0x1e),
          gpsRaw: validSubblock(frame, GPS_RAW, 0x7d, 0x59),
          gpsPosition: validSubblock(frame, GPS_POSITION, 0x7b, 0x15),
        };
  const type = frame[0x38];
  const variant =
    type === 0x0f && input.length === 320
      ? "standard"
      : type === 0xf0 && input.length === 518
        ? "extended"
        : "unsupported";
  const id = integrity.status
    ? new TextDecoder("ascii")
        .decode(frame.subarray(0x03d, 0x045))
        .replace(/\0+$/, "")
    : undefined;
  const validId = id && /^[A-Z0-9]{4,8}$/.test(id) ? id : undefined;
  const position = integrity.gpsPosition ? decodePosition(frame) : undefined;
  return {
    variant,
    fecStatus: fec.status,
    correctedErrors: fec.correctedErrors,
    subblockIntegrity: integrity,
    ...(validId
      ? {
          sondeId: validId,
          frameCounter: u16(frame, 0x03b),
          batteryVolts: frame[0x045]! / 10,
          calibrationFragmentIndex: frame[0x052]!,
        }
      : {}),
    ...(integrity.gpsInfo && u32(frame, 0x097) < 604_800_000
      ? {
          gpsTime: {
            week: u16(frame, 0x095),
            timeOfWeekMilliseconds: u32(frame, 0x097),
          },
        }
      : {}),
    ...(position ? { position } : {}),
    provenance,
    invertedPolarity,
  };
}
