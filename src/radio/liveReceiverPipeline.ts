import { isWidebandRate } from "./sourceCapabilities";
import { WidebandChannelWorker, type ChannelWorkerPort } from "./widebandChannel";
import { channelSampleRate } from "./sourceCapabilities";
import { validateLiveRateBudget } from "./liveRateBudget";
import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AudioPlayer } from "@jtarrio/signals/players/audioplayer.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";
import { DabReceiver } from "../dab/dabReceiver";
import { AdsbReceiver } from "../adsb/adsbReceiver";
import { AisReceiver } from "../ais/aisReceiver";
import { createSignalsMode, validateModeSampleRate } from "./receiverConfig";
import type { SourceSessionMetadata } from "./types";
import type { ReceiverBackendEvents } from "./receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";

export type LiveDemodulator = Pick<Demodulator, "setMode" | "setVolume" | "setFrequencyOffset" | "setSampleRate" | "receiveSamples" | "expectFrequencyAndSetOffset">;
export interface LiveReceiverDependencies {
  createChannelWorker?: () => ChannelWorkerPort;
  createAudioContext?: () => AudioContext;
  createDemodulator?: (context: AudioContext) => LiveDemodulator;
}

/** Shared DSP/audio owner only. Hardware acquisition and native recording stay in
 * the backends. All samples must arrive synchronously through the raw fan-out. */
export class LiveReceiverPipeline implements SampleReceiver {
  readonly audioContext: AudioContext;
  readonly demodulator: LiveDemodulator;
  private readonly rds: RdsMultiplexReceiver;
  private readonly dab: DabReceiver;
  private readonly adsb: AdsbReceiver;
  private readonly ais: AisReceiver;
  private readonly receiver: AudioFirstRdsReceiver;
  private generation?: number;
  private rawAnalysis?: SampleReceiver;
  private channel?: WidebandChannelWorker;
  private selectedFrequency = 0;
  private enabled = false;
  private centerFrequencyHz = 0;
  private closeTask?: Promise<void>;
  private closed = false;
  private closing = false;

  constructor(private readonly events: ReceiverBackendEvents, private readonly analysis?: AnalysisPipeline, private readonly dependencies: LiveReceiverDependencies = {}) {
    this.audioContext = dependencies.createAudioContext?.() ?? new AudioContext();
    this.audioContext.addEventListener("statechange", this.audioChanged);
    this.demodulator = dependencies.createDemodulator?.(this.audioContext)
      ?? new Demodulator({ player: new AudioPlayer({ newAudioContext: () => this.audioContext }) });
    this.rds = new RdsMultiplexReceiver((value) => events.rdsChanged(value));
    this.dab = new DabReceiver((value) => events.dabChanged?.(value));
    this.adsb = new AdsbReceiver((value) => events.adsbChanged?.(value));
    this.ais = new AisReceiver((value) => events.aisChanged?.(value));
    this.receiver = new AudioFirstRdsReceiver(this.demodulator, this.rds);
  }
  resume(): Promise<void> { return this.audioContext.resume(); }
  requireRunning(): void {
    if (this.audioContext.state !== "running") throw new DOMException(`Audio context remained ${this.audioContext.state}`, "NotAllowedError");
  }
  setVolume(volume: number): void { this.demodulator.setVolume(volume); }
  /** Signals 0.10.1 uses exact rational interpolation and allocates one phase
   * filter per output/gcd(input, output). Fractional readbacks can make that
   * allocation enormous. Reject before any consumer sees the rate; never round
   * acquisition timing to make a filter fit. RTL keeps its legacy rate policy. */
  validateRateBudget(sampleRate: number): void {
    validateLiveRateBudget(sampleRate, this.audioContext.sampleRate);
  }
  setSampleRate(sampleRate: number): void { this.receiver.setSampleRate(channelSampleRate(sampleRate)); }
  receiveSamples(block: SampleBlock): void {
    if (!this.enabled || block.frequency !== this.centerFrequencyHz) return;
    this.rawAnalysis?.receiveSamples(block);
    if (this.channel) this.channel.receive(block, this.selectedFrequency);
    else this.receiver.receiveSamples(block);
  }
  async prepare(metadata: SourceSessionMetadata): Promise<void> {
    if (!isWidebandRate(metadata.actualSampleRateHz)) return;
    this.requireOpen();
    this.channel ??= new WidebandChannelWorker(block => { if (this.enabled) this.receiver.receiveSamples(block); },
      error => this.events.runtimeError(error), this.dependencies.createChannelWorker);
    await this.channel.configure(metadata.sessionGeneration, metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz, metadata.actualSampleRateHz);
    this.requireOpen();
  }

