import type { DabProgrammeMetadata } from "./dabPad";
import type { DabStation, DabLabel } from "./dabChannelCoding";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";
import type { DabPlusAudioFormat, DabAudioDecoderStatus } from "./dabAudio";
import type { DabModeIStatus } from "./dabModeI";
import type { DabPlusProgrammeStats } from "./dabPlusSuperframe";

export const DAB_NOMINAL_SAMPLE_RATE_HZ = 2_048_000;
export const DAB_OCCUPIED_BANDWIDTH_HZ = 1_536_000;
export const DAB_FRAME_SAMPLES = 196_608;
export const DAB_NULL_SAMPLES = 2_656;
export const DAB_USEFUL_SYMBOL_SAMPLES = 2_048;
export const DAB_GUARD_SAMPLES = 504;

export type DabSyncState = "searching" | "synchronized" | "lost";

export interface DabSnapshot {
  programmeMetadata?: DabProgrammeMetadata;
  padStatistics?: DabPlusProgrammeStats["pad"];
  state: DabSyncState;
  frameCount: number;
  nullSymbolCount: number;
  estimatedSnrDb: number | null;
  coarseFrequencyOffsetHz: number | null;
  ficBlockCount?: number;
  ficBlockAttempts?: number;
  ficFrameCount?: number;
  ficFramesWithAny?: number;
  ficCompleteFrames?: number;
  ficSuccessHistogram?: readonly number[];
  ficGroupBlocks?: readonly number[];
  decoderFineFrequencyCorrectionHz?: number;
  decoderCoarseCarrierOffsetHz?: number;
  decoderCoarseCarrierLocked?: boolean;
  decoderTimingStartSamples?: number;
  frameIntervalSamples?: number;
  missedFrames?: number;
  processingMs?: number;
  maxProcessingMs?: number;
  quadraturePolarity?: "standard" | "reversed";
  audioDecoderState?: DabAudioDecoderStatus["state"];
  audioDecoderMessage?: string;
  decodedAudioSeconds?: number;
  pcmSampleRateHz?: number;
  audioFormat?: DabPlusAudioFormat;
  logicalFrameCount?: number;
  superframeCount?: number;
  accessUnitCount?: number;
  superframeCandidateCount?: number;
  reedSolomonFailureCount?: number;
  fireCodeFailureCount?: number;
  lastCorrectedRsColumns?: number;
  bestCorrectedRsColumns?: number;
  stations?: DabStation[];
  ensemble?: DabLabel & { id: number };
  serviceId?: number;
  subchannelId?: number;
  message: string;
}

/** Replaceable boundary for a separately licensed Worker/WASM ensemble decoder. */
export interface DabEnsembleDecoder extends SampleReceiver {
  reset(): void;
  selectService?(key: string): void;
  prepare?(): Promise<void>;
  drain?(): Promise<void>;
  close?(): void;
}

const INITIAL: DabSnapshot = {
  state: "searching",
  frameCount: 0,
  nullSymbolCount: 0,
  estimatedSnrDb: null,
  coarseFrequencyOffsetHz: null,
  message: "Searching for a DAB mode I null symbol…",
};

