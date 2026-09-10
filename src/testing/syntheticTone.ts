import type { SourceSessionMetadata } from "../radio/types";

export interface SyntheticToneOptions {
  sampleRateHz: number;
  toneOffsetHz: number;
  amplitude?: number;
  initialPhaseRadians?: number;
}

export interface SyntheticComplexBlock {
  /** Planar, normalized Float32 I samples owned by the caller. */
  I: Float32Array;
  /** Planar, normalized Float32 Q samples owned by the caller. */
  Q: Float32Array;
}

/** Deterministic complex baseband tone whose phase continues across blocks. */
export class SyntheticComplexTone {
  readonly sampleRateHz: number;
  readonly toneOffsetHz: number;
  readonly amplitude: number;
  private phaseRadians: number;
  private readonly phaseStepRadians: number;

  constructor({
    sampleRateHz,
    toneOffsetHz,
    amplitude = 0.7,
    initialPhaseRadians = 0,
  }: SyntheticToneOptions) {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new RangeError("sampleRateHz must be a positive finite number");
    }
    if (!Number.isFinite(toneOffsetHz) || Math.abs(toneOffsetHz) >= sampleRateHz / 2) {
      throw new RangeError("toneOffsetHz must be inside the open Nyquist interval");
    }
    if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
      throw new RangeError("amplitude must be between 0 and 1");
    }

    this.sampleRateHz = sampleRateHz;
    this.toneOffsetHz = toneOffsetHz;
    this.amplitude = amplitude;
    this.phaseRadians = normalizePhase(initialPhaseRadians);
    this.phaseStepRadians = (2 * Math.PI * toneOffsetHz) / sampleRateHz;
  }

  generate(sampleCount: number): SyntheticComplexBlock {
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
      throw new RangeError("sampleCount must be a non-negative safe integer");
    }

    const I = new Float32Array(sampleCount);
    const Q = new Float32Array(sampleCount);
    let phase = this.phaseRadians;

    for (let index = 0; index < sampleCount; index += 1) {
      I[index] = this.amplitude * Math.cos(phase);
      Q[index] = this.amplitude * Math.sin(phase);
      phase += this.phaseStepRadians;
    }

    this.phaseRadians = normalizePhase(phase);
    return { I, Q };
  }
}

export const SYNTHETIC_DEMO_SESSION: Readonly<SourceSessionMetadata> = {
  source: "synthetic",
  sessionGeneration: 0,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_125_000,
  mode: "WBFM",
  channelBandwidthHz: 150_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};

function normalizePhase(phaseRadians: number): number {
  const turn = 2 * Math.PI;
  return ((phaseRadians % turn) + turn) % turn;
}
