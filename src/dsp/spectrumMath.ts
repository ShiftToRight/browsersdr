export const FFT_SIZE = 4096;
export const SPECTRUM_FLOOR_DB = -120;

/** Hann coefficients using the symmetric N-1 definition. */
export function makeHannWindow(length: number): Float32Array {
  if (!Number.isInteger(length) || length < 2) throw new RangeError("Window length must be at least 2");
  const window = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
  }
  return window;
}

/** In-place, unscaled, forward radix-2 complex FFT. */
export function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const length = real.length;
  if (imag.length !== length || length < 2 || (length & (length - 1)) !== 0) {
    throw new RangeError("FFT inputs must have the same power-of-two length");
  }

  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      const realValue = real[index] ?? 0;
      const imagValue = imag[index] ?? 0;
      real[index] = real[reversed] ?? 0;
      imag[index] = imag[reversed] ?? 0;
      real[reversed] = realValue;
      imag[reversed] = imagValue;
    }
  }

  for (let size = 2; size <= length; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    const half = size >> 1;
    for (let offset = 0; offset < length; offset += size) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let index = 0; index < half; index += 1) {
        const even = offset + index;
        const odd = even + half;
        const oddReal = real[odd] ?? 0;
        const oddImag = imag[odd] ?? 0;
        const productReal = oddReal * twiddleReal - oddImag * twiddleImag;
        const productImag = oddReal * twiddleImag + oddImag * twiddleReal;
        const evenReal = real[even] ?? 0;
        const evenImag = imag[even] ?? 0;
        real[even] = evenReal + productReal;
        imag[even] = evenImag + productImag;
        real[odd] = evenReal - productReal;
        imag[odd] = evenImag - productImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

export class SpectrumAccumulator {
  readonly size: number;
  private readonly window: Float32Array;
  private readonly coherentGain: number;
  private readonly powerSum: Float64Array;
  private averagedWindows = 0;

  constructor(size = FFT_SIZE, private readonly windowsPerAverage = 4) {
    this.size = size;
    this.window = makeHannWindow(size);
    this.coherentGain = this.window.reduce((sum, value) => sum + value, 0);
    this.powerSum = new Float64Array(size);
  }

  reset(): void {
    this.powerSum.fill(0);
    this.averagedWindows = 0;
  }

  /** Returns one FFT-shifted relative-dB frame after enough linear-power averages. */
  addWindow(inputI: Float32Array, inputQ: Float32Array): Float32Array | undefined {
    if (inputI.length !== this.size || inputQ.length !== this.size) {
      throw new RangeError(`Expected ${this.size} complex samples`);
    }
    const real = new Float32Array(this.size);
    const imag = new Float32Array(this.size);
    for (let index = 0; index < this.size; index += 1) {
      const coefficient = this.window[index] ?? 0;
      real[index] = (inputI[index] ?? 0) * coefficient;
      imag[index] = (inputQ[index] ?? 0) * coefficient;
    }
    fftInPlace(real, imag);
    const normalization = this.coherentGain * this.coherentGain;
    for (let index = 0; index < this.size; index += 1) {
      const re = real[index] ?? 0;
      const im = imag[index] ?? 0;
      this.powerSum[index] = (this.powerSum[index] ?? 0) + (re * re + im * im) / normalization;
    }
    this.averagedWindows += 1;
    if (this.averagedWindows < this.windowsPerAverage) return undefined;

    const bins = new Float32Array(this.size);
    const half = this.size >> 1;
    for (let shifted = 0; shifted < this.size; shifted += 1) {
      const source = (shifted + half) % this.size;
      const meanPower = (this.powerSum[source] ?? 0) / this.averagedWindows;
      bins[shifted] = Math.max(SPECTRUM_FLOOR_DB, 10 * Math.log10(Math.max(meanPower, 1e-12)));
    }
    this.reset();
    return bins;
  }
}

