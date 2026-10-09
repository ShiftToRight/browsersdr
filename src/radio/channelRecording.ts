import { HalfBandStage, CHANNEL_MAX_SAMPLES } from "./widebandChannel";
import { channelSampleRate } from "./sourceCapabilities";
import { planChannelTune, validateModeSampleRate } from "./receiverConfig";
import type { SourceKind, SourceSessionMetadata } from "./types";

export interface RecordingOptions {
  receiverLocation?: import("./receiverLocation").ReceiverLocation;
  captureCurrentChannel?: boolean;
  storageMode?: "memory" | "opfs";
}
export const CHANNEL_RECORDING_FORMAT = "browsersdr-channel-iq-v1" as const;
export interface ChannelRecordingFormat {
  format: typeof CHANNEL_RECORDING_FORMAT;
  sampleEncoding: "signed-8-bit" | "signed-16-bit-little-endian";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 2 | 4;
  normalization: "float = signedByte / 128" | "float = int16 / 32768";
  provenanceDetails: {
    originalSource: SourceKind;
    datasetProcessing: "frequency-shift-fir-decimate-v1";
  };
  channelCapture: ChannelCapturePlan;
  hardware?: never;
  gainDb?: never;
  rateEvidence?: never;
}
export interface ChannelCapturePlan {
  inputSampleRateHz: number;
  inputCenterFrequencyHz: number;
  channelFrequencyHz: number;
  bandwidthHz: number;
  outputSampleRateHz: number;
  decimation: number;
  dspSampleRateHz: number;
}

/** Power-of-two rates keep filter storage and downstream rational resampling bounded.
 * Decoder minimums take precedence over disk savings. */
export function planChannelCapture(
  session: Pick<
    SourceSessionMetadata,
    | "actualSampleRateHz"
    | "hardwareCenterFrequencyHz"
    | "selectedChannelFrequencyHz"
    | "channelBandwidthHz"
    | "mode"
    | "bladerf"
  >,
  inputDspRateHz?: number,
): ChannelCapturePlan {
  if (session.mode === "OFF")
    throw new Error(
      "Select a channel mode before recording the current channel.",
    );
  const inputSampleRateHz = session.actualSampleRateHz;
  const tune = planChannelTune(
    session.hardwareCenterFrequencyHz,
    session.selectedChannelFrequencyHz,
    inputSampleRateHz,
    session.channelBandwidthHz,
  );
  if (tune.hardwareRetuneRequired)
    throw new Error("The selected channel is outside the capture span.");
  // Some devices have fractional RFIC readbacks. Preserve the actual sample clock.
  const nominalRate =
    inputDspRateHz ?? session.bladerf?.nativeSampleRateHz ?? inputSampleRateHz;
  const minRate = Math.max(
    48_000,
    session.channelBandwidthHz / (session.mode === "ADS-B" ? 0.9 : 0.7),
    session.mode === "SRD" ? channelSampleRate(nominalRate) : 0,
  );
  let decimation = 1;
  while (decimation < 512 && nominalRate / (decimation * 2) >= minRate) {
    const candidate = nominalRate / (decimation * 2);
    try {
      if (session.mode !== "SRD")
        validateModeSampleRate(session.mode, candidate);
    } catch {
      break;
    }
    decimation *= 2;
  }
  return {
    inputSampleRateHz,
    inputCenterFrequencyHz: session.hardwareCenterFrequencyHz,
    channelFrequencyHz: session.selectedChannelFrequencyHz,
    bandwidthHz: session.channelBandwidthHz,
    outputSampleRateHz: inputSampleRateHz / decimation,
    dspSampleRateHz: nominalRate / decimation,
    decimation,
  };
}

/** Stateful mixer and cascaded anti-alias filters followed by a channel FIR.
 * Input blocks are copied: recording must never mutate live audio/analysis input. */
