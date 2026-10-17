import {
  getConvolver,
  type Convolver,
} from "@jtarrio/signals/wasm/convolver.js";
export const CHANNEL_MAX_SAMPLES = 32_768;

/** Same Blackman half-band response and retained phase as HalfBandStage, with
 * block convolution in WASM. Fixed buffers retain history; only retained output phases are evaluated.
 * ChannelCaptureFilter copies borrowed input before calling this stage. */
export class WasmHalfBandStage {
  private readonly iConvolver: Convolver = getConvolver();
  private readonly qConvolver: Convolver = getConvolver();
  private readonly workI: Float32Array;
  private readonly workQ: Float32Array;
  private parity = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private oscillatorCount = 0;
  private rotationI = 1;
  private rotationQ = 0;
  constructor(
    private offsetHz: number,
    private readonly rate: number,
    private readonly tapCount: number,
  ) {
    const taps = new Float32Array(tapCount);
    const middle = (tapCount - 1) / 2;
    let sum = 0;
    const precise = new Float64Array(tapCount);
    for (let n = 0; n < tapCount; n++) {
      const x = n - middle;
      const sinc =
        x === 0
          ? 0.5
          : x % 2 === 0
            ? 0
            : Math.sin((Math.PI * x) / 2) / (Math.PI * x);
      precise[n] =
        sinc *
        (0.42 -
          0.5 * Math.cos((2 * Math.PI * n) / (tapCount - 1)) +
          0.08 * Math.cos((4 * Math.PI * n) / (tapCount - 1)));
      sum += precise[n]!;
    }
    for (let n = 0; n < tapCount; n++) taps[n] = precise[n]! / sum;
    this.iConvolver.setCoefs(taps);
    this.qConvolver.setCoefs(taps);
    this.workI = new Float32Array(CHANNEL_MAX_SAMPLES + tapCount - 1);
    this.workQ = new Float32Array(this.workI.length);
    this.reset(offsetHz);
  }
  reset(offsetHz = this.offsetHz): void {
    if (!Number.isFinite(offsetHz) || Math.abs(offsetHz) >= this.rate / 2)
      throw new Error("Invalid wideband channel offset.");
    this.offsetHz = offsetHz;
    const angle = (-2 * Math.PI * offsetHz) / this.rate;
    this.rotationI = Math.cos(angle);
    this.rotationQ = Math.sin(angle);
    this.workI.fill(0);
    this.workQ.fill(0);
    this.parity = 0;
    this.oscillatorI = 1;
    this.oscillatorQ = 0;
    this.oscillatorCount = 0;
  }
  process(I: Float32Array, Q: Float32Array): number {
    if (I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES)
      throw new Error("Invalid wideband channel block size.");
    const history = this.tapCount - 1;
    this.workI.set(I, history);
    this.workQ.set(Q, history);
    if (this.offsetHz !== 0)
      for (let n = history; n < history + I.length; n++) {
        const i = this.workI[n]!,
          q = this.workQ[n]!;
        this.workI[n] = i * this.oscillatorI - q * this.oscillatorQ;
        this.workQ[n] = i * this.oscillatorQ + q * this.oscillatorI;
        const nextI =
          this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
        this.oscillatorQ =
          this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI;
        this.oscillatorI = nextI;
        if (++this.oscillatorCount === 4096) {
          const norm = Math.hypot(this.oscillatorI, this.oscillatorQ);
          this.oscillatorI /= norm;
          this.oscillatorQ /= norm;
          this.oscillatorCount = 0;
        }
      }
    const count = Math.floor((I.length + this.parity) / 2);
    const skip = this.parity === 0 ? 1 : 0;
    this.parity = (this.parity + I.length) % 2;
    if (count) {
      I.set(
        this.iConvolver.convolveWithStride(
          this.workI.subarray(0, history + I.length),
          count,
          2,
          skip,
        ),
      );
      Q.set(
        this.qConvolver.convolveWithStride(
          this.workQ.subarray(0, history + Q.length),
          count,
          2,
          skip,
        ),
      );
    }
    this.workI.copyWithin(0, I.length, I.length + history);
    this.workQ.copyWithin(0, Q.length, Q.length + history);
    return count;
  }
}
