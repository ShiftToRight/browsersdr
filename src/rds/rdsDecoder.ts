export const RDS_BIT_RATE = 1_187.5;
export const RDS_SUBCARRIER_HZ = 57_000;

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
}

interface BitPath {
  encodedPrevious?: number;
  bits: number[];
}

/**
 * Streaming IEC/EN 62106 RDS decoder. Input is the real, discriminator-output
 * FM multiplex, before audio filtering or de-emphasis. It performs coherent
 * 57 kHz down-conversion, integrate-and-dump biphase recovery, differential
 * decoding, CRC/offset-word validation and group assembly.
 */
export class RdsDecoder {
  private sampleRate = 228_000;
  private samplesPerChip = this.sampleRate / (RDS_BIT_RATE * 2);
  private sampleClock = 0;
  private chipClock = 0;
  private chipI = 0;
  private chipQ = 0;
  private referenceI?: number;
  private referenceQ?: number;
  private basebandI = 0;
  private basebandQ = 0;
  private previousBasebandSign?: number;
  private chipCount = 0;
  private previousChip?: number;
  private readonly paths: [BitPath, BitPath] = [{ bits: [] }, { bits: [] }];
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
    this.samplesPerChip = sampleRate / (RDS_BIT_RATE * 2);
    this.reset();
  }

  reset(): void {
    this.sampleClock = 0;
    this.chipClock = 0;
    this.chipI = 0;
    this.chipQ = 0;
    this.referenceI = undefined;
    this.referenceQ = undefined;
    this.basebandI = 0;
    this.basebandQ = 0;
    this.previousBasebandSign = undefined;
    this.chipCount = 0;
    this.previousChip = undefined;
    for (const path of this.paths) {
      path.encodedPrevious = undefined;
      path.bits = [];
    }
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
    const phaseStep = 2 * Math.PI * RDS_SUBCARRIER_HZ / this.sampleRate;
    for (let index = 0; index < samples.length; index += 1) {
      const phase = phaseStep * this.sampleClock;
      const sample = samples[index] ?? 0;
      const mixedI = sample * Math.cos(phase);
      const mixedQ = -sample * Math.sin(phase);
      this.chipI += mixedI;
      this.chipQ += mixedQ;
      // A low-pass baseband sign transition should land on a biphase chip
      // boundary. Pull the fractional chip clock gently toward that edge;
      // this tracks arbitrary initial phase and small station/sample-clock drift.
      this.basebandI += 0.08 * (mixedI - this.basebandI);
      this.basebandQ += 0.08 * (mixedQ - this.basebandQ);
      if (this.referenceI !== undefined && this.referenceQ !== undefined) {
        const sign = this.basebandI * this.referenceI + this.basebandQ * this.referenceQ >= 0 ? 1 : 0;
        if (this.previousBasebandSign !== undefined && sign !== this.previousBasebandSign) {
          const error = this.chipClock < this.samplesPerChip / 2
            ? this.chipClock
            : this.chipClock - this.samplesPerChip;
          this.chipClock -= error * 0.04;
        }
        this.previousBasebandSign = sign;
      }
      this.sampleClock += 1;
      this.chipClock += 1;
      if (this.chipClock + 1e-9 >= this.samplesPerChip) {
        this.finishChip();
        this.chipClock -= this.samplesPerChip;
        this.chipI = 0;
        this.chipQ = 0;
      }
    }
  }

  private finishChip(): void {
    if (this.referenceI === undefined || this.referenceQ === undefined) {
      this.referenceI = this.chipI;
      this.referenceQ = this.chipQ;
    }
    const chip = this.chipI * this.referenceI + this.chipQ * this.referenceQ >= 0 ? 1 : 0;
    // Remove the BPSK sign and slowly follow the carrier phasor. This Costas-like
    // decision-directed update tolerates unknown phase and small 57 kHz offset.
    const polarity = chip === 1 ? 1 : -1;
    this.referenceI += 0.02 * (polarity * this.chipI - this.referenceI);
    this.referenceQ += 0.02 * (polarity * this.chipQ - this.referenceQ);
    for (let pairing = 0; pairing < 2; pairing += 1) {
      if (this.previousChip === undefined || this.chipCount < pairing + 1 || (this.chipCount - pairing) % 2 !== 1) continue;
      const first = this.previousChip;
      const second = chip;
      if (first === second) {
        this.paths[pairing]!.encodedPrevious = undefined;
        this.paths[pairing]!.bits = [];
        continue;
      }
      const path = this.paths[pairing]!;
      const encoded = first;
      if (path.encodedPrevious !== undefined) {
        path.bits.push(encoded ^ path.encodedPrevious);
        this.scan(path);
      }
      path.encodedPrevious = encoded;
    }
    this.previousChip = chip;
    this.chipCount += 1;
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
