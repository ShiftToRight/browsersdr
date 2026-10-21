import { PocsagFramer, type FramedMessage } from "./framing";
import type { PocsagSettings } from "./settings";
import type { PocsagEnding, PocsagRate } from "./types";
interface Candidate {
  framer: PocsagFramer;
  phase: number;
  previous: number;
  filtered: number;
  step: number;
  alpha: number;
}
export class PocsagDemodulator {
  private candidates: Candidate[];
  private dc = 0;
  private owner?: Candidate;
  constructor(
    private sampleRate: number,
    private settings: PocsagSettings,
    inputRate: number,
    private emit: (message: FramedMessage) => void,
  ) {
    const rates: PocsagRate[] =
      settings.rate === "auto" ? [512, 1200, 2400] : [settings.rate];
    this.candidates = rates.map((rate) => {
      const candidate: Candidate = {
        phase: 0,
        previous: 0,
        filtered: 0,
        step: rate / sampleRate,
        alpha: 1 - Math.exp((-2 * Math.PI * rate * 0.8) / sampleRate),
        framer: null!,
      };
      candidate.framer = new PocsagFramer(
        rate,
        settings,
        inputRate / rate,
        (message) => {
          if (!this.owner || this.owner === candidate) {
            this.owner = candidate;
            this.emit(message);
          }
        },
      );
      return candidate;
    });
  }
  process(samples: Float32Array, first: number, stride: number): void {
    const trackingAlpha = 1 - Math.exp(-1 / (0.15 * this.sampleRate));
    const acquisitionAlpha = 1 - Math.exp(-1 / (0.005 * this.sampleRate));
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i]!;
      // Settle the carrier midpoint inside the preamble, even when the offset
      // approaches the deviation. Once a sync is found, preserve long payload
      // runs with the slower tracking time constant.
      const alpha = this.candidates.some((c) => c.framer.synchronized)
        ? trackingAlpha
        : acquisitionAlpha;
      this.dc += alpha * (value - this.dc);
      for (const c of this.candidates) {
        c.filtered += c.alpha * (value - this.dc - c.filtered);
        const bit = c.filtered > 0 ? 1 : 0;
        if (bit !== c.previous) {
          c.phase += c.phase < 0.5 - c.step / 2 ? c.step / 8 : -c.step / 8;
          c.previous = bit;
        }
        c.phase += c.step;
        if (c.phase >= 1) {
          c.phase -= 1;
          c.framer.push(bit, first + i * stride);
        }
      }
      if (this.owner && !this.owner.framer.confirmed) this.owner = undefined;
    }
  }
  reset(reason: PocsagEnding): void {
    for (const c of this.candidates) {
      c.framer.reset(reason);
      c.phase = 0;
      c.previous = 0;
      c.filtered = 0;
    }
    this.dc = 0;
    this.owner = undefined;
  }
  flush(): void {
    for (const c of this.candidates) c.framer.end("eof");
  }
  get active(): PocsagFramer | undefined {
    return (
      this.owner?.framer ??
      this.candidates.find((c) => c.framer.confirmed)?.framer
    );
  }
  get acquiring(): boolean {
    return this.candidates.some((c) => c.framer.synchronized);
  }
  get rejected(): number {
    return this.candidates.reduce((sum, c) => sum + c.framer.rejected, 0);
  }
}
