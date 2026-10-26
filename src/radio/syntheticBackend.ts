import type { RecordingOptions } from "./channelRecording";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { SyntheticComplexTone, SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";
import { SyntheticHistorySignal } from "../testing/syntheticHistorySignal";
import type { ReceiverBackend, ReceiverBackendEvents, ReceiverStartOptions } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import { defaultModeSettings, normalizeModeSettings, planChannelTune, type ReceiverModeSettings, type ReceiverTuneOptions } from "./receiverConfig";
import { IqRecorder, preferredRecordingStorageMode, type IqRecording, type RecordingStatus } from "./iqRecording";

const DEMO_BLOCK_SIZE = 8192;

export class SyntheticBackend implements ReceiverBackend {
  private timer?: number;
  private stopped = false;
  private receiver?: SampleReceiver;
  private metadata?: SourceSessionMetadata;
  private sweepPhase = 0;
  private sweepClock = 0;
  private recorder?: IqRecorder;
  private readonly positive = new SyntheticComplexTone({
    sampleRateHz: SYNTHETIC_DEMO_SESSION.actualSampleRateHz,
    toneOffsetHz: 125_000,
    amplitude: 0.7,
  });
  private readonly negative = new SyntheticComplexTone({
    sampleRateHz: SYNTHETIC_DEMO_SESSION.actualSampleRateHz,
    toneOffsetHz: -230_000,
    amplitude: 0.22,
  });

  constructor(
    private readonly events: ReceiverBackendEvents,
    private readonly analysis: AnalysisPipeline,
    private sessionGeneration: number,
  ) {}

  async start(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const mode = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
    const metadata = {
      ...SYNTHETIC_DEMO_SESSION,
      sessionGeneration: this.sessionGeneration,
      hardwareCenterFrequencyHz: options.channelFrequencyHz,
      selectedChannelFrequencyHz: options.channelFrequencyHz,
      mode: mode.mode,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      beatToneHz: mode.beatToneHz,
      gainDb: null,
    };
    this.metadata = metadata;
    const receiver = this.analysis.begin(metadata);
    this.receiver = receiver;
    receiver.setSampleRate(metadata.actualSampleRateHz);
    const historyDemo = new URLSearchParams(window.location.search).get("demo") === "history";
    const historySignal = historyDemo ? new SyntheticHistorySignal() : undefined;
    const blockSize = historyDemo ? 16_384 : DEMO_BLOCK_SIZE;
    const generate = () => {
      if (this.stopped) return;
      const primary = this.positive.generate(blockSize);
      const secondary = this.negative.generate(blockSize);
      for (let index = 0; index < blockSize; index += 1) {
        const sweepOffsetHz = 340_000 * Math.sin(2 * Math.PI * this.sweepClock / (metadata.actualSampleRateHz * 6));
        this.sweepPhase += 2 * Math.PI * sweepOffsetHz / metadata.actualSampleRateHz;
        this.sweepClock += 1;
        primary.I[index] = (primary.I[index] ?? 0) + (secondary.I[index] ?? 0) + 0.32 * Math.cos(this.sweepPhase);
        primary.Q[index] = (primary.Q[index] ?? 0) + (secondary.Q[index] ?? 0) + 0.32 * Math.sin(this.sweepPhase);
      }
      historySignal?.mix(primary.I, primary.Q, metadata.actualSampleRateHz);
      receiver.receiveSamples({ I: primary.I, Q: primary.Q, frequency: this.metadata?.hardwareCenterFrequencyHz ?? metadata.hardwareCenterFrequencyHz });
      this.recorder?.appendNormalized({ I: primary.I, Q: primary.Q });
    };
    generate();
    this.timer = window.setInterval(generate, historyDemo ? 16 : 20);
    return metadata;
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.analysis.stop(this.sessionGeneration);
    return Promise.resolve();
  }

  setVolume(_volume: number): void {}

  tune(channelFrequencyHz: number, sessionGeneration: number, options: ReceiverTuneOptions = {}): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) return Promise.reject(new Error("Synthetic source is not running"));
    const plan = planChannelTune(
      this.metadata.hardwareCenterFrequencyHz,
      channelFrequencyHz,
      this.metadata.actualSampleRateHz,
      this.metadata.channelBandwidthHz,
      options,
    );
    this.sessionGeneration = sessionGeneration;
    this.metadata = {
      ...this.metadata,
      sessionGeneration,
      hardwareCenterFrequencyHz: plan.hardwareCenterFrequencyHz,
      selectedChannelFrequencyHz: channelFrequencyHz,
    };
    this.analysis.retune(this.metadata);
    const { sessionGeneration: _generation, ...metadata } = this.metadata;
    return Promise.resolve(metadata);
  }

  scanTune(centerFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) return Promise.reject(new Error("Synthetic source is not running"));
    this.sessionGeneration = sessionGeneration;
    this.metadata = {
      ...this.metadata,
      sessionGeneration,
      hardwareCenterFrequencyHz: centerFrequencyHz,
      selectedChannelFrequencyHz: centerFrequencyHz,
    };
    this.analysis.retune(this.metadata);
    const { sessionGeneration: _generation, ...metadata } = this.metadata;
    return Promise.resolve(metadata);
  }

  configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) return Promise.reject(new Error("Synthetic source is not running"));
    const mode = normalizeModeSettings(settings);
    this.metadata = {
      ...this.metadata,
      mode: mode.mode,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      beatToneHz: mode.beatToneHz,
    };
    return this.tune(this.metadata.selectedChannelFrequencyHz, sessionGeneration);
  }

  updateAnalogMode(settings: ReceiverModeSettings): Omit<SourceSessionMetadata, "sessionGeneration"> {
    if (!this.metadata) throw new Error("Synthetic source is not running");
    const mode = normalizeModeSettings(settings);
    if (mode.mode !== this.metadata.mode)
      throw new Error("Live analog settings cannot change receiver mode.");
    this.metadata = {
      ...this.metadata,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      beatToneHz: mode.beatToneHz,
    };
    const { sessionGeneration: _generation, ...metadata } = this.metadata;
    return metadata;
  }

  setGain(_gainDb: number | null): Promise<number | null> {
    return Promise.resolve(null);
  }

  startRecording(survey?: import("./fieldSurvey").SurveyCaptureContext, options?: RecordingOptions): RecordingStatus {
    if (!this.metadata) throw new Error("Synthetic source is not running");
    this.recorder = new IqRecorder(this.metadata, undefined, undefined, "BrowserSDR deterministic synthetic spectrum generator; quantized to CU8 for replay.", survey, undefined, preferredRecordingStorageMode(options?.storageMode), options);
    return this.recorder.status();
  }

  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user"): IqRecording | undefined {
    const recorder = this.recorder;
    this.recorder = undefined;
    return recorder?.finish(reason);
  }

  getRecordingStatus(): RecordingStatus | undefined { return this.recorder?.status(); }
}