/** Streaming mode-I null-symbol acquisition and cyclic-prefix frequency estimator. */
export class DabReceiver implements DigitalSampleReceiver {
  private sampleRateHz = DAB_NOMINAL_SAMPLE_RATE_HZ;
  private snapshot: DabSnapshot = { ...INITIAL };
  private averagePower = 0;
  private averageReadySamples = 0;
  private lowSamples = 0;
  private nullPower = 0;
  private samplesSinceNull = Number.POSITIVE_INFINITY;
  private pending:
    { I: number[]; Q: number[]; signalPower: number } | undefined;
  private frequencyOffsetHz = 0;
  private oscillatorPhase = 0;
  private lastDecoderPublish = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly onUpdate: (snapshot: DabSnapshot) => void,
    private decoder?: DabEnsembleDecoder,
  ) {}
  get current(): DabSnapshot {
    return this.snapshot;
  }

  setDecoder(decoder?: DabEnsembleDecoder): void {
    this.decoder?.reset();
    this.decoder = decoder;
    decoder?.setSampleRate(this.sampleRateHz);
  }

  updateDecoderStatus(status: DabModeIStatus): void {
    this.publish(
      {
        ...this.snapshot,
        frameIntervalSamples: status.frameIntervalSamples,
        missedFrames: status.missedFrames,
        processingMs: status.processingMs,
        maxProcessingMs: status.maxProcessingMs,
        state: status.ficBlocks > 0 ? "synchronized" : "searching",
        frameCount: status.ficFrames,
        nullSymbolCount: status.ficFrames,
        coarseFrequencyOffsetHz:
          status.coarseCarrierOffsetHz - status.fineFrequencyCorrectionHz,
        ficBlockCount: status.ficBlocks,
        ficBlockAttempts: status.ficAttempts,
        ficFrameCount: status.ficFrames,
        ficFramesWithAny: status.ficFramesWithAny,
        ficCompleteFrames: status.ficCompleteFrames,
        ficSuccessHistogram: status.ficSuccessHistogram,
        ficGroupBlocks: status.ficGroupBlocks,
        decoderFineFrequencyCorrectionHz: status.fineFrequencyCorrectionHz,
        decoderCoarseCarrierOffsetHz: status.coarseCarrierOffsetHz,
        decoderCoarseCarrierLocked: status.coarseCarrierLocked,
        decoderTimingStartSamples: status.timingStartSamples,
        quadraturePolarity: status.quadraturePolarity,
        logicalFrameCount: status.logicalFrames,
        stations: status.stations,
        ensemble: status.ensemble,
        serviceId: status.service?.serviceId,
        subchannelId: status.subchannel?.id,
        message: status.message,
      },
      true,
    );
  }

  resetProgramme(): void {
    this.publish({
      ...this.snapshot,
      decodedAudioSeconds: 0,
      pcmSampleRateHz: undefined,
      audioFormat: undefined,
      programmeMetadata: undefined,
      padStatistics: undefined,
      superframeCount: 0,
      accessUnitCount: 0,
      logicalFrameCount: 0,
      audioDecoderState: "checking",
      audioDecoderMessage: "Waiting for selected station audio…",
    });
  }

  updateProgrammeMetadata(programmeMetadata: DabProgrammeMetadata): void {
    this.publish({ ...this.snapshot, programmeMetadata });
  }

  updateProgrammeStats(stats: DabPlusProgrammeStats): void {
    this.publish(
      {
        ...this.snapshot,
        audioFormat: stats.format,
        padStatistics: stats.pad,
        superframeCount: stats.superframes,
        accessUnitCount: stats.accessUnits,
        superframeCandidateCount: stats.candidateWindows,
        reedSolomonFailureCount: stats.reedSolomonFailures,
        fireCodeFailureCount: stats.fireCodeFailures,
        lastCorrectedRsColumns: stats.lastCorrectedColumns,
        bestCorrectedRsColumns: stats.bestCorrectedColumns,
      },
      true,
    );
  }

  updateAudioStatus(status: DabAudioDecoderStatus): void {
    this.publish(
      {
        ...this.snapshot,
        audioDecoderState: status.state,
        audioDecoderMessage: status.message,
      },
      true,
    );
  }

  flushStatus(): void { this.onUpdate(this.snapshot); }

  recordPcm(samples: number, sampleRateHz: number): void {
    this.publish(
      {
        ...this.snapshot,
        decodedAudioSeconds:
          (this.snapshot.decodedAudioSeconds ?? 0) + samples / sampleRateHz,
        pcmSampleRateHz: sampleRateHz,
      },
      true,
    );
  }

  close(): void {
    this.decoder?.close?.();
  }

  setFrequencyOffset(offsetHz: number): void {
    if (!Number.isFinite(offsetHz))
      throw new Error("DAB frequency offset must be finite.");
    this.frequencyOffsetHz = offsetHz;
    this.oscillatorPhase = 0;
    this.reset();
  }

  configure(sampleRateHz: number, frequencyOffsetHz: number): void {
    validateDabSampleRate(sampleRateHz);
    if (!Number.isFinite(frequencyOffsetHz))
      throw new Error("DAB frequency offset must be finite.");
    this.sampleRateHz = sampleRateHz;
    this.frequencyOffsetHz = frequencyOffsetHz;
    this.decoder?.setSampleRate(sampleRateHz);
    this.reset();
  }

  setSampleRate(sampleRateHz: number): void {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0)
      throw new Error("DAB sample rate must be positive.");
    this.sampleRateHz = sampleRateHz;
    this.decoder?.setSampleRate(sampleRateHz);
    this.reset();
  }

  reset(): void {
    this.snapshot = { ...INITIAL };
    this.averagePower = 0;
    this.averageReadySamples = 0;
    this.lowSamples = 0;
    this.nullPower = 0;
    this.samplesSinceNull = Number.POSITIVE_INFINITY;
    this.pending = undefined;
    this.oscillatorPhase = 0;
    this.decoder?.reset();
    this.onUpdate(this.snapshot);
  }

  receiveSamples(block: SampleBlock): void {
    if (this.decoder) {
      // The worker already acquires and diagnoses the complete ensemble.
      // Avoid running a second per-sample null detector on the USB thread.
      const I = block.I.slice(),
        Q = block.Q.slice();
      if (this.frequencyOffsetHz !== 0) {
        const step =
          (-2 * Math.PI * this.frequencyOffsetHz) / this.sampleRateHz;
        for (let index = 0; index < I.length; index += 1) {
          const c = Math.cos(this.oscillatorPhase),
            s = Math.sin(this.oscillatorPhase);
          const i = I[index]!,
            q = Q[index]!;
          I[index] = i * c - q * s;
          Q[index] = i * s + q * c;
          this.oscillatorPhase = (this.oscillatorPhase + step) % (2 * Math.PI);
        }
      }
      this.decoder.receiveSamples({
        I,
        Q,
        frequency: block.frequency + this.frequencyOffsetHz,
      });
      return;
    }
    const nullSamples = this.scaled(DAB_NULL_SAMPLES);
    const frameSamples = this.scaled(DAB_FRAME_SAMPLES);
    const confirmationSamples = this.scaled(
      DAB_GUARD_SAMPLES + DAB_USEFUL_SYMBOL_SAMPLES,
    );
    const warmupSamples = Math.max(
      nullSamples * 2,
      Math.round(this.sampleRateHz * 0.01),
    );
    for (let index = 0; index < block.I.length; index += 1) {
      const i = block.I[index] ?? 0,
        q = block.Q[index] ?? 0;
      const power = i * i + q * q;
      this.samplesSinceNull += 1;
      if (this.pending) {
        this.pending.I.push(i);
        this.pending.Q.push(q);
        this.pending.signalPower += power;
        if (this.pending.I.length >= confirmationSamples) this.confirmNull();
        continue;
      }
      if (this.averageReadySamples < warmupSamples) {
        this.averagePower +=
          (power - this.averagePower) / (this.averageReadySamples + 1);
        this.averageReadySamples += 1;
        continue;
      }
      if (power < Math.max(1e-10, this.averagePower * 0.18)) {
        this.lowSamples += 1;
        this.nullPower += power;
      } else if (
        this.lowSamples >= nullSamples * 0.68 &&
        this.lowSamples <= nullSamples * 1.45
      ) {
        this.pending = { I: [i], Q: [q], signalPower: power };
        this.lowSamples = 0;
      } else {
        this.lowSamples = 0;
        this.nullPower = 0;
        this.averagePower += 0.00002 * (power - this.averagePower);
      }
      if (
        this.snapshot.state === "synchronized" &&
        this.samplesSinceNull > frameSamples * 1.8
      ) {
        this.publish({
          ...this.snapshot,
          state: "lost",
          message:
            "DAB synchronization lost; searching for the next transmission frame…",
        });
      }
    }
  }

  private confirmNull(): void {
    const pending = this.pending!;
    const signalPower = pending.signalPower / pending.I.length;
    const nullPower =
      this.nullPower / Math.max(1, this.scaled(DAB_NULL_SAMPLES));
    this.pending = undefined;
    this.nullPower = 0;
    if (signalPower < this.averagePower * 0.35) return;
    const useful = this.scaled(DAB_USEFUL_SYMBOL_SAMPLES);
    const guard = Math.min(
      this.scaled(DAB_GUARD_SAMPLES),
      pending.I.length - useful,
    );
    let correlationI = 0,
      correlationQ = 0;
    for (let index = 0; index < guard; index += 1) {
      const end = index + useful;
      const ai = pending.I[index] ?? 0,
        aq = pending.Q[index] ?? 0;
      const bi = pending.I[end] ?? 0,
        bq = pending.Q[end] ?? 0;
      correlationI += ai * bi + aq * bq;
      correlationQ += ai * bq - aq * bi;
    }
    const phase = Math.atan2(correlationQ, correlationI);
    const measuredModuloCarrierHz =
      (phase * this.sampleRateHz) / (2 * Math.PI * useful);
    const residualFrequencyOffsetHz =
      measuredModuloCarrierHz -
      this.frequencyOffsetHz -
      Math.round((measuredModuloCarrierHz - this.frequencyOffsetHz) / 1_000) *
        1_000;
    this.samplesSinceNull = 0;
    this.averagePower = signalPower;
    this.publish({
      state: "synchronized",
      frameCount: this.snapshot.frameCount + 1,
      nullSymbolCount: this.snapshot.nullSymbolCount + 1,
      estimatedSnrDb:
        10 *
        Math.log10(Math.max(signalPower, 1e-12) / Math.max(nullPower, 1e-12)),
      coarseFrequencyOffsetHz: residualFrequencyOffsetHz,
      message: "DAB mode I transmission frame synchronized.",
    });
  }

  private scaled(samples: number): number {
    return Math.max(
      1,
      Math.round((samples * this.sampleRateHz) / DAB_NOMINAL_SAMPLE_RATE_HZ),
    );
  }
  private publish(snapshot: DabSnapshot, throttle = false): void {
    this.snapshot = snapshot;
    const now = performance.now();
    if (throttle && now - this.lastDecoderPublish < 250) return;
    this.lastDecoderPublish = now;
    this.onUpdate(snapshot);
  }
}

export function validateDabSampleRate(sampleRateHz: number): void {
  if (
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz < DAB_NOMINAL_SAMPLE_RATE_HZ
  )
    throw new Error(
      "DAB mode I requires a sample rate of at least 2.048 MS/s; select 2.4 MS/s.",
    );
}
