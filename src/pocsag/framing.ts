import { correctPocsagWord } from "./bch";
import { interpretPocsag, pocsagDisplayText } from "./characters";
import type { PocsagSettings } from "./settings";
import {
  POCSAG_MAX_WORDS,
  type PocsagEnding,
  type PocsagMessage,
  type PocsagRate,
  type PocsagWord,
} from "./types";
export const POCSAG_SYNC = 0x7cd215d8;
export const POCSAG_IDLE = 0x7a89c197;
type FramedMessage = Omit<
  PocsagMessage,
  "sequence" | "provenance" | "wordEvidence"
> & { words: PocsagWord[]; firstSample: number; lastSample: number };
interface Open {
  address: number | null;
  fn: number | null;
  bits: string;
  words: PocsagWord[];
  erasures: number[];
  first: number;
  last: number;
  corrected: number;
}
export class PocsagFramer {
  private shift = 0;
  private wordBits = 0;
  private wordIndex = 0;
  private active = false;
  private invert = false;
  private alternations = 0;
  private previous = -1;
  private preambleAt = -1e9;
  private bitIndex = 0;
  private syncBit = 0;
  private good = 0;
  private failures = 0;
  private discardPayload = false;
  private open?: Open;
  private pending: FramedMessage[] = [];
  confirmed = false;
  rejected = 0;
  constructor(
    readonly rate: PocsagRate,
    private settings: PocsagSettings,
    private samplesPerBit: number,
    private emit: (message: FramedMessage) => void,
  ) {}
  get synchronized(): boolean {
    return this.active;
  }
  get polarity(): "normal" | "inverted" {
    return this.invert ? "inverted" : "normal";
  }
  get current(): FramedMessage | undefined {
    return this.open && this.confirmed
      ? this.record(this.open, "eof")
      : undefined;
  }
  push(bit: number, sample: number): void {
    this.bitIndex++;
    this.alternations = bit !== this.previous ? this.alternations + 1 : 0;
    this.previous = bit;
    // Allow filter/startup loss within a minimum 576-bit transmitted preamble.
    if (this.alternations >= 512) this.preambleAt = this.bitIndex;
    this.shift = ((this.shift << 1) | bit) >>> 0;
    if (!this.active) {
      for (const inverted of [false, true]) {
        if (
          (this.settings.polarity === "normal" && inverted) ||
          (this.settings.polarity === "inverted" && !inverted)
        )
          continue;
        const c = correctPocsagWord(
          inverted ? ~this.shift : this.shift,
          this.settings.correction,
        );
        if (c?.corrected !== POCSAG_SYNC) continue;
        this.active = true;
        this.invert = inverted;
        this.wordBits = 0;
        this.wordIndex = 0;
        this.syncBit = this.bitIndex;
        this.good = 0;
        this.failures = 0;
        return;
      }
      return;
    }
    if (++this.wordBits < 32) return;
    this.wordBits = 0;
    const received = (this.invert ? ~this.shift : this.shift) >>> 0;
    const c = correctPocsagWord(received, this.settings.correction);
    if (this.wordIndex === 16) {
      if (c?.corrected !== POCSAG_SYNC) {
        this.end("sync-loss");
        this.lose();
        return;
      }
      if (this.bitIndex - this.syncBit === 544 && this.good >= 2)
        this.confirm();
      this.syncBit = this.bitIndex;
      this.wordIndex = 0;
      return;
    }
    const index = this.wordIndex++;
    if (!c) {
      this.rejected++;
      this.failures++;
      if (this.open) {
        this.open.erasures.push(this.open.bits.length);
        this.open.bits += "?".repeat(20);
        this.open.last = sample;
        this.open.words.push({
          received,
          corrected: null,
          correctionMask: 0,
          correctedBits: 0,
          payload: true,
        });
      }
      if (this.failures >= 2) {
        this.end("sync-loss");
        this.lose();
      } else this.checkLimit();
      return;
    }
    this.failures = 0;
    this.good++;
    if (this.bitIndex - this.preambleAt < 3 * 544 && this.good >= 2)
      this.confirm();
    const word: PocsagWord = {
      received,
      corrected: c.corrected,
      correctionMask: c.mask,
      correctedBits: c.count,
      payload: Boolean(c.corrected >>> 31),
    };
    if (c.corrected === POCSAG_IDLE) {
      this.end("idle");
      return;
    }
    if (!word.payload) {
      this.end("next-address");
      this.discardPayload = false;
      this.open = {
        address: ((c.corrected >>> 13) & 0x3ffff) * 8 + (index >>> 1),
        fn: (c.corrected >>> 11) & 3,
        bits: "",
        words: [word],
        erasures: [],
        first: Math.max(0, sample - Math.ceil(31 * this.samplesPerBit)),
        last: sample,
        corrected: c.count,
      };
    } else {
      if (this.discardPayload) return;
      this.open ??= {
        address: null,
        fn: null,
        bits: "",
        words: [],
        erasures: [],
        first: Math.max(0, sample - Math.ceil(31 * this.samplesPerBit)),
        last: sample,
        corrected: 0,
      };
      this.open.bits += ((c.corrected >>> 11) & 0xfffff)
        .toString(2)
        .padStart(20, "0");
      this.open.words.push(word);
      this.open.corrected += c.count;
      this.open.last = sample;
      this.checkLimit();
    }
  }
  end(reason: PocsagEnding): void {
    if (this.open) {
      const record = this.record(this.open, reason);
      if (this.confirmed) this.emit(record);
      else {
        this.pending.push(record);
        if (this.pending.length > 16) this.pending.shift();
      }
      this.open = undefined;
    }
  }
  reset(reason: PocsagEnding): void {
    this.end(reason);
    this.lose();
    this.shift = 0;
    this.wordBits = 0;
    this.alternations = 0;
    this.previous = -1;
    this.preambleAt = -1e9;
  }
  private record(open: Open, reason: PocsagEnding): FramedMessage {
    const requested = this.settings.interpretation;
    const interpretation =
      requested === "function"
        ? open.fn === 0
          ? "numeric"
          : open.fn === 3
            ? "alpha"
            : "raw"
        : requested;
    const text = pocsagDisplayText(interpretPocsag(open.bits, interpretation));
    return {
      rate: this.rate,
      polarity: this.polarity,
      address: open.address,
      function: open.fn,
      interpretation,
      text: text.slice(0, 2048),
      displayTruncated: text.length > 2048,
      payloadBits: open.bits,
      words: open.words.slice(),
      erasures: open.erasures.slice(),
      correctedBits: open.corrected,
      complete:
        (reason === "idle" || reason === "next-address") &&
        open.address !== null,
      ending: reason,
      firstSample: open.first,
      lastSample: open.last,
    };
  }
  private checkLimit(): void {
    if (this.open && this.open.bits.length >= POCSAG_MAX_WORDS * 20) {
      this.end("limit");
      this.discardPayload = true;
    }
  }
  private confirm(): void {
    if (!this.confirmed) {
      this.confirmed = true;
      for (const r of this.pending) this.emit(r);
      this.pending = [];
    }
  }
  private lose(): void {
    this.active = false;
    this.confirmed = false;
    this.pending = [];
    this.open = undefined;
    this.discardPayload = false;
  }
}
export type { FramedMessage };
