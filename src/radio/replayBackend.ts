import { isWidebandRate } from "./sourceCapabilities";
import { WidebandChannelFilter } from "./widebandChannel";
import { channelSampleRate } from "./sourceCapabilities";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import { ci8SessionDetails, type HackrfRecordingFormat } from "./ci8Recording";
import { validateLiveRateBudget } from "./liveRateBudget";
import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AudioPlayer } from "@jtarrio/signals/players/audioplayer.js";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { decodeRecordingSamples, recordingSampleFormat, RECORDING_FORMAT, IqRecorder, validateRecordingMetadata, type IqRecording, type RecordingStatus } from "./iqRecording";
import {
  createSignalsMode,
  normalizeModeSettings,
  planChannelTune,
  validateModeSampleRate,
  type ReceiverModeSettings,
} from "./receiverConfig";
import type { ReceiverBackend, ReceiverBackendEvents, ReceiverStartOptions } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver, type DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";
import { DabReceiver } from "../dab/dabReceiver";
import { AdsbReceiver } from "../adsb/adsbReceiver";
import { AisReceiver } from "../ais/aisReceiver";

const REPLAY_CHUNK_SAMPLES = 8192;

export class ReplayBackend implements ReceiverBackend {
  private readonly audioContext: AudioContext;
  private readonly audioResume: Promise<void>;
  private readonly demodulator: Demodulator;
  private receiver?: AudioFirstRdsReceiver;
  private channel?: WidebandChannelFilter;
  private rawAnalysis?: SampleReceiver;
  private timer?: number;
  private stopped = false;
  private position = 0;
  private startedAtMs = 0;
  private metadata?: SourceSessionMetadata;
  private recorder?: IqRecorder;
  private completedRecording?: IqRecording;
  private nextGap = 0;
  private elapsedGapSamples = 0;
  private readonly rds: RdsMultiplexReceiver;
  private readonly dab: DabReceiver;
  private readonly adsb: AdsbReceiver;
  private readonly ais: AisReceiver;

  constructor(
    private readonly events: ReceiverBackendEvents,
    private readonly analysis: AnalysisPipeline,
    private recording: IqRecording,
    private sessionGeneration: number,
  ) {
    validateRecordingMetadata(recording.metadata, recording.data.byteLength);
    this.audioContext = new AudioContext();
    this.audioContext.addEventListener("statechange", this.onAudioStateChange);
    this.audioResume = this.audioContext.resume();
    this.demodulator = new Demodulator({ player: new AudioPlayer({ newAudioContext: () => this.audioContext }) });
    this.rds = new RdsMultiplexReceiver((state) => this.events.rdsChanged(state));
    this.dab = new DabReceiver((state) => this.events.dabChanged?.(state));
    this.adsb = new AdsbReceiver((state) => this.events.adsbChanged?.(state));
    this.ais = new AisReceiver((state) => this.events.aisChanged?.(state));
  }

