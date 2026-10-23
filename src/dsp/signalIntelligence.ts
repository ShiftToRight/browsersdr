import { DemodWBFMStage1 } from "@jtarrio/signals/demod/demod-wbfm.js";
import { RdsDecoder, type RdsState } from "../rds/rdsDecoder";
import { SpectrumAccumulator } from "./spectrumMath";

export interface SignalProbeConfiguration {
  sampleRateHz: number;
  centerFrequencyHz: number;
  frequencyHz: number;
  bandwidthHz: number;
  seconds: number;
}
export interface SignalProbeResult {
  version: 1;
  status: "complete" | "inconclusive" | "interrupted";
  frequencyHz: number;
  measuredCenterHz?: number;
  measuredBandwidthHz?: number;
  resolutionHz: number;
  aboveNoiseDb?: number;
  sampledSeconds: number;
  firstSampleIndex?: number;
  lastSampleIndex?: number;
  discontinuities: number;
  pilotObserved: boolean;
  pilotFraction: number;
  rds: RdsState;
  stableProgrammeService: string | null;
  suggestedMode?: "WBFM";
  label: string;
  reasons: string[];
}

const SIZE = 16_384;
/** Streaming, bounded numerical measurement. No frequency allocations/catalog input. */
export class SignalIntelligenceProbe {
  private spectrum = new SpectrumAccumulator(SIZE, 4);
  private readonly i = new Float32Array(SIZE);
  private readonly q = new Float32Array(SIZE);
  private filled = 0;
  private spectra = 0;
  private power = new Float64Array(SIZE);
  private total = 0;
  private uninterrupted = 0;
  private firstSampleIndex?: number;
  private lastSampleIndex?: number;
  private expectedSample?: number;
  private discontinuities = 0;
  private demod?: DemodWBFMStage1;
  private readonly decoder: RdsDecoder;
  private readonly outputRate: number;
  private copyI = new Float32Array(0);
  private copyQ = new Float32Array(0);
  private pilotSamples = 0;
  private pilotWindows = 0;
  private lockedWindows = 0;
  private pilotPower = 0;
  private readonly goertzel = [19_000, 18_000, 20_000].map(() => [0, 0]);
  private readonly coefficients: number[];
  private pi: string | null = null;
  private piGroups = 0;
  private psMask = 0;
  private previousPs: string | null = null;
  private stablePs: string | null = null;
  private finished = false;
  get sampledSeconds(): number {
    return this.total / this.config.sampleRateHz;
  }

  constructor(readonly config: SignalProbeConfiguration) {
    const {
      sampleRateHz: rate,
      centerFrequencyHz,
      frequencyHz,
      bandwidthHz,
      seconds,
    } = config;
    if (
      ![rate, centerFrequencyHz, frequencyHz, bandwidthHz, seconds].every(
        Number.isFinite,
      ) ||
      rate < 256_000 ||
      rate > 20_000_000 ||
      bandwidthHz <= 0 ||
      seconds < 1 ||
      seconds > 30 ||
      Math.abs(frequencyHz - centerFrequencyHz) + bandwidthHz / 2 > rate * 0.375
    )
      throw new Error(
        "Signal analysis needs a complete candidate inside the usable capture and a 1–30 second budget.",
      );
    this.outputRate = Math.min(rate, 336_000);
    this.coefficients = [19_000, 18_000, 20_000].map(
      (f) => 2 * Math.cos((2 * Math.PI * f) / this.outputRate),
    );
    this.decoder = new RdsDecoder({
      onGroup: (words) => this.acceptGroup(words),
    });
    this.decoder.configure(this.outputRate);
    // Width only chooses a compatible probe, never its classification.
    if (
      bandwidthHz >= 40_000 &&
      bandwidthHz <= 350_000 &&
      Math.abs(frequencyHz - centerFrequencyHz) + 150_000 < rate * 0.45
    )
      this.demod = this.createDemod();
  }

  private createDemod() {
    return new DemodWBFMStage1(this.config.sampleRateHz, this.outputRate, {
      scheme: "WBFM",
      stereo: false,
    });
  }

  private acceptGroup(words: readonly number[]) {
    const state = this.decoder.getState();
    if (state.pi !== this.pi) {
      this.pi = state.pi;
      this.piGroups = 0;
      this.psMask = 0;
      this.previousPs = this.stablePs = null;
    }
    this.piGroups++;
    if (words[1]! >>> 12 !== 0) return;
    this.psMask |= 1 << (words[1]! & 3);
    if (this.psMask !== 15) return;
    this.psMask = 0;
    this.stablePs =
      state.programmeService && state.programmeService === this.previousPs
        ? state.programmeService
        : null;
    this.previousPs = state.programmeService;
  }

