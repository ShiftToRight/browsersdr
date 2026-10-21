// Extended BCH(31,21) plus even parity. Independent implementation of the
// polynomial in ITU-R M.584-2 Annex 1; masks include the overall parity bit.
export function parity32(word: number): number {
  word ^= word >>> 16;
  word ^= word >>> 8;
  word ^= word >>> 4;
  return (0x6996 >>> (word & 15)) & 1;
}
export function pocsagSyndrome(word: number): number {
  let r = word >>> 1;
  for (let bit = 30; bit >= 10; bit--)
    if ((r >>> bit) & 1) r ^= 0x769 << (bit - 10);
  return (r & 1023) | (parity32(word) << 10);
}
const masks = new Uint32Array(2048);
const weights = new Uint8Array(2048);
for (let a = 0; a < 32; a++) {
  const one = (2 ** a) >>> 0;
  let s = pocsagSyndrome(one);
  masks[s] = one;
  weights[s] = 1;
  for (let b = a + 1; b < 32; b++) {
    const two = (one ^ (2 ** b)) >>> 0;
    s = pocsagSyndrome(two);
    masks[s] = two;
    weights[s] = 2;
  }
}
export function correctPocsagWord(
  received: number,
  maximum = 2,
): { corrected: number; mask: number; count: number } | null {
  received >>>= 0;
  const syndrome = pocsagSyndrome(received);
  if (!syndrome) return { corrected: received, mask: 0, count: 0 };
  const count = weights[syndrome]!;
  if (!count || count > maximum) return null;
  const mask = masks[syndrome]!;
  const corrected = (received ^ mask) >>> 0;
  return pocsagSyndrome(corrected) ? null : { corrected, mask, count };
}
