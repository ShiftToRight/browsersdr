/** Borrowed interleaved signed I,Q bytes. No allocation or mutation of the source. */
export function decodeCi8Into(bytes: Uint8Array, I: Float32Array, Q: Float32Array): number {
  const count = bytes.byteLength / 2;
  if (!Number.isInteger(count) || count > I.length || count > Q.length) throw new Error("Invalid bounded CI8 block.");
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let n = 0; n < count; n++) { I[n] = signed[2 * n]! / 128; Q[n] = signed[2 * n + 1]! / 128; }
  return count;
}
