import {
  bitCount,
  CCIR_FIGURES,
  CCIR_LETTERS,
  ITA2_FIGURES,
  ITA2_LETTERS,
  printable,
  PSK31_VARICODE,
} from "./characters";
import type { TextModemSettings } from "./settings";

export type FramedOutput = {
  text: string;
  integrity: string;
  complete: boolean;
  header?: string;
  address?: string;
  label?: string;
};
export interface ModemCallbacks {
  character(text: string): void;
  message(value: FramedOutput): void;
  error(): void;
  corrected(): void;
}
/** Asynchronous ITA2: falling start edge, five LSB-first data bits, checked stop interval. */
export class RttyFramer {
  private previous = 1;
  private idle = 0;
  private age = -1;
  private data = 0;
  private bit = 0;
  private figures = false;
  private stopValid = true;
  constructor(
    private readonly settings: TextModemSettings,
    private readonly callbacks: ModemCallbacks,
  ) {}
  push(mark: boolean): void {
    const value = mark ? 1 : 0;
    const period = 1000 / this.settings.baud;
    if (this.age < 0) {
      if (!value && this.previous && this.idle >= period * 0.45) {
        this.age = 0;
        this.data = this.bit = 0;
        this.stopValid = true;
      }
    } else {
      this.age++;
      if (this.bit < 5 && this.age >= period * (1.5 + this.bit)) {
        this.data |= value << this.bit;
        this.bit++;
      }
      if (this.age >= period * 6.5 && !value) this.stopValid = false;
      if (this.age >= period * (6 + this.settings.stopBits - 0.2)) {
        if (this.stopValid) {
          if (this.data === 27) this.figures = true;
          else if (this.data === 31) this.figures = false;
          else
            this.callbacks.character(
              printable(
                (this.figures ? ITA2_FIGURES : ITA2_LETTERS)[this.data] ?? "",
              ),
            );
        } else this.callbacks.error();
        this.age = -1;
      }
    }
    this.idle = value ? this.idle + 1 : 0;
    this.previous = value;
  }
}

const varicode = new Map<string, string>(
  PSK31_VARICODE.map((code, index) => [code, String.fromCharCode(index)]),
);
export class VaricodeFramer {
  private bits = "";
  constructor(private readonly callbacks: ModemCallbacks) {}
  push(bit: number): void {
    this.bits += bit ? "1" : "0";
    if (this.bits.endsWith("00")) {
      const code = this.bits.slice(0, -2).replace(/^0+/, "");
      if (code) {
        const character = varicode.get(code);
        if (character !== undefined)
          this.callbacks.character(printable(character));
        else this.callbacks.error();
      }
      this.bits = "";
    } else if (this.bits.length > 12) {
      this.bits = "";
      this.callbacks.error();
    }
  }
}

/** CCIR476: locate REP/ALPHA phasing, then compare each late copy with the
 * early copy five 7-bit characters before it. Ambiguous valid pairs are erased. */
