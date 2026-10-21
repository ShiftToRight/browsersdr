// Independently authored test encoder: polynomial long division using BigInt,
// deliberately independent of the production syndrome/mask implementation.
import type { PocsagRate } from "../types";
export function encodeWord(data: number): number {
  let remainder = BigInt(data) << 10n;
  for (let bit = 30n; bit >= 10n; bit--)
    if (remainder & (1n << bit)) remainder ^= 0x769n << (bit - 10n);
  let word = (BigInt(data) << 11n) | (remainder << 1n);
  let parity = 0n;
  for (let x = word; x; x >>= 1n) parity ^= x & 1n;
  word |= parity;
  return Number(word);
}
export function pocsagBits(
  text = "POCSAG TEST",
  address = 123456,
  functionCode = 3,
  complete = true,
): number[] {
  const payload = [...text].flatMap((c) =>
    Array.from({ length: 7 }, (_, n) => (c.charCodeAt(0) >>> n) & 1),
  );
  const words: number[] = Array.from(
    { length: (address & 7) * 2 },
    () => 0x7a89c197,
  );
  words.push(encodeWord(((address >>> 3) << 2) | functionCode));
  for (let i = 0; i < payload.length; i += 20)
    words.push(
      encodeWord(
        0x100000 |
          Number.parseInt(
            payload
              .slice(i, i + 20)
              .join("")
              .padEnd(20, "0"),
            2,
          ),
      ),
    );
  if (complete) {
    words.push(0x7a89c197);
    while (words.length % 16) words.push(0x7a89c197);
  }
  const stream = Array.from({ length: 640 }, (_, n) => n & 1);
  for (let i = 0; i < words.length; i++) {
    if (i % 16 === 0) stream.push(...wordBits(0x7cd215d8));
    stream.push(...wordBits(words[i]!));
  }
  return stream;
}
export const wordBits = (word: number) =>
  Array.from({ length: 32 }, (_, n) => (word >>> (31 - n)) & 1);
export function pocsagAudio(
  bits: number[],
  rate: PocsagRate,
  sampleRate: number,
  inverted = false,
  offset = 0,
  ppm = 0,
): Float32Array {
  return Float32Array.from(
    {
      length: Math.ceil((bits.length * sampleRate) / (rate * (1 + ppm / 1e6))),
    },
    (_, n) =>
      ((bits[
        Math.min(
          bits.length - 1,
          Math.floor((n * rate * (1 + ppm / 1e6)) / sampleRate),
        )
      ] ?? 0) ^ (inverted ? 1 : 0)
        ? 4500
        : -4500) + offset,
  );
}
