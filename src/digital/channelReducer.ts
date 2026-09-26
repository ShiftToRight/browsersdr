import {
  type DigitalDecoderConfiguration,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  validateDigitalConfiguration,
  validateDigitalInputBlock,
} from "./contracts";

export const DIGITAL_SUPPORTED_INPUT_RATES_HZ = [1_024_000, 2_400_000] as const;
export const DIGITAL_MIN_OUTPUT_RATE_HZ = 24_000;
export const DIGITAL_MAX_OUTPUT_RATE_HZ = 256_000;
export const DIGITAL_MAX_DECIMATION = 64;
export const DIGITAL_MAX_BANDWIDTH_FRACTION = 0.7;
const TAPS_PER_PHASE = 16;

export interface DigitalChannelConfiguration extends DigitalDecoderConfiguration {
  /** Two-sided occupied channel bandwidth. */
  channelBandwidthHz: number;
  /** Must be an integer divisor of actualInputSampleRateHz. */
  outputSampleRateHz: number;
}

export interface ReducedDigitalBlock {
  I: Float32Array;
  Q: Float32Array;
  /** Linear magnitude at outputSampleRateHz. */
  envelope: Float32Array;
  /** Phase-difference discriminator in Hz. First value after a reset is zero. */
  fmHz: Float32Array;
  outputSampleRateHz: number;
  /** Acquisition index at which the first FIR output ends (filter delay is not removed). */
  firstOutputInputSampleIndex: number;
  inputSamplesPerOutput: number;
  provenance: DigitalProvenance;
  discontinuityBefore?: DigitalDiscontinuity;
}

export function validateDigitalChannelConfiguration(
  configuration: DigitalChannelConfiguration,
): void {
  validateDigitalConfiguration(configuration);
  if (
    !DIGITAL_SUPPORTED_INPUT_RATES_HZ.includes(
      configuration.actualInputSampleRateHz as (typeof DIGITAL_SUPPORTED_INPUT_RATES_HZ)[number],
    )
  )
    throw new Error("Digital channel input rate must be 1.024 or 2.4 MS/s.");
  if (
    !Number.isFinite(configuration.outputSampleRateHz) ||
    configuration.outputSampleRateHz < DIGITAL_MIN_OUTPUT_RATE_HZ ||
    configuration.outputSampleRateHz > DIGITAL_MAX_OUTPUT_RATE_HZ
  )
    throw new Error(
      "Digital channel output rate must be between 24 and 256 ksample/s.",
    );
  const decimation =
    configuration.actualInputSampleRateHz / configuration.outputSampleRateHz;
  if (
    !Number.isInteger(decimation) ||
    decimation < 1 ||
    decimation > DIGITAL_MAX_DECIMATION
  )
    throw new Error(
      "Digital channel output rate must be an integer input-rate divisor with decimation at most 64.",
    );
  if (
    !Number.isFinite(configuration.channelBandwidthHz) ||
    configuration.channelBandwidthHz <= 0 ||
    configuration.channelBandwidthHz >
      configuration.outputSampleRateHz * DIGITAL_MAX_BANDWIDTH_FRACTION
  )
    throw new Error(
      "Digital channel bandwidth must be positive and no more than 70% of output rate.",
    );
}

/** Stateful translator + Blackman-windowed FIR integer decimator. */
export class DigitalChannelReducer {
  private configuration?: DigitalChannelConfiguration;
  private taps = new Float64Array(0);
  private historyI = new Float64Array(0);
  private historyQ = new Float64Array(0);
  private cursor = 0;
  private decimation = 1;
  private decimationPhase = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private rotationI = 1;
  private rotationQ = 0;
  private oscillatorCount = 0;
  private previousI = 0;
  private previousQ = 0;
  private discriminatorReady = false;
  private expectedSampleIndex?: number;
  private disposed = false;

  configure(configuration: DigitalChannelConfiguration): void {
    validateDigitalChannelConfiguration(configuration);
    const next = { ...configuration };
    const decimation = next.actualInputSampleRateHz / next.outputSampleRateHz;
    const taps = designLowPass(next, decimation);
    // Commit only after all validation/design succeeds.
    this.configuration = next;
    this.decimation = decimation;
    this.taps = taps;
    this.historyI = new Float64Array(taps.length);
    this.historyQ = new Float64Array(taps.length);
    this.disposed = false;
    this.reset();
  }

  reset(): void {
    this.requireConfigured();
    this.historyI.fill(0);
    this.historyQ.fill(0);
    this.cursor = 0;
    this.decimationPhase = 0;
    this.oscillatorI = 1;
    this.oscillatorQ = 0;
    this.oscillatorCount = 0;
    const angle =
      (-2 * Math.PI * this.configuration!.selectedChannelOffsetHz) /
      this.configuration!.actualInputSampleRateHz;
    this.rotationI = Math.cos(angle);
    this.rotationQ = Math.sin(angle);
    this.previousI = 0;
    this.previousQ = 0;
    this.discriminatorReady = false;
    this.expectedSampleIndex = undefined;
  }

