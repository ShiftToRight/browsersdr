import { DemodWBFMStage1 } from "@jtarrio/signals/demod/demod-wbfm.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { RdsDecoder, type RdsState } from "./rdsDecoder";

/** WBFM-only tap that derives a 336 ksample/s (or input-rate) raw multiplex. */
export class RdsMultiplexReceiver implements SampleReceiver {
  private sampleRate = 1_024_000;
  private outputRate = 336_000;
  private frequencyOffset = 0;
  private enabled = true;
  private modeEnabled = true;
  private stage1 = this.createStage();
  private readonly decoder: RdsDecoder;

  constructor(onUpdate: (state: RdsState) => void) {
    this.decoder = new RdsDecoder({ onUpdate });
    this.decoder.configure(this.outputRate);
  }

  setSampleRate(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.outputRate = Math.min(sampleRate, 336_000);
    this.stage1 = this.createStage();
    this.enabled = this.modeEnabled && this.outputRate > 2 * 57_000;
    if (this.enabled) this.decoder.configure(this.outputRate);
    else this.decoder.reset();
  }

  setFrequencyOffset(offset: number): void {
    this.frequencyOffset = offset;
    this.reset();
  }

  setEnabled(enabled: boolean): void {
    this.modeEnabled = enabled;
    this.enabled = enabled && this.outputRate > 2 * 57_000;
    this.reset();
  }

  get isEnabled(): boolean { return this.enabled; }

  reset(): void {
    this.stage1 = this.createStage();
    this.decoder.reset();
  }

  receiveSamples(block: SampleBlock): void {
    if (!this.enabled) return;
    // Signals' stage 1 shifts, filters and FM-demodulates in place. Upstream
    // RtlSource arrays are borrowed, so this independent tap owns both copies.
    const i = new Float32Array(block.I);
    const q = new Float32Array(block.Q);
    this.receiveOwnedSamples({ I: i, Q: q, frequency: block.frequency });
  }

  receiveOwnedSamples(block: SampleBlock): void {
    if (!this.enabled) return;
    const multiplex = this.stage1.demodulate(block.I, block.Q, this.frequencyOffset).left;
    this.decoder.process(multiplex);
  }

  private createStage(): DemodWBFMStage1 {
    return new DemodWBFMStage1(this.sampleRate, this.outputRate, { scheme: "WBFM", stereo: false });
  }
}

/** Analysis copies raw I/Q first; mutating audio and RDS never share arrays. */
export class AudioFirstRdsReceiver implements SampleReceiver {
  private I = new Float32Array(0);
  private Q = new Float32Array(0);

  constructor(
    private readonly primary: SampleReceiver,
    private readonly rds: RdsMultiplexReceiver,
    private readonly analysis?: SampleReceiver,
  ) {}

  setSampleRate(sampleRate: number): void {
    this.primary.setSampleRate(sampleRate);
    this.rds.setSampleRate(sampleRate);
    this.analysis?.setSampleRate(sampleRate);
  }

  receiveSamples(block: SampleBlock): void {
    // AnalysisPipeline synchronously copies into its bounded transferable slot.
    // It must run before the demodulator's in-place frequency shift/filtering.
    this.analysis?.receiveSamples(block);
    if (!this.rds.isEnabled) {
      this.primary.receiveSamples(block);
      return;
    }
    if (this.I.length !== block.I.length) this.I = new Float32Array(block.I.length);
    if (this.Q.length !== block.Q.length) this.Q = new Float32Array(block.Q.length);
    this.I.set(block.I);
    this.Q.set(block.Q);
    this.primary.receiveSamples(block);
    this.rds.receiveOwnedSamples({ I: this.I, Q: this.Q, frequency: block.frequency });
  }
}
