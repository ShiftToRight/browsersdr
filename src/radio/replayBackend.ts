import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AudioPlayer } from "@jtarrio/signals/players/audioplayer.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { decodeCu8, IqRecorder, validateRecordingMetadata, type IqRecording, type RecordingStatus } from "./iqRecording";
import {
  createSignalsMode,
  normalizeModeSettings,
  planChannelTune,
  type ReceiverModeSettings,
} from "./receiverConfig";
import type { ReceiverBackend, ReceiverBackendEvents, ReceiverStartOptions } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";

const REPLAY_CHUNK_SAMPLES = 8192;

export class ReplayBackend implements ReceiverBackend {
  private readonly audioContext: AudioContext;
  private readonly audioResume: Promise<void>;
  private readonly demodulator: Demodulator;
  private receiver?: SampleReceiver;
  private timer?: number;
  private stopped = false;
  private position = 0;
  private startedAtMs = 0;
  private metadata?: SourceSessionMetadata;
  private recorder?: IqRecorder;
  private nextGap = 0;
  private elapsedGapSamples = 0;
  private readonly rds: RdsMultiplexReceiver;

  constructor(
    private readonly events: ReceiverBackendEvents,
    private readonly analysis: AnalysisPipeline,
    private readonly recording: IqRecording,
    private sessionGeneration: number,
  ) {
    this.audioContext = new AudioContext();
    this.audioContext.addEventListener("statechange", this.onAudioStateChange);
    this.audioResume = this.audioContext.resume();
    this.demodulator = new Demodulator({ player: new AudioPlayer({ newAudioContext: () => this.audioContext }) });
    this.rds = new RdsMultiplexReceiver((state) => this.events.rdsChanged(state));
  }

  async start(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const sourceMetadata = validateRecordingMetadata(this.recording.metadata, this.recording.data.byteLength);
    const mode = normalizeModeSettings({
      mode: sourceMetadata.mode,
      bandwidthHz: sourceMetadata.channelBandwidthHz,
      squelch: sourceMetadata.squelch,
    });
    const metadata: SourceSessionMetadata = {
      source: "replay",
      sessionGeneration: this.sessionGeneration,
      requestedSampleRateHz: sourceMetadata.sampleRateHz,
      actualSampleRateHz: sourceMetadata.sampleRateHz,
      hardwareCenterFrequencyHz: sourceMetadata.centerFrequencyHz,
      selectedChannelFrequencyHz: sourceMetadata.selectedChannelFrequencyHz,
      mode: mode.mode,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      gainDb: sourceMetadata.gainDb,
      sampleFormat: "planar-f32-iq-normalized",
    };
    this.metadata = metadata;
    this.demodulator.setSampleRate(metadata.actualSampleRateHz);
    this.demodulator.setMode(createSignalsMode(mode));
    this.demodulator.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    this.demodulator.setVolume(options.volume);
    this.rds.setEnabled(mode.mode === "WBFM");
    this.rds.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    const analysisReceiver = this.analysis.begin(metadata);
    this.receiver = new AudioFirstRdsReceiver(this.demodulator, this.rds, analysisReceiver);
    this.receiver.setSampleRate(metadata.actualSampleRateHz);
    await this.audioResume;
    if (this.stopped) throw new DOMException("Replay start was stopped", "AbortError");
    if (this.audioContext.state !== "running") throw new DOMException(`Audio context remained ${this.audioContext.state}`, "NotAllowedError");
    this.startedAtMs = performance.now();
    // Begin after start has published metadata, including for very short files.
    this.timer = window.setTimeout(() => this.scheduleNext(), 0);
    const { sessionGeneration: _generation, ...result } = metadata;
    return result;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.analysis.stop(this.sessionGeneration);
    this.audioContext.removeEventListener("statechange", this.onAudioStateChange);
    if (this.audioContext.state !== "closed") await this.audioContext.close().catch(() => undefined);
  }

  setVolume(volume: number): void { this.demodulator.setVolume(volume); }