export class SitorFramer {
  private shift = 0;
  private syncPair = 0;
  private bits = 0;
  private phaseHits = 0;
  private lastPhaseBit = -100;
  private locked = false;
  private late = false;
  private word = 0;
  private wordBits = 0;
  private history: number[] = [];
  private figures = false;
  private pending = "";
  private errors = 0;
  private corrections = 0;
  private invalidRun = 0;
  constructor(private readonly callbacks: ModemCallbacks) {}
  push(bit: number): void {
    this.bits++;
    this.shift = (this.shift >> 1) | (bit << 6);
    this.syncPair = (this.syncPair >>> 1) | (bit << 13);
    if (!this.locked) {
      if (
        this.syncPair === ((0x0f << 7) | 0x66) &&
        this.bits - this.lastPhaseBit === 14
      )
        this.phaseHits++;
      else if (this.syncPair === ((0x0f << 7) | 0x66)) this.phaseHits = 1;
      if (this.syncPair === ((0x0f << 7) | 0x66)) this.lastPhaseBit = this.bits;
      if (this.phaseHits >= 4) {
        this.locked = true;
        this.late = false;
        this.word = this.wordBits = 0;
        this.history = [0x0f, 0x66, 0x0f, 0x66, 0x0f];
      }
      return;
    }
    this.word |= bit << this.wordBits++;
    if (this.wordBits < 7) return;
    const code = this.word;
    this.word = this.wordBits = 0;
    const prior = this.history.shift()!;
    this.history.push(code);
    if (this.late) {
      const valid = bitCount(code) === 4;
      const priorValid = bitCount(prior) === 4;
      let chosen: number | undefined;
      if (valid && priorValid && code === prior) chosen = code;
      else if (code === 0x0f && prior === 0x66) chosen = code;
      else if (valid && !priorValid) {
        chosen = code;
        this.correct();
      } else if (!valid && priorValid) {
        chosen = prior;
        this.correct();
      }
      if (chosen === undefined) {
        this.errors++;
        this.callbacks.error();
        this.append("�");
        this.invalidRun++;
      } else {
        this.invalidRun = 0;
        this.decode(chosen);
      }
      if (this.invalidRun > 12) {
        this.locked = false;
        this.phaseHits = 0;
        this.pending = "";
        this.figures = false;
      }
    }
    this.late = !this.late;
  }
  private correct(): void {
    this.corrections++;
    this.callbacks.corrected();
  }
  private decode(code: number): void {
    if (code === 0x5a) this.figures = false;
    else if (code === 0x36) this.figures = true;
    else if (![0x0f, 0x66, 0x33, 0x6a].includes(code))
      this.append(
        printable((this.figures ? CCIR_FIGURES : CCIR_LETTERS)[code] ?? ""),
      );
  }
  private append(text: string): void {
    this.callbacks.character(text);
    this.pending = (this.pending + text).slice(-4096);
    const start = this.pending.lastIndexOf("ZCZC");
    if (start < 0) {
      this.pending = this.pending.slice(-8);
      return;
    }
    if (start > 0) {
      this.pending = this.pending.slice(start);
      this.errors = this.corrections = 0;
    }
    if (this.pending.endsWith("NNNN")) {
      const header = /^ZCZC\s+([A-Z]{2}\d{2})/.exec(this.pending)?.[1];
      this.callbacks.message({
        text: this.pending,
        header,
        complete: Boolean(header),
        integrity: `CCIR476 FEC · ${this.corrections} recovered · ${this.errors} erasures · no CRC`,
      });
      this.pending = "";
      this.errors = this.corrections = 0;
    }
  }
}

/** ACARS CRC-16/KERMIT, initial zero, includes transmitted parity bits;
 * SOH excluded, ETX/ETB included; the two received BCS octets give residue zero. */
export function acarsCrc(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
  }
  return crc;
}
export class AcarsFramer {
  private shift = 0;
  private sync = 0;
  private bits = 0;
  private bytes: number[] | undefined;
  private crcRemaining = -1;
  constructor(private readonly callbacks: ModemCallbacks) {}
  push(bit: number): void {
    this.shift = (this.shift >>> 1) | (bit << 7);
    if (!this.bytes) {
      this.sync = ((this.sync >>> 1) | (bit << 23)) >>> 0;
      if (this.sync === 0x011616) {
        this.bytes = [];
        this.bits = 0;
        this.crcRemaining = -1;
      }
      return;
    }
    if (++this.bits < 8) return;
    this.bits = 0;
    this.bytes.push(this.shift);
    if (this.crcRemaining > 0) {
      if (--this.crcRemaining === 0) this.finish();
    } else if ([0x83, 0x97].includes(this.shift)) this.crcRemaining = 2;
    if (this.bytes && this.bytes.length > 244) {
      this.callbacks.error();
      this.bytes = undefined;
      this.sync = 0;
    }
  }
  private finish(): void {
    const bytes = this.bytes!;
    const body = bytes.slice(0, -2);
    const parity = body.every((byte) => bitCount(byte) % 2 === 1);
    const valid =
      parity &&
      acarsCrc(bytes) === 0 &&
      body.length >= 13 &&
      [2, 3, 23].includes(body[12]! & 0x7f);
    if (valid) {
      const ascii = body
        .map((byte) => String.fromCharCode(byte & 0x7f))
        .join("");
      this.callbacks.message({
        text: (body[12]! & 0x7f) === 2 ? printable(ascii.slice(13, -1)) : "",
        complete: (body.at(-1)! & 0x7f) === 3,
        address: ascii.slice(1, 8),
        label: ascii.slice(9, 11),
        header: `Mode ${ascii[0]} · ACK ${ascii.charCodeAt(8) === 21 ? "NAK" : printable(ascii[8]!)} · block ${ascii[11]}`,
        integrity: "CRC and odd parity passed · uncorrected",
      });
    } else this.callbacks.error();
    this.bytes = undefined;
    this.sync = 0;
  }
}
