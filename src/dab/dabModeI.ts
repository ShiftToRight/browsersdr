import { FFT } from "@jtarrio/signals/dsp/fft.js";
import {
  getRealResampler,
  type RealResampler,
} from "@jtarrio/signals/dsp/resamplers.js";
import {
  DabFicDatabase,
  DabMscSubchannelDecoder,
  decodeFicGroup,
  type DabAudioService,
  type DabStation,
  type DabLabel,
  type DabSubchannel,
} from "./dabChannelCoding";

export const DAB_MODE_I_RATE = 2_048_000;
export const DAB_MODE_I_NULL = 2_656;
export const DAB_MODE_I_SYMBOL = 2_552;
export const DAB_MODE_I_GUARD = 504;
export const DAB_MODE_I_FFT = 2_048;
export const DAB_MODE_I_CARRIERS = 1_536;
export const DAB_MODE_I_SYMBOLS = 76;
export const DAB_MODE_I_FRAME_BODY = DAB_MODE_I_SYMBOL * DAB_MODE_I_SYMBOLS;
const DAB_TIMING_MARGIN = 512;
const DAB_TRACKING_RADIUS = 40;
const DAB_TIMING_SYMBOLS = [0, 1, 2, 3, 8, 16, 24, 32, 40, 48, 56, 64, 72];

export interface DabModeIStatus {
  state: "searching" | "fic" | "service";
  frameIntervalSamples?: number;
  missedFrames?: number;
  processingMs?: number;
  maxProcessingMs?: number;
  ficBlocks: number;
  ficAttempts: number;
  ficFrames: number;
  ficFramesWithAny: number;
  ficCompleteFrames: number;
  ficSuccessHistogram: readonly number[];
  ficGroupBlocks: readonly number[];
  logicalFrames: number;
  fineFrequencyCorrectionHz: number;
  coarseCarrierOffsetHz: number;
  coarseCarrierLocked: boolean;
  timingStartSamples: number;
  quadraturePolarity: "standard" | "reversed";
  stations?: DabStation[];
  ensemble?: DabLabel & { id: number };
  service?: DabAudioService;
  subchannel?: DabSubchannel;
  message: string;
}

interface PrsEntry {
  min: number;
  max: number;
  i: number;
  n: number;
}

const PRS_ENTRY_VALUES: readonly (readonly [number, number, number, number])[] =
  [
    [-768, -737, 0, 1],
    [-736, -705, 1, 2],
    [-704, -673, 2, 0],
    [-672, -641, 3, 1],
    [-640, -609, 0, 3],
    [-608, -577, 1, 2],
    [-576, -545, 2, 2],
    [-544, -513, 3, 3],
    [-512, -481, 0, 2],
    [-480, -449, 1, 1],
    [-448, -417, 2, 2],
    [-416, -385, 3, 3],
    [-384, -353, 0, 1],
    [-352, -321, 1, 2],
    [-320, -289, 2, 3],
    [-288, -257, 3, 3],
    [-256, -225, 0, 2],
    [-224, -193, 1, 2],
    [-192, -161, 2, 2],
    [-160, -129, 3, 1],
    [-128, -97, 0, 1],
    [-96, -65, 1, 3],
    [-64, -33, 2, 1],
    [-32, -1, 3, 2],
    [1, 32, 0, 3],
    [33, 64, 3, 1],
    [65, 96, 2, 1],
    [97, 128, 1, 1],
    [129, 160, 0, 2],
    [161, 192, 3, 2],
    [193, 224, 2, 1],
    [225, 256, 1, 0],
    [257, 288, 0, 2],
    [289, 320, 3, 2],
    [321, 352, 2, 3],
    [353, 384, 1, 3],
    [385, 416, 0, 0],
    [417, 448, 3, 2],
    [449, 480, 2, 1],
    [481, 512, 1, 3],
    [513, 544, 0, 3],
    [545, 576, 3, 3],
    [577, 608, 2, 3],
    [609, 640, 1, 0],
    [641, 672, 0, 3],
    [673, 704, 3, 0],
    [705, 736, 2, 1],
    [737, 768, 1, 1],
  ];
const PRS_ENTRIES: readonly PrsEntry[] = PRS_ENTRY_VALUES.map(
  ([min, max, i, n]) => ({ min, max, i, n }),
);