  accept(
    I: Float32Array,
    Q: Float32Array,
    start: number,
    discontinuity = false,
  ): boolean {
    if (this.finished) return true;
    if (I.length !== Q.length || !Number.isSafeInteger(start) || start < 0)
      throw new Error("Invalid probe sample range.");
    if (
      discontinuity ||
      (this.expectedSample !== undefined && start !== this.expectedSample)
    ) {
      this.discontinuities++;
      this.uninterrupted = 0;
      this.filled = 0;
      this.spectrum.reset();
      this.power.fill(0);
      this.spectra = 0;
      this.decoder.reset();
      this.pi = null;
      this.piGroups = this.psMask = 0;
      this.previousPs = this.stablePs = null;
      this.pilotSamples =
        this.pilotWindows =
        this.lockedWindows =
        this.pilotPower =
          0;
      this.goertzel.forEach((pair) => pair.fill(0));
      if (this.demod) this.demod = this.createDemod();
    }
    const count = Math.min(
      I.length,
      Math.max(
        0,
        Math.ceil(this.config.seconds * this.config.sampleRateHz) - this.total,
      ),
    );
    if (!count) {
      this.finished = true;
      return true;
    }
    this.firstSampleIndex ??= start;
    this.lastSampleIndex = start + count - 1;
    this.expectedSample = start + I.length;
    this.total += count;
    this.uninterrupted += count;
    // At most 16 four-window averages: memory/FFT work does not grow with dwell.
    if (this.spectra < 16)
      for (let n = 0; n < count && this.spectra < 16; n++) {
        this.i[this.filled] = I[n]!;
        this.q[this.filled++] = Q[n]!;
        if (this.filled !== SIZE) continue;
        this.filled = 0;
        const bins = this.spectrum.addWindow(this.i, this.q);
        if (bins) {
          this.spectra++;
          for (let k = 0; k < SIZE; k++)
            this.power[k] = this.power[k]! + 10 ** (bins[k]! / 10);
        }
      }
    if (this.demod) {
      if (this.copyI.length < count) {
        this.copyI = new Float32Array(count);
        this.copyQ = new Float32Array(count);
      }
      this.copyI.set(I.subarray(0, count));
      this.copyQ.set(Q.subarray(0, count));
      const mpx = this.demod.demodulate(
        this.copyI.subarray(0, count),
        this.copyQ.subarray(0, count),
        this.config.frequencyHz - this.config.centerFrequencyHz,
      ).left;
      this.decoder.process(mpx);
      this.acceptPilot(mpx);
    }
    const early =
      this.stablePs !== null &&
      this.uninterrupted >= this.config.sampleRateHz * 2;
    this.finished =
      early || this.total >= this.config.seconds * this.config.sampleRateHz;
    return this.finished;
  }

  private acceptPilot(samples: Float32Array) {
    const window = Math.round(this.outputRate / 100);
    for (const value of samples) {
      this.pilotPower += value * value;
      for (let k = 0; k < 3; k++) {
        const pair = this.goertzel[k]!;
        const next = value + this.coefficients[k]! * pair[0]! - pair[1]!;
        pair[1] = pair[0]!;
        pair[0] = next;
      }
      if (++this.pilotSamples !== window) continue;
      const powers = this.goertzel.map((pair, k) =>
        Math.max(
          0,
          pair[0]! ** 2 +
            pair[1]! ** 2 -
            this.coefficients[k]! * pair[0]! * pair[1]!,
        ),
      );
      const relative =
        (2 * powers[0]!) / Math.max(1e-15, window * this.pilotPower);
      if (
        relative > 0.002 &&
        powers[0]! > 10 * Math.max(1e-15, powers[1]!, powers[2]!)
      )
        this.lockedWindows++;
      this.pilotWindows++;
      this.pilotSamples = this.pilotPower = 0;
      this.goertzel.forEach((pair) => pair.fill(0));
    }
  }

