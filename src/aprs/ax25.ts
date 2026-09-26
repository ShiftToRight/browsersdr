import {
  APRS_MAX_AX25_FRAME_BYTES,
  APRS_MAX_DIGIPEATERS,
  APRS_MAX_INFORMATION_BYTES,
  type Ax25Address,
  type Ax25UiFrame,
} from "./types";

export function ax25Fcs(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

export function hasValidAx25Fcs(frame: Uint8Array): boolean {
  if (frame.length < 2) return false;
  const body = frame.subarray(0, -2);
  const expected = frame[frame.length - 2]! | (frame[frame.length - 1]! << 8);
  return ax25Fcs(body) === expected;
}

function parseAddress(
  bytes: Uint8Array,
  offset: number,
): Ax25Address | undefined {
  if (offset + 7 > bytes.length) return undefined;
  let callsign = "";
  for (let index = 0; index < 6; index++) {
    const encoded = bytes[offset + index]!;
    if ((encoded & 1) !== 0) return undefined;
    const character = encoded >>> 1;
    if (character !== 0x20 && (character < 0x30 || character > 0x5a))
      return undefined;
    callsign += String.fromCharCode(character);
  }
  callsign = callsign.trimEnd();
  if (!/^[A-Z0-9]{1,6}$/.test(callsign)) return undefined;
  const ssidByte = bytes[offset + 6]!;
  if ((ssidByte & 0x60) !== 0x60) return undefined;
  return {
    callsign,
    ssid: (ssidByte >>> 1) & 0x0f,
    repeated: (ssidByte & 0x80) !== 0,
  };
}

export function parseAx25UiFrame(
  frameWithFcs: Uint8Array,
): Ax25UiFrame | undefined {
  if (
    frameWithFcs.length < 18 ||
    frameWithFcs.length > APRS_MAX_AX25_FRAME_BYTES
  )
    return undefined;
  if (!hasValidAx25Fcs(frameWithFcs)) return undefined;
  const bytes = frameWithFcs.subarray(0, -2);
  const addresses: Ax25Address[] = [];
  let offset = 0;
  while (addresses.length < APRS_MAX_DIGIPEATERS + 2) {
    const address = parseAddress(bytes, offset);
    if (!address) return undefined;
    addresses.push(address);
    const last = (bytes[offset + 6]! & 1) !== 0;
    offset += 7;
    if (last) break;
  }
  if (addresses.length < 2 || (bytes[offset - 1]! & 1) === 0) return undefined;
  if (
    offset + 2 > bytes.length ||
    bytes[offset] !== 0x03 ||
    bytes[offset + 1] !== 0xf0
  )
    return undefined;
  const information = bytes.slice(offset + 2);
  if (information.length > APRS_MAX_INFORMATION_BYTES) return undefined;
  return {
    destination: addresses[0]!,
    source: addresses[1]!,
    path: addresses.slice(2),
    control: 0x03,
    pid: 0xf0,
    information,
  };
}

export function formatAx25Address(address: Ax25Address): string {
  return address.ssid === 0
    ? address.callsign
    : `${address.callsign}-${address.ssid}`;
}
