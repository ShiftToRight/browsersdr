export const CU8_MIDPOINT = 127.5;
export const CU8_SCALE = 128;
export const CU8_NORMALIZATION =
  "float = (byte - 127.5) / 128" as const;

export function cu8ByteToFloat(byte: number): number {
  return (byte - CU8_MIDPOINT) / CU8_SCALE;
}

export function floatToCu8Byte(value: number): number {
  return Math.max(
    0,
    Math.min(255, Math.round(value * CU8_SCALE + CU8_MIDPOINT)),
  );
}

export function decodeCu8Into(
  input: ArrayBuffer | Uint8Array,
  I: Float32Array,
  Q: Float32Array,
): void {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("CU8 data must contain complete I/Q byte pairs.");
  }
  const length = bytes.byteLength / 2;
  if (I.length !== length || Q.length !== length) {
    throw new RangeError("CU8 output arrays must match the complex sample count.");
  }
  for (let index = 0; index < length; index += 1) {
    I[index] = cu8ByteToFloat(bytes[index * 2]!);
    Q[index] = cu8ByteToFloat(bytes[index * 2 + 1]!);
  }
}

/** Four rotating blocks preserve the borrowed-buffer behavior of Signals' converter. */
export class Cu8Float32Converter {
  private readonly pool = Array.from({ length: 4 }, () => ({
    I: new Float32Array(0),
    Q: new Float32Array(0),
  }));
  private next = 0;

  convert(input: ArrayBuffer | Uint8Array): {
    I: Float32Array;
    Q: Float32Array;
  } {
    const length = input.byteLength / 2;
    const slot = this.pool[this.next]!;
    this.next = (this.next + 1) % this.pool.length;
    if (slot.I.length !== length) {
      slot.I = new Float32Array(length);
      slot.Q = new Float32Array(length);
    }
    decodeCu8Into(input, slot.I, slot.Q);
    return slot;
  }
}