  async start(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const sourceMetadata = validateRecordingMetadata(this.recording.metadata, this.recording.data.byteLength);
    this.recording = { ...this.recording, metadata: sourceMetadata };
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
      gainDb: sourceMetadata.gainDb ?? null,
      ...(sourceMetadata.format !== RECORDING_FORMAT && sourceMetadata.provenanceDetails.originalSource === "hackrf" ? { hackrf: ci8SessionDetails(sourceMetadata as HackrfRecordingFormat) } : {}),
      sampleFormat: "planar-f32-iq-normalized",
    };
    if (sourceMetadata.format !== RECORDING_FORMAT) validateLiveRateBudget(channelSampleRate(metadata.actualSampleRateHz), this.audioContext.sampleRate);
    validateModeSampleRate(mode.mode, channelSampleRate(metadata.actualSampleRateHz));
    const analogMode = ["DAB", "ADS-B", "AIS"].includes(mode.mode) ? undefined : createSignalsMode(mode);
    this.metadata = metadata;
    this.demodulator.setSampleRate(channelSampleRate(metadata.actualSampleRateHz));
    if (analogMode) this.demodulator.setMode(analogMode);
    const nativeOffset = metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz;
    this.channel = isWidebandRate(metadata.actualSampleRateHz) ? new WidebandChannelFilter(nativeOffset, metadata.actualSampleRateHz) : undefined;
    const frequencyOffsetHz = this.channel ? 0 : nativeOffset;
    this.demodulator.setFrequencyOffset(frequencyOffsetHz);
    this.demodulator.setVolume(options.volume);
    this.rds.setEnabled(mode.mode === "WBFM");
    this.rds.setFrequencyOffset(frequencyOffsetHz);
    const analysisReceiver = this.analysis.begin(metadata);
    this.rawAnalysis = this.channel ? analysisReceiver : undefined;
    this.receiver = new AudioFirstRdsReceiver(this.demodulator, this.rds, this.channel ? undefined : analysisReceiver);
    this.receiver.setSampleRate(channelSampleRate(metadata.actualSampleRateHz));
    this.receiver.setDigitalReceiver(this.digitalReceiver(mode.mode), channelSampleRate(metadata.actualSampleRateHz), frequencyOffsetHz);
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
    this.finishRecording("source-stop");
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
    this.finishRecording("metadata-change");
    this.sessionGeneration = sessionGeneration;
    this.channel?.reset(plan.frequencyOffsetHz);
    this.demodulator.setFrequencyOffset(this.channel ? 0 : plan.frequencyOffsetHz);
    this.rds.setFrequencyOffset(this.channel ? 0 : plan.frequencyOffsetHz);
    this.receiver?.setDigitalReceiver(this.digitalReceiver(this.metadata.mode), channelSampleRate(this.metadata.actualSampleRateHz), this.channel ? 0 : plan.frequencyOffsetHz);
    this.metadata = { ...this.metadata, sessionGeneration, selectedChannelFrequencyHz: channelFrequencyHz };
    this.analysis.retune(this.metadata);
    const { sessionGeneration: _generation, ...result } = this.metadata;
    return result;
  }

  async configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("Replay source is not running");
    const mode = normalizeModeSettings(settings);
    validateModeSampleRate(mode.mode, channelSampleRate(this.metadata.actualSampleRateHz));
    const plan = planChannelTune(this.metadata.hardwareCenterFrequencyHz, this.metadata.selectedChannelFrequencyHz, this.metadata.actualSampleRateHz, mode.bandwidthHz);
    if (plan.hardwareRetuneRequired) throw new Error("That channel bandwidth lies outside the recorded capture span.");
    const analogMode = ["DAB", "ADS-B", "AIS"].includes(mode.mode) ? undefined : createSignalsMode(mode);
    if (analogMode) this.demodulator.setMode(analogMode);
    this.rds.setEnabled(mode.mode === "WBFM");
    this.metadata = { ...this.metadata, mode: mode.mode, channelBandwidthHz: mode.bandwidthHz, squelch: mode.squelch };
    return this.tune(this.metadata.selectedChannelFrequencyHz, sessionGeneration);
  }

  setGain(_gainDb: number | null): Promise<number | null> { return Promise.resolve(this.metadata?.gainDb ?? null); }

  startRecording(survey?: import("./fieldSurvey").SurveyCaptureContext): RecordingStatus {
    if (!this.metadata || this.stopped) throw new Error("Replay source is not running");
    if (this.recorder || this.completedRecording) throw new Error("Finish or retrieve the existing replay recording first.");
    const original = this.recording.metadata;
    const offset = this.position + this.elapsedGapSamples;
    const timestamp = new Date(Date.parse(original.captureStartedAt) + offset / original.sampleRateHz * 1000).toISOString();
    const provenance = `${(original.provenance ?? "").slice(0, 3500)} Re-recorded original bytes during replay from dataset sample ${this.position}; acquisition timestamp advanced by known sample-clock time only, excluding unknown gap durations. No new hardware observation.`;
    this.recorder = new IqRecorder(this.metadata, timestamp, undefined, provenance, survey ?? original.survey, recordingSampleFormat(original));
    return this.recorder.status();
  }

  private finishRecording(reason: "user" | "source-stop" | "metadata-change"): void {
    if (!this.recorder) return;
    const result = this.recorder.finish(reason); this.recorder = undefined;
    if (this.recording.importedSigmf) result.importedSigmf = { ...this.recording.importedSigmf };
    this.completedRecording = result;
  }
  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user"): IqRecording | undefined {
    this.finishRecording(reason);
    const result = this.completedRecording; this.completedRecording = undefined;
    return result;
  }

  getRecordingStatus(): RecordingStatus | undefined { return this.recorder?.status(); }

  private digitalReceiver(mode: ReceiverModeSettings["mode"]): DigitalSampleReceiver | undefined {
    if (mode === "DAB") return this.dab;
    if (mode === "ADS-B") return this.adsb;
    if (mode === "AIS") return this.ais;
    return undefined;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    try { this.readNext(); } catch (error) { this.events.runtimeError(error); }
  }

  private readNext(): void {
    while (this.recording.metadata.knownGaps[this.nextGap]?.afterSample === this.position) {
      const gap = this.recording.metadata.knownGaps[this.nextGap]!;
      this.demodulator.setSampleRate(channelSampleRate(this.recording.metadata.sampleRateHz));
      this.channel?.reset(this.metadata!.selectedChannelFrequencyHz - this.metadata!.hardwareCenterFrequencyHz);
      this.rds.setSampleRate(channelSampleRate(this.recording.metadata.sampleRateHz));
      this.receiver?.resetDigitalReceiver();
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
    const bytes = this.recording.data.subarray(this.position * this.recording.metadata.bytesPerComplexSample, end * this.recording.metadata.bytesPerComplexSample);
    const decoded = decodeRecordingSamples(bytes, this.recording.metadata);
    if (this.recording.metadata.sampleEncoding === "signed-8-bit") this.recorder?.appendCi8(bytes);
    else this.recorder?.appendCu8(bytes);
    if (this.channel) {
      this.rawAnalysis?.receiveSamples({ ...decoded, frequency: this.recording.metadata.centerFrequencyHz });
      const count = this.channel.process(decoded.I, decoded.Q);
      if (count) this.receiver?.receiveSamples({ I: decoded.I.subarray(0, count), Q: decoded.Q.subarray(0, count), frequency: this.metadata!.selectedChannelFrequencyHz });
    } else this.receiver?.receiveSamples({ ...decoded, frequency: this.recording.metadata.centerFrequencyHz });
    this.position = end;
    const targetMs = this.startedAtMs + (this.position + this.elapsedGapSamples) / this.recording.metadata.sampleRateHz * 1000;
    this.timer = window.setTimeout(() => this.scheduleNext(), Math.max(0, targetMs - performance.now()));
  }

  private readonly onAudioStateChange = (): void => this.events.audioStateChanged(this.audioContext.state);
}
