import { RdsSymbolRecovery, RDS_BIT_PATHS } from "./rdsSymbolRecovery";

import { RDS_BIT_RATE, RDS_SUBCARRIER_HZ } from "./constants";
export { RDS_BIT_RATE, RDS_SUBCARRIER_HZ } from "./constants";

const OFFSETS = { A: 0x0fc, B: 0x198, C: 0x168, Cprime: 0x350, D: 0x1b4 } as const;
const POLYNOMIAL = 0x5b9;

export interface RdsState {
  pi: string | null;
  programmeService: string | null;
  radioText: string | null;
  validGroups: number;
}

export interface RdsDecoderOptions {
  onUpdate?: (state: RdsState) => void;
  /** Deduplicated, CRC/offset-validated groups only; words are borrowed synchronously. */
  onGroup?: (words: readonly number[]) => void;
}

interface BitPath {
  bits: number[];
}

/**
 * Streaming IEC/EN 62106 RDS decoder. Input is the real, discriminator-output
 * FM multiplex, before audio filtering or de-emphasis. It performs coherent
 * 57 kHz down-conversion, narrow filtering and soft biphase recovery, differential
 * decoding, CRC/offset-word validation and group assembly.
 */
export class RdsDecoder {
  private sampleRate = 228_000;
  private sampleClock = 0;
  private lastGroupSample = -Infinity;
  private lastGroup?: readonly number[];
  private readonly paths: BitPath[] = Array.from({ length: RDS_BIT_PATHS }, () => ({ bits: [] }));
  private readonly recovery = new RdsSymbolRecovery((path, bit, sample) => {
    this.sampleClock = sample;
    this.paths[path]!.bits.push(bit);
    this.scan(this.paths[path]!);
  });
  private state: RdsState = emptyRdsState();
  private stationPi?: number;
  private ps = Array<string>(8).fill(" ");
  private psMask = 0;
  private rt = Array<string>(64).fill(" ");
  private rtMask = 0;
  private rtAb?: number;

  constructor(private readonly options: RdsDecoderOptions = {}) {}

  configure(sampleRate: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= RDS_SUBCARRIER_HZ * 2) {
      throw new Error("RDS multiplex rate must be finite and above 114 ksample/s.");
    }
    this.sampleRate = sampleRate;
    this.recovery.configure(sampleRate);
    this.reset();
  }

  reset(): void {
    this.sampleClock = 0;
    this.lastGroupSample = -Infinity;
    this.lastGroup = undefined;
    this.recovery.reset();
    for (const path of this.paths) path.bits = [];
    this.stationPi = undefined;
    this.ps.fill(" ");
    this.psMask = 0;
    this.rt.fill(" ");
    this.rtMask = 0;
    this.rtAb = undefined;
    this.publish(emptyRdsState());
  }

  getState(): RdsState { return { ...this.state }; }

  process(samples: Float32Array): void {
    this.recovery.process(samples);
  }

  private scan(path: BitPath): void {
    while (path.bits.length >= 104) {
      let found = false;
      for (let start = 0; start <= path.bits.length - 104; start += 1) {
        const a = readBits(path.bits, start, 26);
        const b = readBits(path.bits, start + 26, 26);
        const c = readBits(path.bits, start + 52, 26);
        const d = readBits(path.bits, start + 78, 26);
        const bData = b >>> 10;
        const cOffset = (bData & 0x0800) === 0 ? OFFSETS.C : OFFSETS.Cprime;
        if (validBlock(a, OFFSETS.A) && validBlock(b, OFFSETS.B) && validBlock(c, cOffset) && validBlock(d, OFFSETS.D)) {
          path.bits.splice(0, start + 104);
          this.acceptGroup(a >>> 10, bData, c >>> 10, d >>> 10);
          found = true;
          break;
        }
      }
      if (!found) {
        path.bits.splice(0, path.bits.length - 103);
        break;
      }
    }
  }

  private acceptGroup(a: number, b: number, c: number, d: number): void {
    const words = [a, b, c, d];
    // Timing hypotheses may validate the same on-air group a fraction of a bit
    // apart. Count it once, while preserving later repeated broadcasts.
    if (this.sampleClock - this.lastGroupSample < 2 * this.sampleRate / RDS_BIT_RATE
      && this.lastGroup?.every((word, index) => word === words[index])) return;
    this.lastGroupSample = this.sampleClock;
    this.lastGroup = words;
    if (this.stationPi !== a) {
      this.stationPi = a;
      this.ps.fill(" ");
      this.psMask = 0;
      this.rt.fill(" ");
      this.rtMask = 0;
      this.rtAb = undefined;
    }
    const groupType = b >>> 12;
    const versionB = (b & 0x0800) !== 0;
    if (groupType === 0) {
      const segment = b & 0x03;
      this.ps[segment * 2] = rdsCharacter(d >>> 8);
      this.ps[segment * 2 + 1] = rdsCharacter(d);
      this.psMask |= 1 << segment;
    } else if (groupType === 2) {
      const ab = (b >>> 4) & 1;
      if (this.rtAb !== ab) {
        this.rt.fill(" ");
        this.rtMask = 0;
        this.rtAb = ab;
      }
      const segment = b & 0x0f;
      const codes = versionB ? [d >>> 8, d] : [c >>> 8, c, d >>> 8, d];
      const width = versionB ? 2 : 4;
      for (let index = 0; index < codes.length; index += 1) this.rt[segment * width + index] = rdsCharacter(codes[index]!);
      this.rtMask |= 1 << segment;
    }
    const next: RdsState = {
      pi: a.toString(16).toUpperCase().padStart(4, "0"),
      programmeService: this.psMask === 0x0f ? cleanText(this.ps.join("")) : null,
      radioText: this.rtMask === 0 ? null : cleanText(this.rt.join("")),
      validGroups: this.state.validGroups + 1,
    };
    this.publish(next);
    this.options.onGroup?.(words);
  }

  private publish(state: RdsState): void {
    this.state = state;
    this.options.onUpdate?.({ ...state });
  }
}

export function emptyRdsState(): RdsState {
  return { pi: null, programmeService: null, radioText: null, validGroups: 0 };
}

export function rdsCheckword(data: number): number {
  let register = (data & 0xffff) * 0x400;
  for (let bit = 25; bit >= 10; bit -= 1) {
    if ((register & 2 ** bit) !== 0) register ^= POLYNOMIAL * 2 ** (bit - 10);
  }
  return register & 0x3ff;
}

export function encodeRdsBlock(data: number, offset: number): number {
  return (data & 0xffff) * 0x400 + (rdsCheckword(data) ^ offset);
}

function validBlock(block: number, offset: number): boolean {
  const data = block >>> 10;
  return (block & 0x3ff) === (rdsCheckword(data) ^ offset);
}

function readBits(bits: readonly number[], start: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index += 1) value = value * 2 + bits[start + index]!;
  return value;
}

function rdsCharacter(code: number): string {
  const byte = code & 0xff;
  if (byte === 0x0d) return "\r";
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : " ";
}

function cleanText(value: string): string {
  return value.split("\r", 1)[0]!.replace(/\s+$/u, "");
}

export const RDS_OFFSET_WORDS = OFFSETS;
