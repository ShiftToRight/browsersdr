import { CHANNEL_MAX_SAMPLES } from "../radio/widebandChannel";
// Retained scalar reference for numerical comparison with the WASM kernel.
/** Symmetric Blackman half-band stage. Only retained output phases are evaluated.
 * Fixed storage, no per-sample allocation. State/oscillator reset at each generation/gap.
 * The original 95-tap stage at 4.8 MS/s preserves ±1 MHz, rejecting from ±1.4 MHz;
 * its 1.0–1.2 MHz output edge is a guard band. Delay is (tapCount - 1) / 2 input samples. */
export class HalfBandStage {
  private readonly taps: Float64Array;
  private readonly historyI: Float64Array;
  private readonly historyQ: Float64Array;
  private cursor = 0;
  private parity = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private rotationI = 1;
  private rotationQ = 0;
  private count = 0;
  private mixing = false;
  constructor(
    offsetHz: number,
    private readonly rate: number,
    private readonly tapCount: number,
  ) {
    this.taps = new Float64Array(tapCount);
    this.historyI = new Float64Array(tapCount * 2);
    this.historyQ = new Float64Array(tapCount * 2);
    const middle = (this.tapCount - 1) / 2;
    const cutoff = 0.25;
    let sum = 0;
    for (let n = 0; n < this.tapCount; n++) {
      const x = n - middle;
      const sinc =
        x === 0
          ? 2 * cutoff
          : x % 2 === 0
            ? 0
            : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * n) / (this.tapCount - 1)) +
        0.08 * Math.cos((4 * Math.PI * n) / (this.tapCount - 1));
      this.taps[n] = sinc * window;
      sum += this.taps[n]!;
    }
    for (let n = 0; n < this.tapCount; n++) this.taps[n] = this.taps[n]! / sum;
    this.reset(offsetHz);
  }
  reset(offsetHz: number): void {
    if (!Number.isFinite(offsetHz) || Math.abs(offsetHz) >= this.rate / 2)
      throw new Error("Invalid wideband channel offset.");
    this.historyI.fill(0);
    this.historyQ.fill(0);
    this.cursor = 0;
    this.parity = 0;
    this.count = 0;
    this.oscillatorI = 1;
    this.oscillatorQ = 0;
    this.mixing = offsetHz !== 0;
    this.rotationI = Math.cos((-2 * Math.PI * offsetHz) / this.rate);
    this.rotationQ = Math.sin((-2 * Math.PI * offsetHz) / this.rate);
  }
  /** In-place result occupies the first returned-count elements of I and Q. */
  process(I: Float32Array, Q: Float32Array): number {
    if (I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES)
      throw new Error("Invalid wideband channel block size.");
    let out = 0;
    for (let n = 0; n < I.length; n++) {
      let i = I[n]!,
        q = Q[n]!;
      if (this.mixing) {
        i = I[n]! * this.oscillatorI - Q[n]! * this.oscillatorQ;
        q = I[n]! * this.oscillatorQ + Q[n]! * this.oscillatorI;
        const nextI =
          this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
        this.oscillatorQ =
          this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI;
        this.oscillatorI = nextI;
        if (++this.count === 4096) {
          const norm = Math.hypot(this.oscillatorI, this.oscillatorQ);
          this.oscillatorI /= norm;
          this.oscillatorQ /= norm;
          this.count = 0;
        }
      }
      const index = this.cursor;
      this.historyI[index] = this.historyI[index + this.tapCount] = i;
      this.historyQ[index] = this.historyQ[index + this.tapCount] = q;
      this.cursor = index + 1 === this.tapCount ? 0 : index + 1;
      this.parity ^= 1;
      if (this.parity !== 0) continue;
      let sumI = 0,
        sumQ = 0;
      // Symmetric half-band FIR: skip zero taps, pair symmetric coefficients.
      // Contiguous mirrored history avoids modulo arithmetic inside the FIR.
      const start = this.cursor;
      const middle = (this.tapCount - 1) / 2;
      for (let t = 0; t < middle; t += 2) {
        sumI +=
          this.taps[t]! *
          (this.historyI[start + t]! +
            this.historyI[start + this.tapCount - 1 - t]!);
        sumQ +=
          this.taps[t]! *
          (this.historyQ[start + t]! +
            this.historyQ[start + this.tapCount - 1 - t]!);
      }
      I[out] = sumI + this.taps[middle]! * this.historyI[start + middle]!;
      Q[out] = sumQ + this.taps[middle]! * this.historyQ[start + middle]!;
      out++;
    }
    return out;
  }
}