const H = [
  [
    0, 2, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0, 2, 2, 1, 1, 0, 2, 0, 0, 0, 0, 1, 1, 2,
    0, 0, 0, 2, 2, 1, 1,
  ],
  [
    0, 3, 2, 3, 0, 1, 3, 0, 2, 1, 2, 3, 2, 3, 3, 0, 0, 3, 2, 3, 0, 1, 3, 0, 2,
    1, 2, 3, 2, 3, 3, 0,
  ],
  [
    0, 0, 0, 2, 0, 2, 1, 3, 2, 2, 0, 2, 2, 0, 1, 3, 0, 0, 0, 2, 0, 2, 1, 3, 2,
    2, 0, 2, 2, 0, 1, 3,
  ],
  [
    0, 1, 2, 1, 0, 3, 3, 2, 2, 3, 2, 1, 2, 1, 3, 2, 0, 1, 2, 1, 0, 3, 3, 2, 2,
    3, 2, 1, 2, 1, 3, 2,
  ],
] as const;

export function createDabPrsReference(): [Float32Array, Float32Array] {
  const real = new Float32Array(DAB_MODE_I_FFT),
    imag = new Float32Array(DAB_MODE_I_FFT);
  for (const entry of PRS_ENTRIES) {
    for (let carrier = entry.min; carrier <= entry.max; carrier += 1) {
      if (carrier === 0) continue;
      const phase =
        (Math.PI / 2) * (H[entry.i]![carrier - entry.min]! + entry.n);
      const bin = (DAB_MODE_I_FFT + carrier) % DAB_MODE_I_FFT;
      real[bin] = Math.cos(phase);
      imag[bin] = Math.sin(phase);
    }
  }
  return [real, imag];
}

export function createDabCarrierMap(): Uint16Array {
  const permutation = new Uint16Array(DAB_MODE_I_FFT),
    result = new Uint16Array(DAB_MODE_I_CARRIERS);
  for (let index = 1; index < permutation.length; index += 1)
    permutation[index] = (13 * permutation[index - 1]! + 511) % 2048;
  let output = 0;
  for (const value of permutation) {
    if (value < 256 || value > 1792 || value === 1024) continue;
    result[output++] = value < 1024 ? value - 256 : value - 257;
  }
  if (output !== result.length)
    throw new Error("Invalid DAB carrier permutation.");
  return result;
}

const CARRIER_MAP = createDabCarrierMap();
const PRS = createDabPrsReference();

