import { APRS_MAX_AX25_FRAME_BYTES } from "./types";

export interface HdlcCandidate {
  bytes: Uint8Array;
  firstSampleIndex: number;
  lastSampleIndex: number;
}

/** Streaming, LSB-first HDLC deframer. Input bits are after NRZI decoding. */
export class HdlcDeframer {
  private shift = 0;
  private rawBits: { bit: number; sample: number }[] = [];
  private inFrame = false;

  reset(): void {
    this.shift = 0;
    this.rawBits = [];
    this.inFrame = false;
  }

  push(bit: number, sampleIndex: number): HdlcCandidate[] {
    this.shift = ((this.shift >>> 1) | ((bit & 1) << 7)) & 0xff;
    if (this.inFrame) this.rawBits.push({ bit: bit & 1, sample: sampleIndex });
    if (this.shift === 0x7e) {
      const contents = this.rawBits.slice(0, -8);
      const result = this.decode(contents);
      this.rawBits = [];
      this.inFrame = true;
      return result ? [result] : [];
    }
    if (
      this.inFrame &&
      this.rawBits.length > APRS_MAX_AX25_FRAME_BYTES * 10 + 16
    ) {
      this.inFrame = false;
      this.rawBits = [];
    }
    return [];
  }

  private decode(
    raw: { bit: number; sample: number }[],
  ): HdlcCandidate | undefined {
    if (raw.length < 16) return undefined;
    const bits: typeof raw = [];
    let ones = 0;
    for (const entry of raw) {
      if (entry.bit === 1) {
        if (++ones >= 7) return undefined;
        bits.push(entry);
      } else {
        if (ones === 5) {
          ones = 0;
          continue;
        }
        if (ones >= 6) return undefined;
        ones = 0;
        bits.push(entry);
      }
    }
    if (bits.length % 8 !== 0) return undefined;
    const bytes = new Uint8Array(bits.length / 8);
    for (let index = 0; index < bits.length; index++)
      bytes[index >>> 3] =
        bytes[index >>> 3]! | (bits[index]!.bit << (index & 7));
    if (bytes.length < 2 || bytes.length > APRS_MAX_AX25_FRAME_BYTES)
      return undefined;
    return {
      bytes,
      firstSampleIndex: bits[0]!.sample,
      lastSampleIndex: bits[bits.length - 1]!.sample,
    };
  }
}