  process(block: DigitalInputBlock): ReducedDigitalBlock {
    const configuration = this.requireConfigured();
    validateDigitalInputBlock(block);
    if (block.generation !== configuration.generation)
      throw new Error(
        "Digital channel input generation does not match its configuration.",
      );

    let discontinuity = block.discontinuityBefore;
    if (
      this.expectedSampleIndex !== undefined &&
      block.firstSampleIndex !== this.expectedSampleIndex
    ) {
      const missing = Math.max(
        0,
        block.firstSampleIndex - this.expectedSampleIndex,
      );
      discontinuity ??= {
        reason: "source-gap",
        missingInputSamples: missing,
      };
    }
    if (discontinuity) this.reset();
    this.expectedSampleIndex = block.firstSampleIndex + block.I.length;

    const capacity = Math.ceil(block.I.length / this.decimation) + 1;
    const I = new Float32Array(capacity);
    const Q = new Float32Array(capacity);
    const envelope = new Float32Array(capacity);
    const fmHz = new Float32Array(capacity);
    let count = 0;
    let firstOutputInputSampleIndex = -1;
    for (let index = 0; index < block.I.length; index++) {
      const rawI = block.I[index]!;
      const rawQ = block.Q[index]!;
      const mixedI = rawI * this.oscillatorI - rawQ * this.oscillatorQ;
      const mixedQ = rawI * this.oscillatorQ + rawQ * this.oscillatorI;
      const nextI =
        this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
      this.oscillatorQ =
        this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI;
      this.oscillatorI = nextI;
      if (++this.oscillatorCount === 4096) {
        const magnitude = Math.hypot(this.oscillatorI, this.oscillatorQ) || 1;
        this.oscillatorI /= magnitude;
        this.oscillatorQ /= magnitude;
        this.oscillatorCount = 0;
      }
      this.historyI[this.cursor] = mixedI;
      this.historyQ[this.cursor] = mixedQ;
      this.cursor = (this.cursor + 1) % this.taps.length;
      if (this.decimationPhase++ !== 0) {
        if (this.decimationPhase === this.decimation) this.decimationPhase = 0;
        continue;
      }
      let filteredI = 0;
      let filteredQ = 0;
      let history = this.cursor;
      for (let tap = this.taps.length - 1; tap >= 0; tap--) {
        filteredI += this.taps[tap]! * this.historyI[history]!;
        filteredQ += this.taps[tap]! * this.historyQ[history]!;
        if (++history === this.taps.length) history = 0;
      }
      I[count] = filteredI;
      Q[count] = filteredQ;
      envelope[count] = Math.hypot(filteredI, filteredQ);
      if (this.discriminatorReady) {
        const cross = this.previousI * filteredQ - this.previousQ * filteredI;
        const dot = this.previousI * filteredI + this.previousQ * filteredQ;
        fmHz[count] =
          (Math.atan2(cross, dot) * configuration.outputSampleRateHz) /
          (2 * Math.PI);
      }
      this.previousI = filteredI;
      this.previousQ = filteredQ;
      this.discriminatorReady = true;
      if (firstOutputInputSampleIndex < 0)
        firstOutputInputSampleIndex = block.firstSampleIndex + index;
      count++;
    }
    const lastInputSampleIndex =
      block.I.length === 0
        ? block.firstSampleIndex
        : block.firstSampleIndex + block.I.length - 1;
    return {
      I: I.subarray(0, count),
      Q: Q.subarray(0, count),
      envelope: envelope.subarray(0, count),
      fmHz: fmHz.subarray(0, count),
      outputSampleRateHz: configuration.outputSampleRateHz,
      firstOutputInputSampleIndex,
      inputSamplesPerOutput: this.decimation,
      provenance: {
        generation: configuration.generation,
        firstInputSampleIndex: block.firstSampleIndex,
        lastInputSampleIndex,
        actualInputSampleRateHz: configuration.actualInputSampleRateHz,
        selectedChannelOffsetHz: configuration.selectedChannelOffsetHz,
      },
      ...(discontinuity ? { discontinuityBefore: discontinuity } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.configuration = undefined;
    this.taps = new Float64Array(0);
    this.historyI = new Float64Array(0);
    this.historyQ = new Float64Array(0);
  }

  private requireConfigured(): DigitalChannelConfiguration {
    if (this.disposed || !this.configuration)
      throw new Error("Digital channel reducer is not configured.");
    return this.configuration;
  }
}

function designLowPass(
  configuration: DigitalChannelConfiguration,
  decimation: number,
): Float64Array<ArrayBuffer> {
  const tapCount = decimation * TAPS_PER_PHASE + 1;
  const taps = new Float64Array(tapCount);
  const middle = (tapCount - 1) / 2;
  const passEdge = configuration.channelBandwidthHz / 2;
  const aliasEdge = configuration.outputSampleRateHz / 2;
  const cutoff = (passEdge + aliasEdge) / 2;
  let sum = 0;
  for (let index = 0; index < tapCount; index++) {
    const x = index - middle;
    const sinc =
      x === 0
        ? (2 * cutoff) / configuration.actualInputSampleRateHz
        : Math.sin(
            (2 * Math.PI * cutoff * x) / configuration.actualInputSampleRateHz,
          ) /
          (Math.PI * x);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * index) / (tapCount - 1)) +
      0.08 * Math.cos((4 * Math.PI * index) / (tapCount - 1));
    taps[index] = sinc * window;
    sum += taps[index]!;
  }
  for (let index = 0; index < tapCount; index++)
    taps[index] = taps[index]! / sum;
  return taps;
}