  result(): SignalProbeResult {
    const resolutionHz = this.config.sampleRateHz / SIZE;
    const pilotFraction = this.lockedWindows / Math.max(1, this.pilotWindows);
    const pilotObserved = this.pilotWindows >= 100 && pilotFraction >= 0.8;
    const raw = this.decoder.getState();
    const rds =
      this.piGroups >= 2
        ? { ...raw, programmeService: this.stablePs }
        : { pi: null, programmeService: null, radioText: null, validGroups: 0 };
    const refined = this.refine();
    const signalPresent = (refined.aboveNoiseDb ?? -Infinity) >= 6;
    const decoded = signalPresent && !!rds.pi;
    const fm = signalPresent && (pilotObserved || decoded);
    const reasons = [
      this.spectra
        ? `Refined RF spectrum: ${resolutionHz.toFixed(1)} Hz bins, ${this.spectra * 4} FFT windows.`
        : "Insufficient contiguous samples for refined spectrum.",
    ];
    if (pilotObserved)
      reasons.push(
        "Stable 19 kHz pilot observed in the FM-demodulated multiplex.",
      );
    if (decoded)
      reasons.push(
        `${rds.validGroups} CRC/offset-validated RDS groups; repeated PI ${rds.pi}.`,
      );
    if (this.stablePs && decoded)
      reasons.push(
        "Transmitted PS name repeated across two complete four-segment cycles.",
      );
    if (!fm)
      reasons.push(
        this.demod
          ? "FM/RDS probe inconclusive; no type established. A quiet, mono or weak signal may need another visit."
          : "Measured signal retained; its width does not fit this broadcast-FM probe. Type unknown.",
      );
    if (!signalPresent)
      reasons.push(
        "No clear signal above the measured local floor during this analysis visit.",
      );
    if (this.discontinuities)
      reasons.push(
        `${this.discontinuities} input discontinuities; decoder and refinement reset at every gap.`,
      );
    return {
      version: 1,
      status: fm ? "complete" : "inconclusive",
      frequencyHz: this.config.frequencyHz,
      ...refined,
      resolutionHz,
      sampledSeconds: this.total / this.config.sampleRateHz,
      firstSampleIndex: this.firstSampleIndex,
      lastSampleIndex: this.lastSampleIndex,
      discontinuities: this.discontinuities,
      pilotObserved,
      pilotFraction,
      rds,
      stableProgrammeService: decoded ? this.stablePs : null,
      ...(fm ? { suggestedMode: "WBFM" as const } : {}),
      label: decoded
        ? this.stablePs
          ? `RDS: ${this.stablePs}`
          : `RDS decoded · PI ${rds.pi}`
        : fm
          ? "Broadcast FM likely"
          : "Unknown signal",
      reasons,
    };
  }

  private refine(): {
    measuredCenterHz?: number;
    measuredBandwidthHz?: number;
    aboveNoiseDb?: number;
  } {
    if (!this.spectra) return {};
    const step = this.config.sampleRateHz / SIZE;
    const center =
      (this.config.frequencyHz - this.config.centerFrequencyHz) / step +
      SIZE / 2;
    const half = Math.max(
      4,
      Math.min(SIZE * 0.15, (this.config.bandwidthHz / step) * 0.75),
    );
    const lo = Math.max(1, Math.floor(center - half)),
      hi = Math.min(SIZE - 2, Math.ceil(center + half));
    const floorValues: number[] = [];
    for (
      let k = Math.max(0, lo - Math.ceil(half));
      k <= Math.min(SIZE - 1, hi + Math.ceil(half));
      k++
    )
      if (k < lo || k > hi) floorValues.push(this.power[k]! / this.spectra);
    floorValues.sort((a, b) => a - b);
    const floor = Math.max(
      1e-12,
      floorValues[Math.floor(floorValues.length / 2)] ?? 1e-12,
    );
    let peak = lo;
    for (let k = lo; k <= hi; k++)
      if (this.power[k]! > this.power[peak]!) peak = k;
    const aboveNoiseDb =
      10 *
      Math.log10(Math.max(1e-12, this.power[peak]! / this.spectra) / floor);
    // Report supported extent only. Association with adjacent emissions remains provisional.
    let left = peak,
      right = peak;
    const threshold = floor * 4 * this.spectra;
    for (let k = lo; k <= hi; k++)
      if (this.power[k]! >= threshold) {
        left = Math.min(left, k);
        right = Math.max(right, k);
      }
    return {
      aboveNoiseDb,
      measuredCenterHz:
        this.config.centerFrequencyHz + ((left + right) / 2 - SIZE / 2) * step,
      measuredBandwidthHz: (right - left + 1) * step,
    };
  }
}