function findCoarseCarrierOffset(
  real: Float32Array,
  imag: Float32Array,
): number {
  let bestShift = 0,
    bestScore = Number.NEGATIVE_INFINITY;
  for (let shift = -24; shift <= 24; shift += 1) {
    let sumI = 0,
      sumQ = 0;
    for (let carrier = -767; carrier < 768; carrier += 1) {
      if (carrier === -1 || carrier === 0) continue;
      const first = (DAB_MODE_I_FFT + carrier + shift) % DAB_MODE_I_FFT,
        second = (DAB_MODE_I_FFT + carrier + 1 + shift) % DAB_MODE_I_FFT,
        refFirst = (DAB_MODE_I_FFT + carrier) % DAB_MODE_I_FFT,
        refSecond = (DAB_MODE_I_FFT + carrier + 1) % DAB_MODE_I_FFT;
      const receivedI =
        real[first]! * real[second]! + imag[first]! * imag[second]!;
      const receivedQ =
        real[first]! * imag[second]! - imag[first]! * real[second]!;
      const referenceI =
        PRS[0][refFirst]! * PRS[0][refSecond]! +
        PRS[1][refFirst]! * PRS[1][refSecond]!;
      const referenceQ =
        PRS[0][refFirst]! * PRS[1][refSecond]! -
        PRS[1][refFirst]! * PRS[0][refSecond]!;
      sumI += receivedI * referenceI + receivedQ * referenceQ;
      sumQ += receivedQ * referenceI - receivedI * referenceQ;
    }
    const score = sumI * sumI + sumQ * sumQ;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  return bestShift;
}

export function demapDabDqpsk(
  previousReal: Float32Array,
  previousImag: Float32Array,
  currentReal: Float32Array,
  currentImag: Float32Array,
  coarseOffset = 0,
): Int8Array {
  const physicalI = new Float32Array(DAB_MODE_I_CARRIERS),
    physicalQ = new Float32Array(DAB_MODE_I_CARRIERS);
  // Moving FFT bins removes integer CFO within a symbol, but its cyclic
  // prefix still advances carrier phase between symbols. Remove that known
  // rotation before the fourth-power estimator (which is ambiguous by pi/2).
  const coarsePhase =
    (-2 * Math.PI * coarseOffset * DAB_MODE_I_SYMBOL) / DAB_MODE_I_FFT;
  const coarseCos = Math.cos(coarsePhase),
    coarseSin = Math.sin(coarsePhase);
  let phaseFourthI = 0,
    phaseFourthQ = 0;
  for (let carrier = -768, physical = 0; carrier <= 768; carrier += 1) {
    if (carrier === 0) continue;
    const bin = (DAB_MODE_I_FFT + carrier + coarseOffset) % DAB_MODE_I_FFT;
    const differentialI =
      currentReal[bin]! * previousReal[bin]! +
      currentImag[bin]! * previousImag[bin]!;
    const differentialQ =
      currentImag[bin]! * previousReal[bin]! -
      currentReal[bin]! * previousImag[bin]!;
    physicalI[physical] = differentialI * coarseCos - differentialQ * coarseSin;
    physicalQ[physical] = differentialI * coarseSin + differentialQ * coarseCos;
    const i = physicalI[physical]!,
      q = physicalQ[physical]!,
      power = i * i + q * q;
    if (power > 1e-20) {
      // DAB differential QPSK points have phases ±pi/4 and ±3pi/4, so their
      // fourth powers all point at pi. Negating and averaging the normalized
      // fourth powers reveals the residual common rotation without knowing
      // any payload bits. This removes per-symbol fine-CFO/clock phase that a
      // single frame-wide cyclic-prefix estimate cannot eliminate.
      const squareI = i * i - q * q,
        squareQ = 2 * i * q,
        fourthI = squareI * squareI - squareQ * squareQ,
        fourthQ = 2 * squareI * squareQ,
        // A fourth-power phasor has magnitude power squared. Divide by one
        // power so strong carriers vote in proportion to their reliability;
        // unit-normalizing here lets noise in deep multipath notches rotate a
        // complete OFDM symbol.
        weightDenominator = power;
      phaseFourthI -= fourthI / weightDenominator;
      phaseFourthQ -= fourthQ / weightDenominator;
    }
    physical += 1;
  }
  const phaseCorrection = -Math.atan2(phaseFourthQ, phaseFourthI) / 4,
    phaseCosine = Math.cos(phaseCorrection),
    phaseSine = Math.sin(phaseCorrection);
  for (let index = 0; index < DAB_MODE_I_CARRIERS; index += 1) {
    const i = physicalI[index]!,
      q = physicalQ[index]!;
    physicalI[index] = i * phaseCosine - q * phaseSine;
    physicalQ[index] = i * phaseSine + q * phaseCosine;
  }
  const output = new Int8Array(DAB_MODE_I_CARRIERS * 2);
  let metricPower = 0;
  for (let index = 0; index < DAB_MODE_I_CARRIERS; index += 1) {
    const i = physicalI[index]!,
      q = physicalQ[index]!;
    metricPower += i * i + q * q;
  }
  const metricScale = Math.max(
    Math.sqrt(metricPower / (DAB_MODE_I_CARRIERS * 2)),
    1e-12,
  );
  for (let index = 0; index < DAB_MODE_I_CARRIERS; index += 1) {
    const physical = CARRIER_MAP[index]!,
      i = physicalI[physical]!,
      q = physicalQ[physical]!;
    output[index] = Math.max(
      -127,
      Math.min(127, Math.round((-127 * i) / metricScale)),
    );
    // EN 300 401 clause 14.5 maps p[n+K] to (1 - 2p[n+K])j.
    // A positive soft metric means bit 1 to the Viterbi decoder, hence the
    // quadrature metric has the same leading minus sign as the real metric.
    output[index + DAB_MODE_I_CARRIERS] = Math.max(
      -127,
      Math.min(127, Math.round((-127 * q) / metricScale)),
    );
  }
  return output;
}

/** Locate the beginning of the first cyclic prefix in a frame capture.
 *
 * Energy-envelope acquisition intentionally tolerates short RF impulses, but
 * that filtering also makes its rising edge several samples late.  A cyclic
 * prefix is an exact copy of the end of its OFDM symbol, so normalized prefix
 * correlation gives us a signal-derived boundary without relying on a fixed
 * receiver/filter delay. */
export function findDabModeITimingStart(
  frameI: Float32Array,
  frameQ: Float32Array,
  maximum = DAB_TIMING_MARGIN,
  minimum = 0,
): number {
  const limit = Math.min(
    maximum,
    frameI.length - DAB_MODE_I_FRAME_BODY,
    frameQ.length - DAB_MODE_I_FRAME_BODY,
  );
  if (limit <= 0) return 0;
  const lower = Math.max(0, Math.min(minimum, limit));
  // Sliding sums evaluate every sample boundary in O(symbols * (guard +
  // margin)), instead of rescanning a full prefix for every candidate.
  const real = new Float64Array(limit + 1),
    imag = new Float64Array(limit + 1),
    prefix = new Float64Array(limit + 1),
    tail = new Float64Array(limit + 1);
  for (const symbol of DAB_TIMING_SYMBOLS) {
    const base = symbol * DAB_MODE_I_SYMBOL;
    let ri = 0,
      rq = 0,
      pp = 0,
      tp = 0;
    const add = (index: number, sign: number) => {
      const p = base + index,
        t = p + DAB_MODE_I_FFT;
      const pi = frameI[p]!,
        pq = frameQ[p]!,
        ti = frameI[t]!,
        tq = frameQ[t]!;
      ri += sign * (ti * pi + tq * pq);
      rq += sign * (ti * pq - tq * pi);
      pp += sign * (pi * pi + pq * pq);
      tp += sign * (ti * ti + tq * tq);
    };
    for (let index = lower; index < lower + DAB_MODE_I_GUARD; index += 1)
      add(index, 1);
    for (let candidate = lower; candidate <= limit; candidate += 1) {
      real[candidate] = real[candidate]! + ri;
      imag[candidate] = imag[candidate]! + rq;
      prefix[candidate] = prefix[candidate]! + pp;
      tail[candidate] = tail[candidate]! + tp;
      if (candidate < limit) {
        add(candidate, -1);
        add(candidate + DAB_MODE_I_GUARD, 1);
      }
    }
  }
  let best = lower,
    bestScore = Number.NEGATIVE_INFINITY;
  for (let candidate = lower; candidate <= limit; candidate += 1) {
    const value =
      (real[candidate]! ** 2 + imag[candidate]! ** 2) /
      Math.max(prefix[candidate]! * tail[candidate]!, 1e-24);
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return best;
}

/** Streaming Mode-I ensemble decoder. Intended to run in a dedicated Worker. */
export class DabModeIProcessor {
  private sampleRateHz = 2_400_000;
  private sampleIndex = 0;
  private previousFrameStart?: number;
  private frameIntervalSamples = 0;
  private missedFrames = 0;
  private processingMs = 0;
  private maxProcessingMs = 0;
  private consecutiveBadFrames = 0;
  private resamplerI!: RealResampler;
  private resamplerQ!: RealResampler;
  private readonly fft = FFT.ofLength(DAB_MODE_I_FFT);
  private readonly frameI = new Float32Array(
    DAB_MODE_I_FRAME_BODY + DAB_TIMING_MARGIN,
  );
  private readonly frameQ = new Float32Array(
    DAB_MODE_I_FRAME_BODY + DAB_TIMING_MARGIN,
  );
  private readonly historyI = new Float32Array(DAB_TIMING_MARGIN);
  private readonly historyQ = new Float32Array(DAB_TIMING_MARGIN);
  private historyOffset = 0;
  private historySamples = 0;
  private frameOffset = 0;
  private capturing = false;
  private nullSamplesRemaining = 0;
  private timingHint?: number;
  private averagePower = 0;
  private powerEnvelope = 0;
  private averageSamples = 0;
  private lowSamples = 0;
  private ficBlocks = 0;
  private ficAttempts = 0;
  private ficFrames = 0;
  private ficFramesWithAny = 0;
  private ficCompleteFrames = 0;
  private readonly ficSuccessHistogram = new Array<number>(13).fill(0);
  private readonly ficGroupBlocks = new Array<number>(4).fill(0);
  private logicalFrames = 0;
  private fineFrequencyCorrectionHz = 0;
  private coarseCarrierOffsetHz = 0;
  private lockedCoarseOffset?: number;
  private timingStartSamples = 0;
  private readonly fic = new DabFicDatabase();
  private msc?: DabMscSubchannelDecoder;
  private selectedKey?: string;
  private stationKey?: string;
  private quadraturePolarity?: -1 | 1;

  constructor(
    private readonly onLogicalFrame: (frame: Uint8Array) => void,
    private readonly onStatus: (status: DabModeIStatus) => void = () =>
      undefined,
    private readonly onProgrammeChange: () => void = () => undefined,
  ) {
    this.configureResampler();
  }

  setSampleRate(sampleRateHz: number): void {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz < DAB_MODE_I_RATE)
      throw new Error("DAB Mode I requires at least 2.048 MS/s.");
    if (sampleRateHz === this.sampleRateHz) return;
    this.sampleRateHz = sampleRateHz;
    this.configureResampler();
    this.reset();
  }

  selectService(key: string): void {
    if (!this.fic.selectedDabPlusService(key) || key === this.stationKey)
      return;
    this.stationKey = key;
    this.updateSelectedService();
    this.publishStatus();
  }

  private updateSelectedService(): void {
    const selected = this.fic.selectedDabPlusService(this.stationKey);
    if (!selected) return;
    this.stationKey = `${selected.service.serviceId}:${selected.subchannel.id}`;
    const key = `${this.stationKey}:${selected.subchannel.startAddress}:${selected.subchannel.length}:${selected.subchannel.eepType}:${selected.subchannel.protectionLevel}`;
    if (key !== this.selectedKey) {
      this.msc = new DabMscSubchannelDecoder(selected.subchannel);
      this.selectedKey = key;
      this.logicalFrames = 0;
      this.onProgrammeChange();
    }
  }

  push(inputI: Float32Array, inputQ: Float32Array): void {
    if (inputI.length !== inputQ.length)
      throw new Error("DAB I/Q lengths differ.");
    const I =
        this.sampleRateHz === DAB_MODE_I_RATE
          ? inputI
          : this.resamplerI.resample(inputI),
      Q =
        this.sampleRateHz === DAB_MODE_I_RATE
          ? inputQ
          : this.resamplerQ.resample(inputQ);
    const length = Math.min(I.length, Q.length);
    for (let index = 0; index < length; index += 1)
      this.consume(I[index]!, Q[index]!);
  }

  reset(): void {
    this.sampleIndex = 0;
    this.previousFrameStart = undefined;
    this.frameIntervalSamples = 0;
    this.missedFrames = 0;
    this.processingMs = 0;
    this.maxProcessingMs = 0;
    this.consecutiveBadFrames = 0;
    this.frameOffset = 0;
    this.historyOffset = 0;
    this.historySamples = 0;
    this.capturing = false;
    this.nullSamplesRemaining = 0;
    this.timingHint = undefined;
    this.averagePower = 0;
    this.powerEnvelope = 0;
    this.averageSamples = 0;
    this.lowSamples = 0;
    this.ficBlocks = 0;
    this.ficAttempts = 0;
    this.ficFrames = 0;
    this.ficFramesWithAny = 0;
    this.ficCompleteFrames = 0;
    this.ficSuccessHistogram.fill(0);
    this.ficGroupBlocks.fill(0);
    this.logicalFrames = 0;
    this.fineFrequencyCorrectionHz = 0;
    this.coarseCarrierOffsetHz = 0;
    this.lockedCoarseOffset = undefined;
    this.timingStartSamples = 0;
    this.fic.reset();
    this.msc = undefined;
    this.selectedKey = undefined;
    this.stationKey = undefined;
    this.quadraturePolarity = undefined;
    this.configureResampler();
    this.onStatus({
      state: "searching",
      ficBlocks: 0,
      ficAttempts: 0,
      ficFrames: 0,
      ficFramesWithAny: 0,
      ficCompleteFrames: 0,
      ficSuccessHistogram: this.ficSuccessHistogram.slice(),
      ficGroupBlocks: this.ficGroupBlocks.slice(),
      logicalFrames: 0,
      fineFrequencyCorrectionHz: 0,
      coarseCarrierOffsetHz: 0,
      coarseCarrierLocked: false,
      timingStartSamples: 0,
      quadraturePolarity: "standard",
      message: "Searching for a complete DAB Mode-I transmission frame…",
    });
  }

  private configureResampler(): void {
    this.resamplerI = getRealResampler(this.sampleRateHz, DAB_MODE_I_RATE);
    this.resamplerQ = this.resamplerI.clone();
  }

  private consume(i: number, q: number): void {
    this.sampleIndex += 1;
    if (this.nullSamplesRemaining > 0) {
      this.nullSamplesRemaining -= 1;
      if (this.nullSamplesRemaining === 0) {
        this.capturing = true;
        this.frameOffset = 0;
      }
      return;
    }
    if (this.capturing) {
      this.frameI[this.frameOffset] = i;
      this.frameQ[this.frameOffset] = q;
      this.frameOffset += 1;
      if (this.frameOffset === this.frameI.length) {
        const started = performance.now();
        const timing = this.processFrame();
        this.processingMs = performance.now() - started;
        this.maxProcessingMs = Math.max(
          this.maxProcessingMs,
          this.processingMs,
        );
        this.publishStatus();
        this.capturing = false;
        this.frameOffset = 0;
        this.lowSamples = 0;
        if (
          this.lockedCoarseOffset !== undefined &&
          this.consecutiveBadFrames < 3
        ) {
          // The capture starts before the PRS prefix and is body+margin long.
          // Move the next capture by exactly one frame, adjusted only by the
          // measured timing error so its PRS sits in the middle of the margin.
          // Do not add the full timing offset on every frame: that drifts.
          this.nullSamplesRemaining =
            DAB_MODE_I_NULL -
            DAB_TIMING_MARGIN +
            timing -
            DAB_TIMING_MARGIN / 2;
          this.timingHint = DAB_TIMING_MARGIN / 2;
        } else {
          this.nullSamplesRemaining = 0;
          this.timingHint = undefined;
          this.msc?.reset();
          // AGC may have moved the noise/signal levels during the capture.
          this.averageSamples = 0;
        }
      }
      return;
    }
    const power = i * i + q * q;
    if (this.averageSamples < 8_192) {
      this.averagePower +=
        (power - this.averagePower) / (this.averageSamples + 1);
      this.powerEnvelope +=
        (power - this.powerEnvelope) / Math.min(this.averageSamples + 1, 64);
      this.averageSamples += 1;
      this.remember(i, q);
      return;
    }
    // A DAB null symbol is an energy interval, not a promise that every noisy
    // complex sample is below a threshold. A short moving envelope tolerates
    // RF/USB impulses while retaining far more timing precision than the
    // 504-sample cyclic prefix requires.
    this.powerEnvelope += (power - this.powerEnvelope) / 64;
    if (this.powerEnvelope < Math.max(1e-12, this.averagePower * 0.35)) {
      this.lowSamples += 1;
      this.remember(i, q);
      return;
    }
    if (this.lowSamples >= 1_800 && this.lowSamples <= 3_500) {
      this.capturing = true;
      this.timingHint = undefined;
      const available = Math.min(this.historySamples, DAB_TIMING_MARGIN);
      const padding = DAB_TIMING_MARGIN - available;
      this.frameI.fill(0, 0, padding);
      this.frameQ.fill(0, 0, padding);
      for (let index = 0; index < available; index += 1) {
        const source =
          (this.historyOffset - available + index + DAB_TIMING_MARGIN) %
          DAB_TIMING_MARGIN;
        this.frameI[padding + index] = this.historyI[source]!;
        this.frameQ[padding + index] = this.historyQ[source]!;
      }
      this.frameI[DAB_TIMING_MARGIN] = i;
      this.frameQ[DAB_TIMING_MARGIN] = q;
      this.frameOffset = DAB_TIMING_MARGIN + 1;
    } else {
      this.averagePower += 0.00002 * (this.powerEnvelope - this.averagePower);
      this.remember(i, q);
    }
    this.lowSamples = 0;
  }

  private remember(i: number, q: number): void {
    this.historyI[this.historyOffset] = i;
    this.historyQ[this.historyOffset] = q;
    this.historyOffset = (this.historyOffset + 1) % DAB_TIMING_MARGIN;
    this.historySamples += 1;
  }

  private processFrame(): number {
    const timingStart = findDabModeITimingStart(
      this.frameI,
      this.frameQ,
      this.timingHint === undefined
        ? DAB_TIMING_MARGIN
        : Math.min(DAB_TIMING_MARGIN, this.timingHint + DAB_TRACKING_RADIUS),
      this.timingHint === undefined
        ? 0
        : Math.max(0, this.timingHint - DAB_TRACKING_RADIUS),
    );
    const frameStart = this.sampleIndex - this.frameI.length + 1 + timingStart;
    if (this.previousFrameStart !== undefined) {
      this.frameIntervalSamples = frameStart - this.previousFrameStart;
      this.missedFrames += Math.max(
        0,
        Math.round(this.frameIntervalSamples / 196_608) - 1,
      );
    }
    this.previousFrameStart = frameStart;
    let correlationI = 0,
      correlationQ = 0;
    for (let symbol = 0; symbol < DAB_MODE_I_SYMBOLS; symbol += 1) {
      const start = timingStart + symbol * DAB_MODE_I_SYMBOL;
      for (let index = 0; index < DAB_MODE_I_GUARD; index += 1) {
        const prefix = start + index,
          tail = start + DAB_MODE_I_FFT + index;
        correlationI +=
          this.frameI[tail]! * this.frameI[prefix]! +
          this.frameQ[tail]! * this.frameQ[prefix]!;
        correlationQ +=
          this.frameI[tail]! * this.frameQ[prefix]! -
          this.frameQ[tail]! * this.frameI[prefix]!;
      }
    }
    const correctionPerSample =
      Math.atan2(correlationQ, correlationI) / DAB_MODE_I_FFT;
    this.fineFrequencyCorrectionHz =
      (correctionPerSample * DAB_MODE_I_RATE) / (2 * Math.PI);
    this.timingStartSamples = timingStart;
    const timeI = new Float32Array(DAB_MODE_I_FFT),
      timeQ = new Float32Array(DAB_MODE_I_FFT),
      previousI = new Float32Array(DAB_MODE_I_FFT),
      previousQ = new Float32Array(DAB_MODE_I_FFT),
      ficBits = new Int8Array(9_216),
      mscBits = new Int8Array(221_184);
    let coarseOffset = this.lockedCoarseOffset ?? 0;
    for (let symbol = 0; symbol < DAB_MODE_I_SYMBOLS; symbol += 1) {
      const useful =
        timingStart + symbol * DAB_MODE_I_SYMBOL + DAB_MODE_I_GUARD - 64;
      for (let index = 0; index < DAB_MODE_I_FFT; index += 1) {
        const source = useful + index,
          angle = correctionPerSample * source,
          cosine = Math.cos(angle),
          sine = Math.sin(angle),
          i = this.frameI[source]!,
          q = this.frameQ[source]!;
        timeI[index] = i * cosine - q * sine;
        timeQ[index] = i * sine + q * cosine;
      }
      const [currentI, currentQ] = this.fft.transform(timeI, timeQ);
      if (symbol === 0) {
        if (this.lockedCoarseOffset === undefined)
          coarseOffset = findCoarseCarrierOffset(currentI, currentQ);
      } else {
        const bits = demapDabDqpsk(
          previousI,
          previousQ,
          currentI,
          currentQ,
          coarseOffset,
        );
        if (symbol <= 3) ficBits.set(bits, (symbol - 1) * bits.length);
        else mscBits.set(bits, (symbol - 4) * bits.length);
      }
      previousI.set(currentI);
      previousQ.set(currentQ);
    }
    this.coarseCarrierOffsetHz = coarseOffset * 1_000;
    // A wrong Q convention can still recover CRC-valid FIBs in partially
    // unaffected coding groups. Compare both on the same acquisition frame;
    // accepting the first valid FIB can lock to a persistent half-FIC/no-MSC
    // result after a corrupt startup frame. Once proven, decode only one path.
    let selectedPolarity = this.quadraturePolarity ?? -1;
    let groups: Uint8Array[][];
    if (this.quadraturePolarity === undefined) {
      const standard = this.decodeFicGroups(ficBits);
      this.flipQuadratureMetrics(ficBits);
      const reversed = this.decodeFicGroups(ficBits);
      const standardCount = standard.reduce((sum, group) => sum + group.length, 0);
      const reversedCount = reversed.reduce((sum, group) => sum + group.length, 0);
      selectedPolarity = reversedCount > standardCount ? 1 : -1;
      groups = selectedPolarity === 1 ? reversed : standard;
      if (standardCount !== reversedCount)
        this.quadraturePolarity = selectedPolarity;
    } else {
      if (selectedPolarity === 1) this.flipQuadratureMetrics(ficBits);
      groups = this.decodeFicGroups(ficBits);
    }
    if (selectedPolarity === 1) this.flipQuadratureMetrics(mscBits);
    const validFibs = this.processFic(groups);
    this.consecutiveBadFrames =
      validFibs > 0 ? 0 : this.consecutiveBadFrames + 1;
    // A CRC-valid FIB makes an accidental integer-carrier alignment
    // vanishingly unlikely. Keep that proven offset instead of allowing
    // frequency-selective fading to select a noisy PRS peak on every frame.
    if (validFibs > 0 && this.lockedCoarseOffset === undefined)
      this.lockedCoarseOffset = coarseOffset;
    if (!this.msc) return timingStart;
    for (let cif = 0; cif < 4; cif += 1) {
      const logical = this.msc.pushCif(
        mscBits.subarray(cif * 55_296, (cif + 1) * 55_296),
      );
      if (logical) {
        this.logicalFrames += 1;
        this.onLogicalFrame(logical);
      }
    }
    return timingStart;
  }

  private decodeFicGroups(bits: Int8Array): Uint8Array[][] {
    return Array.from({ length: 4 }, (_, group) =>
      decodeFicGroup(bits.subarray(group * 2_304, (group + 1) * 2_304)),
    );
  }

  private processFic(groups: Uint8Array[][]): number {
    this.ficAttempts += 12;
    this.ficFrames += 1;
    let validFibs = 0;
    for (let group = 0; group < 4; group += 1) {
      const decoded = groups[group]!;
      this.ficGroupBlocks[group] =
        (this.ficGroupBlocks[group] ?? 0) + decoded.length;
      for (const fib of decoded) {
        validFibs += 1;
        this.ficBlocks += 1;
        this.fic.processFib(fib);
      }
    }
    if (validFibs > 0) this.ficFramesWithAny += 1;
    if (validFibs === 12) this.ficCompleteFrames += 1;
    this.ficSuccessHistogram[validFibs] =
      (this.ficSuccessHistogram[validFibs] ?? 0) + 1;
    this.updateSelectedService();
    return validFibs;
  }

  private publishStatus(): void {
    const selected = this.fic.selectedDabPlusService(this.stationKey);
    this.onStatus({
      state: selected ? "service" : "fic",
      frameIntervalSamples: this.frameIntervalSamples,
      missedFrames: this.missedFrames,
      processingMs: this.processingMs,
      maxProcessingMs: this.maxProcessingMs,
      ficBlocks: this.ficBlocks,
      ficAttempts: this.ficAttempts,
      ficFrames: this.ficFrames,
      ficFramesWithAny: this.ficFramesWithAny,
      ficCompleteFrames: this.ficCompleteFrames,
      ficSuccessHistogram: this.ficSuccessHistogram.slice(),
      ficGroupBlocks: this.ficGroupBlocks.slice(),
      logicalFrames: this.logicalFrames,
      fineFrequencyCorrectionHz: this.fineFrequencyCorrectionHz,
      coarseCarrierOffsetHz: this.coarseCarrierOffsetHz,
      coarseCarrierLocked: this.lockedCoarseOffset !== undefined,
      timingStartSamples: this.timingStartSamples,
      quadraturePolarity:
        (this.quadraturePolarity ?? -1) === -1
          ? "standard"
          : "reversed",
      stations: this.fic.stations(),
      ensemble: this.fic.ensemble,
      ...selected,
      message: selected
        ? `Decoding DAB+ service 0x${selected.service.serviceId.toString(16).toUpperCase()} on subchannel ${selected.subchannel.id} (${selected.subchannel.length} CU, EEP ${selected.subchannel.protectionLevel + 1}-${selected.subchannel.eepType}).`
        : "Waiting for a valid DAB+ service definition…",
    });
  }

  private flipQuadratureMetrics(bits: Int8Array): void {
    for (let symbol = 0; symbol < bits.length; symbol += 3_072)
      for (
        let index = symbol + DAB_MODE_I_CARRIERS;
        index < symbol + 3_072;
        index += 1
      )
        bits[index] = -bits[index]!;
  }
}
