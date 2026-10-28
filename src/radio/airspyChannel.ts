import { AirspyResampler } from "./airspyResampler";
import { airspyChannelRate, isAirspyRate } from "./airspySettings";
import { WasmHalfBandStage } from "./wasmHalfBand";
import { RecordingConvolver } from "./recordingConvolver";
/** Bounded rational FIR for Airspy's native clocks. Runs in the channel worker.
 * Never relabel 10 MHz as 9.6 MHz or discard samples to satisfy a decoder clock. */
export class AirspyChannelFilter {
  private resampler!: AirspyResampler;
  private offset = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private rotationI = 1;
  private rotationQ = 0;
  private count = 0;
  private readonly stages: WasmHalfBandStage[] = [];
  private resamplerRate: number;
  constructor(private readonly rate: number) {
    if (!isAirspyRate(rate))
      throw new Error("Unsupported Airspy output clock.");
    const output = airspyChannelRate(rate);
    this.resamplerRate = rate;
    while (this.resamplerRate >= output * 2) {
      this.stages.push(
        new WasmHalfBandStage(
          0,
          this.resamplerRate,
          this.resamplerRate >= output * 4 ? 31 : 95,
          true,
          () => new RecordingConvolver(),
        ),
      );
      this.resamplerRate /= 2;
    }
    this.reset(0);
  }
  reset(offset: number): void {
    if (!Number.isFinite(offset) || Math.abs(offset) >= this.rate / 2)
      throw new Error("Invalid Airspy channel offset.");
    const output = airspyChannelRate(this.rate);
    let gcd = this.resamplerRate,
      remainder = output;
    while (remainder) {
      const next = gcd % remainder;
      gcd = remainder;
      remainder = next;
    }
    const intermediate = this.resamplerRate * (output / gcd);
    let length = 63 * (this.resamplerRate / gcd);
    length += (length + 1) % 2;
    const kernel = new Float32Array(length);
    const cutoff = Math.min(output * 0.45, this.rate * 0.45) / intermediate;
    let sum = 0;
    for (let n = 0; n < length; n++) {
      const x = n - (length - 1) / 2;
      const sinc =
        x === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      kernel[n] =
        sinc *
        (0.42 -
          0.5 * Math.cos((2 * Math.PI * n) / (length - 1)) +
          0.08 * Math.cos((4 * Math.PI * n) / (length - 1)));
      sum += kernel[n]!;
    }
    for (let n = 0; n < length; n++) kernel[n] = kernel[n]! / sum;
    this.resampler = new AirspyResampler(
      output / gcd,
      this.resamplerRate / gcd,
      kernel,
    );
    for (const stage of this.stages) stage.reset(0);
    this.oscillatorI = 1;
    this.oscillatorQ = 0;
    this.count = 0;
    this.offset = offset;
    this.rotationI = Math.cos((-2 * Math.PI * offset) / this.rate);
    this.rotationQ = Math.sin((-2 * Math.PI * offset) / this.rate);
  }
  process(I: Float32Array, Q: Float32Array): number {
    if (this.offset !== 0)
      for (let n = 0; n < I.length; n++) {
        const i = I[n]!,
          q = Q[n]!;
        I[n] = i * this.oscillatorI - q * this.oscillatorQ;
        Q[n] = i * this.oscillatorQ + q * this.oscillatorI;
        const next =
          this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
        this.oscillatorQ =
          this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI;
        this.oscillatorI = next;
        if (++this.count % 4096 === 0) {
          const norm = Math.hypot(this.oscillatorI, this.oscillatorQ);
          this.oscillatorI /= norm;
          this.oscillatorQ /= norm;
        }
      }
    let count = I.length;
    for (const stage of this.stages)
      count = stage.process(I.subarray(0, count), Q.subarray(0, count));
    return this.resampler.process(I.subarray(0, count), Q.subarray(0, count));
  }
}
