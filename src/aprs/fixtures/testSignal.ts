import { ax25Fcs } from "../ax25";

export function encodeAddress(
  value: string,
  last: boolean,
  repeated = false,
): number[] {
  const [call, ssidText] = value.split("-");
  const ssid = Number(ssidText ?? 0);
  return [...call!.padEnd(6, " ")]
    .map((character) => character.charCodeAt(0) << 1)
    .concat(0x60 | (ssid << 1) | (last ? 1 : 0) | (repeated ? 0x80 : 0));
}

export function buildUiFrame(
  information: string,
  destination = "APRS",
  source = "N0CALL-1",
  path = ["WIDE1-1"],
): Uint8Array {
  const addresses = [destination, source, ...path];
  const body = new Uint8Array([
    ...addresses.flatMap((address, index) =>
      encodeAddress(address, index === addresses.length - 1),
    ),
    0x03,
    0xf0,
    ...new TextEncoder().encode(information),
  ]);
  const fcs = ax25Fcs(body);
  return new Uint8Array([...body, fcs & 0xff, fcs >>> 8]);
}

export function hdlcBits(frame: Uint8Array): number[] {
  const flag = [0, 1, 1, 1, 1, 1, 1, 0];
  const bits = [...frame].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (byte >>> bit) & 1),
  );
  const stuffed: number[] = [];
  let ones = 0;
  for (const bit of bits) {
    stuffed.push(bit);
    if (bit === 1) {
      if (++ones === 5) {
        stuffed.push(0);
        ones = 0;
      }
    } else ones = 0;
  }
  return [...flag, ...stuffed, ...flag];
}

export function encodedPacketBits(
  frame: Uint8Array,
  leadingFlags = 24,
): number[] {
  const flag = [0, 1, 1, 1, 1, 1, 1, 0];
  return [
    ...Array.from({ length: leadingFlags }, () => flag).flat(),
    ...hdlcBits(frame),
    ...flag,
    ...flag,
  ];
}

export function generateAfsk(
  bits: number[],
  sampleRateHz: number,
  options: {
    amplitude?: number;
    phase?: number;
    frequencyOffsetHz?: number;
    timingError?: number;
    noise?: number;
  } = {},
): Float32Array {
  const timing = 1 + (options.timingError ?? 0);
  const length = Math.ceil(((bits.length * sampleRateHz) / 1200) * timing);
  const output = new Float32Array(length);
  let tone = 1;
  let phase = options.phase ?? 0;
  let previousBit = -1;
  let seed = 0x12345678;
  for (let index = 0; index < length; index++) {
    const bitIndex = Math.min(
      bits.length - 1,
      Math.floor((index * 1200) / sampleRateHz / timing),
    );
    if (bitIndex !== previousBit) {
      if (bits[bitIndex] === 0) tone ^= 1;
      previousBit = bitIndex;
    }
    const frequency = (tone ? 1200 : 2200) + (options.frequencyOffsetHz ?? 0);
    phase += (2 * Math.PI * frequency) / sampleRateHz;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    output[index] =
      (options.amplitude ?? 1) * Math.sin(phase) +
      ((seed / 0xffffffff) * 2 - 1) * (options.noise ?? 0);
  }
  return output;
}
