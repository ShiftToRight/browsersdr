/** Decode borrowed little-endian bladeRF SC16 Q11 bytes into bounded planar floats. */
export function decodeSc16Q11Into(bytes: Uint8Array, I: Float32Array, Q: Float32Array): number {
  const count = bytes.byteLength / 4;
  if (!Number.isInteger(count) || count > I.length || count > Q.length) throw new Error("Invalid bounded SC16 Q11 block.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let n = 0; n < count; n++) {
    I[n] = view.getInt16(n * 4, true) / 2048;
    Q[n] = view.getInt16(n * 4 + 2, true) / 2048;
  }
  return count;
}
