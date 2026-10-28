import { AIRSPY_RESAMPLER } from "./airspyResamplerBytes";

const module = new WebAssembly.Module(AIRSPY_RESAMPLER);
const MAX = 32768;
/** Exact rational clock, fixed scratch and bounded polyphase FIR. Padding is
 * zero, so SIMD changes accumulation rounding only, never the impulse response. */
export class AirspyResampler {
  private readonly kernel = new WebAssembly.Instance(module)
    .exports as unknown as {
    memory: WebAssembly.Memory;
    process(
      up: number,
      down: number,
      taps: number,
      count: number,
      skip: number,
    ): void;
  };
  private readonly inputI = new Float32Array(
    this.kernel.memory.buffer,
    262144,
    MAX + 128,
  );
  private readonly inputQ = new Float32Array(
    this.kernel.memory.buffer,
    524288,
    MAX + 128,
  );
  private readonly outputI = new Float32Array(
    this.kernel.memory.buffer,
    786432,
    MAX,
  );
  private readonly outputQ = new Float32Array(
    this.kernel.memory.buffer,
    917504,
    MAX,
  );
  private readonly history: number;
  private readonly taps: number;
  private residual = 0;
  constructor(
    private readonly up: number,
    private readonly down: number,
    coefficients: Float32Array,
  ) {
    const phaseLength = Math.ceil(coefficients.length / up);
    this.history = phaseLength - 1;
    this.taps = Math.ceil(phaseLength / 4) * 4;
    if (
      !Number.isInteger(up) ||
      up < 1 ||
      up > 512 ||
      !Number.isInteger(down) ||
      down < up ||
      this.taps > 128
    )
      throw new Error("Unsupported bounded Airspy rational filter.");
    const coefs = new Float32Array(
      this.kernel.memory.buffer,
      0,
      up * this.taps,
    );
    const padding = phaseLength * up - coefficients.length;
    for (let phase = 0; phase < up; phase++)
      for (let tap = 0; tap < phaseLength; tap++) {
        const index = (tap + 1) * up - phase - 1 - padding;
        coefs[phase * this.taps + tap] =
          index >= 0 ? coefficients[index]! * up : 0;
      }
  }
  process(I: Float32Array, Q: Float32Array): number {
    if (I.length !== Q.length || I.length > MAX)
      throw new Error("Invalid Airspy rational block.");
    this.inputI.set(I, this.history);
    this.inputQ.set(Q, this.history);
    // Tail padding must not retain samples from a preceding longer block.
    this.inputI.fill(0, this.history + I.length, this.history + I.length + 3);
    this.inputQ.fill(0, this.history + Q.length, this.history + Q.length + 3);
    const skip = (this.down - this.residual) % this.down;
    const middle = I.length * this.up;
    const count =
      Math.floor((this.residual + middle - 1) / this.down) -
      Math.floor((this.residual - 1) / this.down);
    this.kernel.process(this.up, this.down, this.taps, count, skip);
    this.residual = (this.residual + middle) % this.down;
    this.inputI.copyWithin(0, I.length, I.length + this.history);
    this.inputQ.copyWithin(0, Q.length, Q.length + this.history);
    I.set(this.outputI.subarray(0, count));
    Q.set(this.outputQ.subarray(0, count));
    return count;
  }
}