  async tune(channelFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("Replay source is not running");
    const plan = planChannelTune(this.metadata.hardwareCenterFrequencyHz, channelFrequencyHz, this.metadata.actualSampleRateHz, this.metadata.channelBandwidthHz);
    if (plan.hardwareRetuneRequired) throw new Error("That channel lies outside the recorded capture span; replay cannot retune hardware.");
    this.sessionGeneration = sessionGeneration;
    this.demodulator.setFrequencyOffset(plan.frequencyOffsetHz);
    this.rds.setFrequencyOffset(plan.frequencyOffsetHz);
    this.metadata = { ...this.metadata, sessionGeneration, selectedChannelFrequencyHz: channelFrequencyHz };
    this.analysis.retune(this.metadata);
    const { sessionGeneration: _generation, ...result } = this.metadata;
    return result;
  }

  async configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("Replay source is not running");
    const mode = normalizeModeSettings(settings);
    const plan = planChannelTune(this.metadata.hardwareCenterFrequencyHz, this.metadata.selectedChannelFrequencyHz, this.metadata.actualSampleRateHz, mode.bandwidthHz);
    if (plan.hardwareRetuneRequired) throw new Error("That channel bandwidth lies outside the recorded capture span.");
    this.demodulator.setMode(createSignalsMode(mode));
    this.rds.setEnabled(mode.mode === "WBFM");
    this.metadata = { ...this.metadata, mode: mode.mode, channelBandwidthHz: mode.bandwidthHz, squelch: mode.squelch };
    return this.tune(this.metadata.selectedChannelFrequencyHz, sessionGeneration);
  }

  setGain(_gainDb: number | null): Promise<number | null> { return Promise.resolve(this.metadata?.gainDb ?? null); }

  startRecording(): RecordingStatus {
    if (!this.metadata) throw new Error("Replay source is not running");
    this.recorder = new IqRecorder(this.metadata);
    return this.recorder.status();
  }

  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user"): IqRecording | undefined {
    const recorder = this.recorder;
    this.recorder = undefined;
    return recorder?.finish(reason);
  }

  getRecordingStatus(): RecordingStatus | undefined { return this.recorder?.status(); }

  private scheduleNext(): void {
    if (this.stopped) return;
    try { this.readNext(); } catch (error) { this.events.runtimeError(error); }
  }

  private readNext(): void {
    while (this.recording.metadata.knownGaps[this.nextGap]?.afterSample === this.position) {
      const gap = this.recording.metadata.knownGaps[this.nextGap]!;
      this.demodulator.setSampleRate(this.recording.metadata.sampleRateHz);
      this.rds.setSampleRate(this.recording.metadata.sampleRateHz);
      this.analysis.markDiscontinuity(gap.missingSamples ?? 0);
      this.recorder?.addGap(gap.missingSamples, `Replayed source gap: ${gap.reason}`);
      this.elapsedGapSamples += gap.missingSamples ?? 0;
      this.nextGap += 1;
    }
    const dueMs = this.startedAtMs + (this.position + this.elapsedGapSamples) / this.recording.metadata.sampleRateHz * 1000;
    const delayMs = dueMs - performance.now();
    if (delayMs > 0) {
      this.timer = window.setTimeout(() => this.scheduleNext(), Math.max(1, delayMs));
      return;
    }
    if (this.position >= this.recording.metadata.sampleCount) {
      this.events.sourceEnded();
      return;
    }
    const gapPosition = this.recording.metadata.knownGaps[this.nextGap]?.afterSample;
    const end = Math.min(
      this.recording.metadata.sampleCount,
      this.position + REPLAY_CHUNK_SAMPLES,
      gapPosition ?? Number.POSITIVE_INFINITY,
    );
    if (end <= this.position) throw new Error("Replay gap metadata would move playback backward.");
    const bytes = this.recording.data.subarray(this.position * 2, end * 2);
    const decoded = decodeCu8(bytes);
    this.recorder?.appendCu8(bytes);
    this.receiver?.receiveSamples({ ...decoded, frequency: this.recording.metadata.centerFrequencyHz });
    this.position = end;
    const targetMs = this.startedAtMs + (this.position + this.elapsedGapSamples) / this.recording.metadata.sampleRateHz * 1000;
    this.timer = window.setTimeout(() => this.scheduleNext(), Math.max(0, targetMs - performance.now()));
  }

  private readonly onAudioStateChange = (): void => this.events.audioStateChanged(this.audioContext.state);
}
