import type {
  Acurite592Reading,
  FineOffsetWh51Reading,
  SrdBurst,
  SrdSensorReading,
} from "./types";

export interface SrdProtocolDecodeResult {
  reading?: SrdSensorReading;
  rejectedFrames: number;
  rawSignature?: string;
}

export function decodeAcurite592Bytes(
  bytes: Uint8Array,
  burst: Pick<SrdBurst, "provenance">,
): Acurite592Reading | undefined {
  if (bytes.length !== 7) return undefined;
  let sum = 0;
  for (let index = 0; index < 6; index++) sum += bytes[index]!;
  if ((sum & 0xff) !== bytes[6]) return undefined;
  for (let index = 2; index <= 5; index++)
    if (popcount(bytes[index]!) % 2 !== 0) return undefined;
  if ((bytes[2]! & 0x3f) !== 0x04) return undefined;
  const channelBits = bytes[0]! >> 6;
  const channel =
    channelBits === 3
      ? "A"
      : channelBits === 2
        ? "B"
        : channelBits === 0
          ? "C"
          : undefined;
  if (!channel) return undefined;
  const humidity = bytes[3]! & 0x7f;
  if (humidity > 100 && humidity !== 127) return undefined;
  const temperatureRaw = ((bytes[4]! & 0x7f) << 7) | (bytes[5]! & 0x7f);
  const temperatureC = (temperatureRaw - 1_000) / 10;
  if (temperatureC < -40 || temperatureC > 70) return undefined;
  return {
    protocol: "acurite-592txr",
    deviceId: (((bytes[0]! & 0x3f) << 8) | bytes[1]!)
      .toString(16)
      .padStart(4, "0"),
    channel,
    batteryOk: (bytes[2]! & 0x40) !== 0,
    temperatureC,
    ...(humidity === 127 ? {} : { humidityPercent: humidity }),
    integrity: "checksum+parity",
    provenance: burst.provenance,
  };
}

export function decodeAcurite592Burst(
  burst: SrdBurst,
): SrdProtocolDecodeResult {
  const widths = burst.pulses
    .filter((pulse) => pulse.level === 1)
    .map((pulse) => pulse.durationUs);
  let rejectedFrames = 0;
  for (let start = 0; start + 56 <= widths.length; start++) {
    for (const shortIsOne of [false, true]) {
      const bytes = new Uint8Array(7);
      let validWidths = true;
      for (let bit = 0; bit < 56; bit++) {
        const width = widths[start + bit]!;
        if (width < 130 || width > 500) {
          validWidths = false;
          break;
        }
        const short = width < 314;
        const value = short === shortIsOne ? 1 : 0;
        bytes[bit >> 3] = bytes[bit >> 3]! | (value << (7 - (bit & 7)));
      }
      if (!validWidths) continue;
      const reading = decodeAcurite592Bytes(bytes, burst);
      if (reading) return { reading, rejectedFrames, rawSignature: hex(bytes) };
      rejectedFrames++;
    }
  }
  return { rejectedFrames };
}

export function decodeFineOffsetWh51Bytes(
  bytes: Uint8Array,
  burst: Pick<SrdBurst, "provenance">,
): FineOffsetWh51Reading | undefined {
  if (bytes.length !== 14 || bytes[0] !== 0x51) return undefined;
  if (crc8(bytes.subarray(0, 12)) !== bytes[12]) return undefined;
  let sum = 0;
  for (let index = 0; index < 13; index++) sum += bytes[index]!;
  if ((sum & 0xff) !== bytes[13]) return undefined;
  const moisture = bytes[6]!;
  if (moisture > 100) return undefined;
  const batteryBits = bytes[4]! & 0x1f;
  const batteryLevel =
    batteryBits >= 16
      ? 1
      : batteryBits === 15
        ? 0.9
        : batteryBits === 14
          ? 0.5
          : batteryBits === 13
            ? 0.1
            : 0;
  return {
    protocol: "fineoffset-wh51",
    deviceId: hex(bytes.subarray(1, 4)),
    batteryMillivolts: batteryBits * 100,
    batteryLevel,
    moisturePercent: moisture,
    boost: bytes[4]! >> 5,
    adRaw: ((bytes[7]! & 1) << 8) | bytes[8]!,
    integrity: "crc8+checksum",
    provenance: burst.provenance,
  };
}

export function decodeFineOffsetWh51Burst(
  burst: SrdBurst,
): SrdProtocolDecodeResult {
  const nominalSymbolUs = 58;
  const pulses = suppressFskGlitches(burst.pulses, nominalSymbolUs * 0.45);
  let rejectedFrames = 0;
  for (const inverted of [false, true]) {
    let bits = "";
    for (const pulse of pulses) {
      const count = Math.max(1, Math.round(pulse.durationUs / nominalSymbolUs));
      if (count > 256 || bits.length + count > 8_192) break;
      const bit = (pulse.level === 1) !== inverted ? "1" : "0";
      bits += bit.repeat(count);
    }
    const preamble = "101010100010110111010100"; // AA 2D D4, MSB first
    for (
      let at = bits.indexOf(preamble);
      at >= 0;
      at = bits.indexOf(preamble, at + 1)
    ) {
      const payloadStart = at + preamble.length;
      if (payloadStart + 14 * 8 > bits.length) continue;
      const bytes = bitsToBytes(
        bits.slice(payloadStart, payloadStart + 14 * 8),
      );
      const reading = decodeFineOffsetWh51Bytes(bytes, burst);
      if (reading) return { reading, rejectedFrames, rawSignature: hex(bytes) };
      rejectedFrames++;
    }
  }
  return { rejectedFrames };
}

function suppressFskGlitches(
  source: readonly SrdBurst["pulses"][number][],
  maximumGlitchUs: number,
): { level: 0 | 1; durationUs: number }[] {
  const pulses = source.map((pulse) => ({
    level: pulse.level,
    durationUs: pulse.durationUs,
  }));
  for (let index = 1; index + 1 < pulses.length;) {
    const previous = pulses[index - 1]!;
    const current = pulses[index]!;
    const next = pulses[index + 1]!;
    if (
      current.durationUs <= maximumGlitchUs &&
      previous.level === next.level
    ) {
      previous.durationUs += current.durationUs + next.durationUs;
      pulses.splice(index, 2);
      if (index > 1) index--;
    } else index++;
  }
  return pulses;
}

export function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function bitsToBytes(bits: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  return bytes;
}

function popcount(value: number): number {
  let count = 0;
  for (; value; value &= value - 1) count++;
  return count;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
