import { RECORDING_CONVOLVER } from "./recordingConvolverBytes";
import { CHANNEL_MAX_SAMPLES, type FirConvolver } from "./wasmHalfBand";
import type { RecordingFir, RecordingKernels } from "./channelRecording";
import { IqFIRFilter } from "@jtarrio/signals/dsp/filters.js";

const module = new WebAssembly.Module(RECORDING_CONVOLVER);
const INPUT_OFFSET = 512;
const OUTPUT_OFFSET = 132096;
const MAX_TAPS = 95;

/** Private synchronous scratch per convolver. The returned view is borrowed
 * until the next call; I/Q use separate instances. No memory growth is allowed. */
export class RecordingConvolver implements FirConvolver {
  private readonly kernel: {
    memory: WebAssembly.Memory;
    convolve(taps: number, count: number): void;
    halfband(taps: number, count: number, skip: number): void;
  };
  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private taps = 0;
  private isHalfBand = false;
  constructor() {
    this.kernel = new WebAssembly.Instance(module)
      .exports as unknown as typeof this.kernel;
    this.input = new Float32Array(
      this.kernel.memory.buffer,
      INPUT_OFFSET,
      CHANNEL_MAX_SAMPLES + MAX_TAPS - 1,
    );
    this.output = new Float32Array(
      this.kernel.memory.buffer,
      OUTPUT_OFFSET,
      CHANNEL_MAX_SAMPLES,
    );
  }
  setCoefs(coefficients: Float32Array): void {
    if (
      !coefficients.length ||
      coefficients.length > MAX_TAPS ||
      coefficients.some(
        (value, index) =>
          !Number.isFinite(value) ||
          value !== coefficients[coefficients.length - 1 - index],
      )
    )
      throw new Error("Recording FIR requires finite symmetric coefficients.");
    new Float32Array(this.kernel.memory.buffer, 0, coefficients.length).set(
      coefficients,
    );
    this.taps = coefficients.length;
    this.isHalfBand =
      coefficients.length % 4 === 3 &&
      coefficients.every(
        (value, n) =>
          n % 2 === 0 || n === (coefficients.length - 1) / 2 || value === 0,
      );
  }
  convolveWithStride(
    data: Float32Array,
    count: number,
    stride: number,
    offset: number,
  ): Float32Array {
    if (
      !this.taps ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > CHANNEL_MAX_SAMPLES ||
      stride !== 1 ||
      offset !== 0 ||
      data.length !== count + this.taps - 1
    )
      throw new Error("Invalid bounded recording FIR input.");
    this.input.set(data);
    this.kernel.convolve(this.taps, count);
    return this.output.subarray(0, count);
  }
  halfBand(data: Float32Array, count: number, skip: number): Float32Array {
    const length = data.length - this.taps + 1;
    if (
      !this.isHalfBand ||
      length < 0 ||
      length > CHANNEL_MAX_SAMPLES ||
      (skip !== 0 && skip !== 1) ||
      count !== Math.floor((length + (skip === 0 ? 1 : 0)) / 2)
    )
      throw new Error("Invalid bounded recording half-band input.");
    this.input.set(data);
    this.kernel.halfband(this.taps, count, skip);
    return this.output.subarray(0, count);
  }
}

class RecordingIqFir implements RecordingFir {
  private readonly i = new RecordingConvolver();
  private readonly q = new RecordingConvolver();
  private readonly workI: Float32Array;
  private readonly workQ: Float32Array;
  constructor(private readonly coefficients: Float32Array) {
    this.i.setCoefs(coefficients);
    this.q.setCoefs(coefficients);
    this.workI = new Float32Array(
      CHANNEL_MAX_SAMPLES + coefficients.length - 1,
    );
    this.workQ = new Float32Array(this.workI.length);
  }
  clone(): RecordingFir {
    return new RecordingIqFir(this.coefficients);
  }
  inPlace(I: Float32Array, Q: Float32Array): void {
    if (I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES)
      throw new Error("Invalid recording FIR block.");
    const history = this.coefficients.length - 1;
    this.workI.set(I, history);
    this.workQ.set(Q, history);
    I.set(
      this.i.convolveWithStride(
        this.workI.subarray(0, I.length + history),
        I.length,
        1,
        0,
      ),
    );
    Q.set(
      this.q.convolveWithStride(
        this.workQ.subarray(0, Q.length + history),
        Q.length,
        1,
        0,
      ),
    );
    this.workI.copyWithin(0, I.length, I.length + history);
    this.workQ.copyWithin(0, Q.length, Q.length + history);
  }
}

// Only the recording worker opts in. Live DSP and borrowed synchronous capture
// keep the existing kernels, clocks, response, history and reset behavior.
export const recordingKernels: RecordingKernels = {
  convolver: () => new RecordingConvolver(),
  fir: (coefficients) => {
    if (
      !coefficients.length ||
      coefficients.length > MAX_TAPS ||
      coefficients.some((value) => !Number.isFinite(value))
    )
      throw new Error("Recording FIR requires bounded finite coefficients.");
    // Symmetric window calculations can straddle a Float32 rounding boundary.
    // Preserve every original coefficient with the general FIR in that case.
    return coefficients.every(
      (value, n) => value === coefficients[coefficients.length - 1 - n],
    )
      ? new RecordingIqFir(coefficients)
      : new IqFIRFilter(coefficients);
  },
};
