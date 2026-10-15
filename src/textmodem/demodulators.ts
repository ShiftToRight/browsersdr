import type { TextModemSettings } from "./settings";

/** Noncoherent complex two-tone detector. Cascaded low-pass branches reject the
 * opposite tone; output is sampled at 1 kHz for fractional-baud timing. */
export class TwoToneDetector {
  private phase = 0;
  private count = 0;
  private mi = 0;
  private mq = 0;
  private si = 0;
  private sq = 0;
  private mi2 = 0;
  private mq2 = 0;
  private si2 = 0;
  private sq2 = 0;
  confidence = 0;
  level = 0;
  constructor(
    private readonly rate: number,
    private readonly shift: number,
    private readonly baud: number,
    private readonly inverted: boolean,
    private readonly output: (mark: boolean) => void,
  ) {}
  push(i: number, q: number): void {
    const cosine = Math.cos(this.phase),
      sine = Math.sin(this.phase);
    this.phase =
      (this.phase + (Math.PI * this.shift) / this.rate) % (2 * Math.PI);
    const a = 1 - Math.exp((-2 * Math.PI * this.baud * 0.8) / this.rate);
    this.mi += a * (i * cosine + q * sine - this.mi);
    this.mq += a * (q * cosine - i * sine - this.mq);
    this.si += a * (i * cosine - q * sine - this.si);
    this.sq += a * (q * cosine + i * sine - this.sq);
    this.mi2 += a * (this.mi - this.mi2);
    this.mq2 += a * (this.mq - this.mq2);
    this.si2 += a * (this.si - this.si2);
    this.sq2 += a * (this.sq - this.sq2);
    if ((this.count += 1000) < this.rate) return;
    this.count -= this.rate;
    const mark = this.mi2 ** 2 + this.mq2 ** 2,
      space = this.si2 ** 2 + this.sq2 ** 2;
    this.level = Math.sqrt(mark + space);
    this.confidence = Math.abs(mark - space) / (mark + space + 1e-12);
    this.output(mark > space !== this.inverted);
  }
}

/** Transition-directed 100-baud clock. Each edge pulls the next decision
 * toward the centre of a bit while retaining fractional phase between edges. */
export class SynchronousBitClock {
  private previous = false;
  private phase = 0;
  constructor(private readonly output: (bit: number) => void) {}
  push(mark: boolean): void {
    if (mark !== this.previous) {
      let error = this.phase > 0.5 ? this.phase - 1 : this.phase;
      error = Math.max(-0.25, Math.min(0.25, error));
      this.phase -= error * 0.45;
    }
    const before = this.phase;
    this.phase += 0.1;
    if (before < 0.5 && this.phase >= 0.5) this.output(mark ? 1 : 0);
    if (this.phase >= 1) this.phase -= 1;
    this.previous = mark;
  }
}

/** BPSK31 at a 1 kHz decision clock: narrow complex filter, Costas carrier
 * tracking and amplitude timing recovery; differential phase -> Varicode bits. */
export class Bpsk31Demodulator {
  private phase = 0;
  private frequency = 0;
  private fi = 0;
  private fq = 0;
  private fi2 = 0;
  private fq2 = 0;
  private count = 0;
  private clock = 0;
  private energy = new Float64Array(32);
  private peak = 16;
  private periods = 0;
  private previousI = 0;
  private previousQ = 0;
  private ready = false;
  private lastDecision = -100;
  level = 0;
  confidence = 0;
  frequencyErrorHz = 0;
  constructor(
    private readonly rate: number,
    private readonly output: (bit: number) => void,
  ) {}
  push(i: number, q: number): void {
    const a = 1 - Math.exp((-2 * Math.PI * 70) / this.rate);
    this.fi += a * (i - this.fi);
    this.fq += a * (q - this.fq);
    this.fi2 += a * (this.fi - this.fi2);
    this.fq2 += a * (this.fq - this.fq2);
    if ((this.count += 1000) < this.rate) return;
    this.count -= this.rate;
    const cosine = Math.cos(this.phase),
      sine = Math.sin(this.phase);
    const x = this.fi2 * cosine + this.fq2 * sine,
      y = this.fq2 * cosine - this.fi2 * sine;
    const power = Math.hypot(x, y);
    const error = power > 1e-4 ? Math.atan2(y * Math.sign(x), Math.abs(x)) : 0;
    this.frequency = Math.max(
      -0.09,
      Math.min(0.09, this.frequency + error * 0.00015),
    );
    this.phase = (this.phase + this.frequency + error * 0.04) % (2 * Math.PI);
    this.frequencyErrorHz = (this.frequency * 1000) / (2 * Math.PI);
    const bin = this.clock++ % 32;
    this.energy[bin] = this.energy[bin]! * 0.9 + power * power * 0.1;
    if (bin === 31 && ++this.periods % 8 === 0) {
      let best = this.peak;
      for (let n = 0; n < 32; n++)
        if (this.energy[n]! > this.energy[best]! * 1.03) best = n;
      this.peak = best;
    }
    this.level = power;
    this.confidence = Math.abs(x) / (power + 1e-12);
    // A timing-bin move across wrap must not emit two decisions one sample apart.
    if (bin !== this.peak || this.clock - this.lastDecision < 24) return;
    this.lastDecision = this.clock;
    if (this.ready && power > 1e-4)
      this.output(x * this.previousI + y * this.previousQ >= 0 ? 1 : 0);
    this.previousI = x;
    this.previousQ = y;
    this.ready = power > 1e-4;
  }
}

export const rttyToneOffsets = (settings: TextModemSettings) => ({
  mark: settings.tuningOffsetHz + settings.shiftHz / 2,
  space: settings.tuningOffsetHz - settings.shiftHz / 2,
});
