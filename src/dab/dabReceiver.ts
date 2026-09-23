import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";

export const DAB_NOMINAL_SAMPLE_RATE_HZ = 2_048_000;
export const DAB_OCCUPIED_BANDWIDTH_HZ = 1_536_000;
export const DAB_FRAME_SAMPLES = 196_608;
export const DAB_NULL_SAMPLES = 2_656;
export const DAB_USEFUL_SYMBOL_SAMPLES = 2_048;
export const DAB_GUARD_SAMPLES = 504;

export type DabSyncState = "searching" | "synchronized" | "lost";

export interface DabSnapshot {
  state: DabSyncState;
  frameCount: number;
  nullSymbolCount: number;
  estimatedSnrDb: number | null;
  coarseFrequencyOffsetHz: number | null;
  message: string;
}

/** Replaceable boundary for a separately licensed Worker/WASM ensemble decoder. */
export interface DabEnsembleDecoder extends SampleReceiver { reset(): void }

const INITIAL: DabSnapshot = {
  state: "searching", frameCount: 0, nullSymbolCount: 0,
  estimatedSnrDb: null, coarseFrequencyOffsetHz: null,
  message: "Searching for a DAB mode I null symbol…",
};

/** Streaming mode-I null-symbol acquisition and cyclic-prefix frequency estimator. */
export class DabReceiver implements SampleReceiver {
  private sampleRateHz = DAB_NOMINAL_SAMPLE_RATE_HZ;
  private snapshot: DabSnapshot = { ...INITIAL };
  private averagePower = 0;
  private averageReadySamples = 0;
  private lowSamples = 0;
  private nullPower = 0;
  private samplesSinceNull = Number.POSITIVE_INFINITY;
  private pending: { I: number[]; Q: number[]; signalPower: number } | undefined;
  private frequencyOffsetHz = 0;
  private oscillatorPhase = 0;

  constructor(private readonly onUpdate: (snapshot: DabSnapshot) => void, private decoder?: DabEnsembleDecoder) {}
  get current(): DabSnapshot { return this.snapshot; }

  setDecoder(decoder?: DabEnsembleDecoder): void {
    this.decoder?.reset();
    this.decoder = decoder;
    decoder?.setSampleRate(this.sampleRateHz);
  }

  setFrequencyOffset(offsetHz: number): void {
    if (!Number.isFinite(offsetHz)) throw new Error("DAB frequency offset must be finite.");
    this.frequencyOffsetHz = offsetHz;
    this.oscillatorPhase = 0;
    this.reset();
  }

  setSampleRate(sampleRateHz: number): void {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error("DAB sample rate must be positive.");
    this.sampleRateHz = sampleRateHz;
    this.decoder?.setSampleRate(sampleRateHz);
    this.reset();
  }

  reset(): void {
    this.snapshot = { ...INITIAL };
    this.averagePower = 0; this.averageReadySamples = 0; this.lowSamples = 0; this.nullPower = 0;
    this.samplesSinceNull = Number.POSITIVE_INFINITY; this.pending = undefined; this.oscillatorPhase = 0;
    this.decoder?.reset();
    this.onUpdate(this.snapshot);
  }

