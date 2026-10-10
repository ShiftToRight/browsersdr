import { RDS_BIT_RATE, RDS_SUBCARRIER_HZ } from "./constants";

const TIMING_PHASES = 16;
export const RDS_BIT_PATHS = TIMING_PHASES * 2;

interface TimingPath {
  clock: number;
  i: number;
  q: number;
  previousI?: number;
  previousQ?: number;
  chips: number;
  encoded: [number | undefined, number | undefined];
}

/** Narrow, streaming multiplex front end. Fixed fractional timing hypotheses
 * avoid pulling a symbol clock on unfiltered audio/noise crossings. Both
 * biphase pairings make soft decisions; only the downstream CRC accepts data. */
export class RdsSymbolRecovery {
  private rate = 228_000;
  private decimation = 12;
  private samplesPerChip = 8;
  private kernel = new Float64Array(0);
  private historyI = new Float64Array(0);
  private historyQ = new Float64Array(0);
  private position = 0;
  private phase = 0;
  private decimationClock = 0;
  private sampleClock = 0;
  private carrierI = 0;
  private carrierQ = 0;
  private carrierAlpha = 0;
  private paths: TimingPath[] = [];

  constructor(private readonly emit: (path: number, bit: number, sample: number) => void) {
    this.configure(this.rate);
  }

  configure(rate: number): void {
    this.rate = rate;
    this.decimation = Math.max(1, Math.floor(rate / 19_000));
    this.samplesPerChip = rate / this.decimation / (RDS_BIT_RATE * 2);
    this.carrierAlpha = -Math.expm1(-this.decimation / rate / 0.05);
    // EN 50067 / NRSC-4 (1998), section 1.7: receiver shaping has
    // H(f) = cos(pi*f/(2*2375)) within +/-2375 Hz. Window its analytic
    // impulse response; decimate only after filtering the complex mixer.
    const taps = Math.min(2049, Math.ceil(rate * 0.0025) | 1);
    const cutoff = RDS_BIT_RATE * 2;
    this.kernel = new Float64Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const t = (n - (taps - 1) / 2) / rate;
      const v = 4 * cutoff * t;
      const response = Math.abs(1 - v * v) < 1e-9
        ? cutoff
        : 4 * cutoff / Math.PI * Math.cos(2 * Math.PI * cutoff * t) / (1 - v * v);
      this.kernel[n] = response * (0.54 - 0.46 * Math.cos(2 * Math.PI * n / (taps - 1)));
      sum += this.kernel[n]!;
    }
    for (let n = 0; n < taps; n++) this.kernel[n] = this.kernel[n]! / sum;
    // A doubled ring lets the FIR read a contiguous window without per-tap
    // remainder operations. All buffers and hypotheses have fixed bounds.
    this.historyI = new Float64Array(taps * 2);
    this.historyQ = new Float64Array(taps * 2);
    this.reset();
  }

  reset(): void {
    this.historyI.fill(0);
    this.historyQ.fill(0);
    this.position = this.phase = this.decimationClock = this.sampleClock = 0;
    this.carrierI = this.carrierQ = 0;
    this.paths = Array.from({ length: TIMING_PHASES }, (_, phase) => ({
      clock: phase / TIMING_PHASES * this.samplesPerChip,
      i: 0, q: 0, chips: 0, encoded: [undefined, undefined],
    }));
  }

  process(samples: Float32Array): void {
    const phaseStep = 2 * Math.PI * RDS_SUBCARRIER_HZ / this.rate;
    const taps = this.kernel.length;
    for (const sample of samples) {
      const mixedI = sample * Math.cos(this.phase);
      const mixedQ = -sample * Math.sin(this.phase);
      this.historyI[this.position] = this.historyI[this.position + taps] = mixedI;
      this.historyQ[this.position] = this.historyQ[this.position + taps] = mixedQ;
      this.position = (this.position + 1) % taps;
      this.phase = (this.phase + phaseStep) % (2 * Math.PI);
      this.sampleClock++;
      if (++this.decimationClock < this.decimation) continue;
      this.decimationClock = 0;
      let i = 0, q = 0;
      for (let n = 0; n < taps; n++) {
        const at = this.position + taps - 1 - n;
        i += this.kernel[n]! * this.historyI[at]!;
        q += this.kernel[n]! * this.historyQ[at]!;
      }
      // Squaring removes the BPSK sign. Follow the slowly rotating carrier
      // axis without mistaking mono/stereo content for timing transitions.
      this.carrierI += this.carrierAlpha * (i * i - q * q - this.carrierI);
      this.carrierQ += this.carrierAlpha * (2 * i * q - this.carrierQ);
      const angle = Math.atan2(this.carrierQ, this.carrierI) / 2;
      const referenceI = Math.cos(angle), referenceQ = Math.sin(angle);
      for (let index = 0; index < this.paths.length; index++) {
        const path = this.paths[index]!;
        path.i += i;
        path.q += q;
        if (++path.clock < this.samplesPerChip) continue;
        path.clock -= this.samplesPerChip;
        if (path.previousI !== undefined && path.previousQ !== undefined) {
          for (let pairing = 0; pairing < 2; pairing++) {
            if ((path.chips - pairing) % 2 !== 1) continue;
            const symbol = (path.previousI - path.i) * referenceI
              + (path.previousQ - path.q) * referenceQ;
            const encoded = symbol >= 0 ? 1 : 0;
            const previous = path.encoded[pairing];
            if (previous !== undefined) this.emit(index * 2 + pairing, encoded ^ previous, this.sampleClock);
            path.encoded[pairing] = encoded;
          }
        }
        path.previousI = path.i;
        path.previousQ = path.q;
        path.chips++;
        path.i = path.q = 0;
      }
    }
  }
}