export class ChannelCaptureFilter {
  private readonly stages: HalfBandStage[] = [];
  private readonly taps = new Float64Array(95);
  private readonly historyI = new Float64Array(190);
  private readonly historyQ = new Float64Array(190);
  private cursor = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private oscillatorCount = 0;
  private readonly rotationI: number;
  private readonly rotationQ: number;
  constructor(readonly plan: ChannelCapturePlan) {
    const angle =
      (-2 * Math.PI * (plan.channelFrequencyHz - plan.inputCenterFrequencyHz)) /
      plan.inputSampleRateHz;
    this.rotationI = Math.cos(angle);
    this.rotationQ = Math.sin(angle);
    for (let divisor = 1; divisor < plan.decimation; divisor *= 2) {
      const rate = plan.inputSampleRateHz / divisor;
      const last = divisor * 2 === plan.decimation;
      this.stages.push(
        new HalfBandStage(
          divisor === 1
            ? plan.channelFrequencyHz - plan.inputCenterFrequencyHz
            : 0,
          rate,
          last ? 95 : rate >= plan.outputSampleRateHz * 8 ? 15 : 31,
        ),
      );
    }
    const passEdge = plan.bandwidthHz / 2;
    const transition = Math.min(
      (plan.outputSampleRateHz - plan.bandwidthHz) / 2,
      Math.max(plan.bandwidthHz * 0.25, plan.outputSampleRateHz * 0.08),
    );
    const cutoff = (passEdge + transition / 2) / plan.outputSampleRateHz;
    let sum = 0;
    for (let n = 0; n < 95; n++) {
      const x = n - 47;
      const sinc =
        x === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      this.taps[n] =
        sinc *
        (0.42 -
          0.5 * Math.cos((2 * Math.PI * n) / 94) +
          0.08 * Math.cos((4 * Math.PI * n) / 94));
      sum += this.taps[n]!;
    }
    for (let n = 0; n < 95; n++) this.taps[n] = this.taps[n]! / sum;
  }
  reset(): void {
    this.stages.forEach((stage, index) =>
      stage.reset(
        index === 0
          ? this.plan.channelFrequencyHz - this.plan.inputCenterFrequencyHz
          : 0,
      ),
    );
    this.historyI.fill(0);
    this.historyQ.fill(0);
    this.cursor = 0;
    this.oscillatorI = 1;
    this.oscillatorQ = 0;
    this.oscillatorCount = 0;
  }
  process(
    I: Float32Array,
    Q: Float32Array,
  ): { I: Float32Array; Q: Float32Array } {
    if (I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES)
      throw new Error("Invalid channel capture block.");
    I = I.slice();
    Q = Q.slice();
    let count = I.length;
    for (const stage of this.stages)
      count = stage.process(I.subarray(0, count), Q.subarray(0, count));
    for (let n = 0; n < count; n++) {
      let i = I[n]!,
        q = Q[n]!;
      if (!this.stages.length) {
        i = I[n]! * this.oscillatorI - Q[n]! * this.oscillatorQ;
        q = I[n]! * this.oscillatorQ + Q[n]! * this.oscillatorI;
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
      this.historyI[this.cursor] = this.historyI[this.cursor + 95] = i;
      this.historyQ[this.cursor] = this.historyQ[this.cursor + 95] = q;
      this.cursor = (this.cursor + 1) % 95;
      let sumI = 0,
        sumQ = 0;
      for (let t = 0; t < 95; t++) {
        sumI += this.taps[t]! * this.historyI[this.cursor + t]!;
        sumQ += this.taps[t]! * this.historyQ[this.cursor + t]!;
      }
      I[n] = sumI;
      Q[n] = sumQ;
    }
    return { I: I.subarray(0, count), Q: Q.subarray(0, count) };
  }
}

export function validateChannelRecording(
  format: ChannelRecordingFormat,
  rate: number,
  center: number,
  bandwidth: number,
): void {
  const plan = format.channelCapture;
  if (
    !plan ||
    ![
      plan.inputSampleRateHz,
      plan.inputCenterFrequencyHz,
      plan.channelFrequencyHz,
      plan.bandwidthHz,
      plan.outputSampleRateHz,
      plan.dspSampleRateHz,
    ].every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isInteger(plan.decimation) ||
    plan.decimation < 1 ||
    plan.decimation > 512 ||
    (plan.decimation & (plan.decimation - 1)) !== 0 ||
    Math.abs(plan.dspSampleRateHz - rate) > rate * 0.001 ||
    rate !== plan.outputSampleRateHz ||
    center !== plan.channelFrequencyHz ||
    bandwidth > plan.bandwidthHz ||
    plan.bandwidthHz >= rate ||
    Math.abs(rate * plan.decimation - plan.inputSampleRateHz) > 1e-6 ||
    ![
      "rtl-sdr",
      "hackrf",
      "bladerf",
      "usrp-b205",
      "synthetic",
      "replay",
    ].includes(format.provenanceDetails?.originalSource) ||
    format.provenanceDetails?.datasetProcessing !==
      "frequency-shift-fir-decimate-v1"
  )
    throw new Error("Invalid channel capture provenance.");
  if (
    planChannelTune(
      plan.inputCenterFrequencyHz,
      center,
      plan.inputSampleRateHz,
      plan.bandwidthHz,
    ).hardwareRetuneRequired
  )
    throw new Error("Channel capture lies outside its original source span.");
}