  begin(metadata: SourceSessionMetadata, volume: number): void {
    this.requireOpen();
    validateModeSampleRate(metadata.mode, channelSampleRate(metadata.actualSampleRateHz));
    this.route(metadata);
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.selectedFrequency = metadata.selectedChannelFrequencyHz;
    this.generation = metadata.sessionGeneration;
    this.rawAnalysis = this.analysis?.begin(metadata);
    this.setSampleRate(metadata.actualSampleRateHz);
    this.setVolume(volume);
    this.enabled = true;
  }
  /** Keep the analysis tap but reset decoder/filter histories for a new route. */
  retune(metadata: SourceSessionMetadata): void {
    this.requireOpen();
    validateModeSampleRate(metadata.mode, channelSampleRate(metadata.actualSampleRateHz));
    this.route(metadata);
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.selectedFrequency = metadata.selectedChannelFrequencyHz;
    if (this.generation === undefined) this.rawAnalysis = this.analysis?.begin(metadata);
    else this.analysis?.retune(metadata);
    this.generation = metadata.sessionGeneration;
    this.setSampleRate(metadata.actualSampleRateHz);
    this.enabled = true;
  }
  private route(metadata: SourceSessionMetadata): void {
    const digital = metadata.mode === "DAB" ? this.dab : metadata.mode === "ADS-B" ? this.adsb : metadata.mode === "AIS" ? this.ais : undefined;
    const wideband = isWidebandRate(metadata.actualSampleRateHz);
    const rate = channelSampleRate(metadata.actualSampleRateHz);
    const offset = wideband ? 0 : metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz;
    if (wideband) {
      if (!this.channel) throw new Error("Prepare the wideband channel worker before starting reception.");
      void this.channel.configure(metadata.sessionGeneration, metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz, metadata.actualSampleRateHz);
    }
    // Configure first: rate rejection cannot replace the active decoder route.
    this.receiver.setDigitalReceiver(digital, rate, offset);
    if (digital !== this.dab) this.dab.reset();
    if (digital !== this.adsb) this.adsb.reset();
    if (digital !== this.ais) this.ais.reset();
    if (!digital) this.demodulator.setMode(createSignalsMode({ mode: metadata.mode, bandwidthHz: metadata.channelBandwidthHz, squelch: metadata.squelch }));
    this.demodulator.setFrequencyOffset(offset);
    this.rds.setEnabled(metadata.mode === "WBFM");
    this.rds.setFrequencyOffset(offset);
  }
  /** Synchronous invalidation precedes every hardware await/close. */
  reset(): void {
    this.enabled = false;
    this.rawAnalysis = undefined;
    this.channel?.close(); this.channel = undefined;
    if (this.generation !== undefined) this.analysis?.stop(this.generation);
    this.generation = undefined;
    this.rds.reset(); this.dab.reset(); this.adsb.reset(); this.ais.reset();
  }
  async suspend(): Promise<void> {
    if (this.audioContext.state === "running") await this.audioContext.suspend();
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.reset();
    const task = (async () => {
      if (this.audioContext.state !== "closed") await this.audioContext.close();
      this.audioContext.removeEventListener("statechange", this.audioChanged);
      this.closed = true;
    })().finally(() => { if (this.closeTask === task) this.closeTask = undefined; });
    this.closeTask = task;
    return task;
  }
  private requireOpen(): void {
    if (this.closing) throw new DOMException("Live receiver was disconnected", "AbortError");
  }
  private readonly audioChanged = (): void => this.events.audioStateChanged(this.audioContext.state);
}