  receiveSamples(block: SampleBlock): void {
    const decoderI = this.decoder ? new Float32Array(block.I.length) : undefined;
    const decoderQ = this.decoder ? new Float32Array(block.Q.length) : undefined;
    const phaseStep = -2 * Math.PI * this.frequencyOffsetHz / this.sampleRateHz;
    const nullSamples = this.scaled(DAB_NULL_SAMPLES);
    const frameSamples = this.scaled(DAB_FRAME_SAMPLES);
    const confirmationSamples = this.scaled(DAB_GUARD_SAMPLES + DAB_USEFUL_SYMBOL_SAMPLES);
    const warmupSamples = Math.max(nullSamples * 2, Math.round(this.sampleRateHz * 0.01));
    for (let index = 0; index < block.I.length; index += 1) {
      const i = block.I[index] ?? 0, q = block.Q[index] ?? 0;
      if (decoderI && decoderQ) {
        const cosine = Math.cos(this.oscillatorPhase), sine = Math.sin(this.oscillatorPhase);
        decoderI[index] = i * cosine - q * sine; decoderQ[index] = i * sine + q * cosine;
        this.oscillatorPhase += phaseStep;
        if (this.oscillatorPhase > Math.PI) this.oscillatorPhase -= 2 * Math.PI;
        else if (this.oscillatorPhase < -Math.PI) this.oscillatorPhase += 2 * Math.PI;
      }
      const power = i * i + q * q;
      this.samplesSinceNull += 1;
      if (this.pending) {
        this.pending.I.push(i); this.pending.Q.push(q); this.pending.signalPower += power;
        if (this.pending.I.length >= confirmationSamples) this.confirmNull();
        continue;
      }
      if (this.averageReadySamples < warmupSamples) {
        this.averagePower += (power - this.averagePower) / (this.averageReadySamples + 1);
        this.averageReadySamples += 1;
        continue;
      }
      if (power < Math.max(1e-10, this.averagePower * 0.18)) {
        this.lowSamples += 1; this.nullPower += power;
      } else if (this.lowSamples >= nullSamples * 0.68 && this.lowSamples <= nullSamples * 1.45) {
        this.pending = { I: [i], Q: [q], signalPower: power }; this.lowSamples = 0;
      } else {
        this.lowSamples = 0; this.nullPower = 0;
        this.averagePower += 0.00002 * (power - this.averagePower);
      }
      if (this.snapshot.state === "synchronized" && this.samplesSinceNull > frameSamples * 1.8) {
        this.publish({ ...this.snapshot, state: "lost", message: "DAB synchronization lost; searching for the next transmission frame…" });
      }
    }
    if (decoderI && decoderQ) this.decoder?.receiveSamples({ I: decoderI, Q: decoderQ, frequency: block.frequency + this.frequencyOffsetHz });
  }

  private confirmNull(): void {
    const pending = this.pending!;
    const signalPower = pending.signalPower / pending.I.length;
    const nullPower = this.nullPower / Math.max(1, this.scaled(DAB_NULL_SAMPLES));
    this.pending = undefined; this.nullPower = 0;
    if (signalPower < this.averagePower * 0.35) return;
    const useful = this.scaled(DAB_USEFUL_SYMBOL_SAMPLES);
    const guard = Math.min(this.scaled(DAB_GUARD_SAMPLES), pending.I.length - useful);
    let correlationI = 0, correlationQ = 0;
    for (let index = 0; index < guard; index += 1) {
      const end = index + useful;
      const ai = pending.I[index] ?? 0, aq = pending.Q[index] ?? 0;
      const bi = pending.I[end] ?? 0, bq = pending.Q[end] ?? 0;
      correlationI += ai * bi + aq * bq; correlationQ += ai * bq - aq * bi;
    }
    const phase = Math.atan2(correlationQ, correlationI);
    const measuredModuloCarrierHz = phase * this.sampleRateHz / (2 * Math.PI * useful);
    const residualFrequencyOffsetHz = measuredModuloCarrierHz - this.frequencyOffsetHz
      - Math.round((measuredModuloCarrierHz - this.frequencyOffsetHz) / 1_000) * 1_000;
    this.samplesSinceNull = 0; this.averagePower = signalPower;
    this.publish({ state: "synchronized", frameCount: this.snapshot.frameCount + 1,
      nullSymbolCount: this.snapshot.nullSymbolCount + 1,
      estimatedSnrDb: 10 * Math.log10(Math.max(signalPower, 1e-12) / Math.max(nullPower, 1e-12)),
      coarseFrequencyOffsetHz: residualFrequencyOffsetHz,
      message: "DAB mode I transmission frame synchronized." });
  }

  private scaled(samples: number): number { return Math.max(1, Math.round(samples * this.sampleRateHz / DAB_NOMINAL_SAMPLE_RATE_HZ)); }
  private publish(snapshot: DabSnapshot): void { this.snapshot = snapshot; this.onUpdate(snapshot); }
}

export function validateDabSampleRate(sampleRateHz: number): void {
  if (sampleRateHz < DAB_NOMINAL_SAMPLE_RATE_HZ) throw new Error("DAB mode I requires a sample rate of at least 2.048 MS/s; select 2.4 MS/s.");
}
