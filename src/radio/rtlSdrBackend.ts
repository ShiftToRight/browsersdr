import { LiveReceiverPipeline, type LiveReceiverDependencies } from "./liveReceiverPipeline";
import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import { RTL2832U_Provider } from "@jtarrio/webrtlsdr/rtlsdr.js";
import type { DirectSampling, RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { RadioError, RadioErrorType } from "@jtarrio/webrtlsdr/errors.js";
import { AcknowledgedRtlSource } from "./acknowledgedRtlSource";
import {
  RTL_SAMPLE_RATE_HZ,
  type ReceiverBackend,
  type ReceiverBackendEvents,
  type ReceiverStartOptions,
} from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import { IqRecorder, type IqRecording, type RecordingStatus } from "./iqRecording";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import {
  defaultModeSettings,
  normalizeGain,
  normalizeModeSettings,
  planChannelTune,
  validateModeSampleRate,
  type ReceiverModeSettings,
} from "./receiverConfig";

const PARALLEL_TRANSFERS = 2;
const BUFFERS_PER_SECOND = 20;

class IdempotentSource implements SignalSource {
  private closed = false;
  private closeTask?: Promise<void>;
  constructor(private readonly source: SignalSource) {}
  setSampleRate(sampleRate: number) { return this.source.setSampleRate(sampleRate); }
  setCenterFrequency(frequency: number) { return this.source.setCenterFrequency(frequency); }
  setParameter<V>(parameter: string, value: V) { return this.source.setParameter(parameter, value); }
  startReceiving() { return this.source.startReceiving(); }
  readSamples(length: number) { return this.source.readSamples(length); }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    const task = Promise.resolve().then(() => this.source.close()).then(() => {
      this.closed = true;
    }).finally(() => {
      if (this.closeTask === task) this.closeTask = undefined;
    });
    this.closeTask = task;
    return task;
  }
}

interface RtlSourceProvider { get(): Promise<SignalSource> }

export interface RtlSdrBackendDependencies extends LiveReceiverDependencies {
  createSourceProvider?: (
    permissionGranted: () => void,
    capture: (data: ArrayBuffer) => void,
  ) => RtlSourceProvider;
}

class TrackedRtlProvider {
  private readonly deviceProvider: RTL2832U_Provider;
  constructor(
    private readonly permissionGranted: () => void,
    private readonly capture: (data: ArrayBuffer) => void,
  ) {
    const nativeUsb = navigator.usb;
    const trackedUsb = {
      requestDevice: async (options: USBDeviceRequestOptions) => {
        if (!nativeUsb) throw new DOMException("WebUSB is unavailable", "NotSupportedError");
        return nativeUsb.requestDevice(options);
      },
    } as USB;
    this.deviceProvider = new RTL2832U_Provider({ webusb: trackedUsb });
  }

  async get(): Promise<SignalSource> {
    const device = new RecordingRtlDevice(await this.deviceProvider.get(), this.capture);
    const source = new AcknowledgedRtlSource(device);
    this.permissionGranted();
    return source;
  }
}

class RecordingRtlDevice implements RtlDevice {
  constructor(private readonly device: RtlDevice, private readonly capture: (data: ArrayBuffer) => void) {}
  setSampleRate(rate: number) { return this.device.setSampleRate(rate); }
  setFrequencyCorrection(ppm: number) { return this.device.setFrequencyCorrection(ppm); }
  getFrequencyCorrection() { return this.device.getFrequencyCorrection(); }
  setGain(gain: number | null) { return this.device.setGain(gain); }
  getGain() { return this.device.getGain(); }
  setCenterFrequency(freq: number) { return this.device.setCenterFrequency(freq); }
  setDirectSamplingMethod(method: DirectSampling) { return this.device.setDirectSamplingMethod(method); }
  getDirectSamplingMethod() { return this.device.getDirectSamplingMethod(); }
  enableBiasTee(enable: boolean) { return this.device.enableBiasTee(enable); }
  isBiasTeeEnabled() { return this.device.isBiasTeeEnabled(); }
  resetBuffer() { return this.device.resetBuffer(); }
  async readSamples(length: number) {
    const block = await this.device.readSamples(length);
    this.capture(block.data);
    return block;
  }
  close() { return this.device.close(); }
}

/** RTL backend whose USB source remains open while reception is stopped. */
export class RtlSdrBackend implements ReceiverBackend {
  private readonly pipeline: LiveReceiverPipeline;
  private readonly provider: RtlSourceProvider;
  private source?: IdempotentSource;
  private metadata?: Omit<SourceSessionMetadata, "sessionGeneration">;
  private modeSettings = defaultModeSettings("WBFM");
  private recorder?: IqRecorder;
  private receiving = false;
  private disconnected = false;
  private disconnectRequested = false;
  private connectTask?: Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  private startTask?: Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  private disconnectTask?: Promise<void>;
  private streamTasks: Promise<void>[] = [];
  private streamFailureReported = false;

  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    initialChannelFrequencyHz = 100_000_000,
    dependencies: RtlSdrBackendDependencies = {},
  ) {
    if (!navigator.usb) throw new RadioError("This browser does not support the WebUSB API", RadioErrorType.NoUsbSupport);
    this.pipeline = new LiveReceiverPipeline(events, analysis, dependencies);
    this.provider = dependencies.createSourceProvider?.(events.permissionGranted, (data) => this.recorder?.appendCu8(data))
      ?? new TrackedRtlProvider(events.permissionGranted, (data) => this.recorder?.appendCu8(data));
    this.metadata = {
      source: "rtl-sdr",
      requestedSampleRateHz: RTL_SAMPLE_RATE_HZ,
      actualSampleRateHz: RTL_SAMPLE_RATE_HZ,
      hardwareCenterFrequencyHz: initialChannelFrequencyHz,
      selectedChannelFrequencyHz: initialChannelFrequencyHz,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    };
  }

  async connect(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.disconnectRequested || this.disconnected) throw new DOMException("The RTL-SDR backend was disconnected", "InvalidStateError");
    if (this.source) return this.configureConnectedSource(options);
    if (this.connectTask) return this.connectTask;
    const task = this.acquireAndConfigure(options).finally(() => {
      if (this.connectTask === task) this.connectTask = undefined;
    });
    this.connectTask = task;
    return task;
  }

  start(options: ReceiverStartOptions, sessionGeneration = this.sessionGeneration): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.receiving) return Promise.resolve(this.metadata!);
    if (this.startTask) return this.startTask;
    const task = this.startReception(options, sessionGeneration).finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  private async startReception(options: ReceiverStartOptions, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.disconnectRequested) throw new DOMException("The RTL-SDR backend was disconnected", "InvalidStateError");
    this.sessionGeneration = sessionGeneration;
    // Invoke resume before the first await so the Start button's user activation
    // is still available to Web Audio.
    const audioResume = this.pipeline.resume();
    const [metadata] = await Promise.all([this.connect(options), audioResume]);
    this.throwIfDisconnectRequested();
    const modeSettings = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
    validateModeSampleRate(modeSettings.mode, metadata.actualSampleRateHz);
    this.modeSettings = modeSettings;
    this.pipeline.begin({ ...metadata, sessionGeneration }, options.volume);
    this.pipeline.requireRunning();
    await this.source!.startReceiving();
    this.throwIfDisconnectRequested();
    this.receiving = true;
    this.streamFailureReported = false;
    const samplesPerBuffer = 512 * Math.ceil(metadata.actualSampleRateHz / BUFFERS_PER_SECOND / 512);
    this.streamTasks = Array.from({ length: PARALLEL_TRANSFERS }, () => this.pump(samplesPerBuffer));
    return metadata;
  }

  async stop(): Promise<void> {
    if (!this.receiving) return;
    this.receiving = false;
    await Promise.allSettled(this.streamTasks);
    this.streamTasks = [];
    this.pipeline.reset();
    await this.pipeline.suspend().catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnectRequested = true;
    if (this.disconnectTask) return this.disconnectTask;
    const task = this.releaseResources().finally(() => {
      if (this.disconnectTask === task) this.disconnectTask = undefined;
    });
    this.disconnectTask = task;
    return task;
  }

  setVolume(volume: number): void { this.pipeline.setVolume(volume); }

  async tune(channelFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source;
    if (!this.metadata || !source) throw new Error("RTL-SDR source is not connected");
    this.sessionGeneration = sessionGeneration;
    const plan = planChannelTune(this.metadata.hardwareCenterFrequencyHz, channelFrequencyHz, this.metadata.actualSampleRateHz, this.modeSettings.bandwidthHz);
    const provisional = { ...this.metadata, selectedChannelFrequencyHz: channelFrequencyHz };
    this.pipeline.reset();
    if (plan.hardwareRetuneRequired) {
      this.pipeline.demodulator.expectFrequencyAndSetOffset(plan.hardwareCenterFrequencyHz, plan.frequencyOffsetHz);
      const actualFrequencyHz = await source.setCenterFrequency(plan.hardwareCenterFrequencyHz);
      this.pipeline.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
      this.pipeline.demodulator.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      provisional.hardwareCenterFrequencyHz = actualFrequencyHz;
    } else {
      this.pipeline.demodulator.setFrequencyOffset(plan.frequencyOffsetHz);
    }
    this.metadata = provisional;
    this.pipeline.retune({ ...provisional, sessionGeneration });
    return provisional;
  }

  async scanTune(centerFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source;
    if (!this.metadata || !source || !this.receiving) throw new Error("RTL-SDR reception must be running before scanning");
    this.sessionGeneration = sessionGeneration;
    const provisional = {
      ...this.metadata,
      hardwareCenterFrequencyHz: centerFrequencyHz,
      selectedChannelFrequencyHz: centerFrequencyHz,
    };
    this.pipeline.reset();
    this.pipeline.demodulator.expectFrequencyAndSetOffset(centerFrequencyHz, 0);
    const actualFrequencyHz = await source.setCenterFrequency(centerFrequencyHz);
    this.pipeline.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
    this.pipeline.demodulator.setFrequencyOffset(centerFrequencyHz - actualFrequencyHz);
    this.metadata = {
      ...provisional,
      hardwareCenterFrequencyHz: actualFrequencyHz,
    };
    this.pipeline.retune({ ...this.metadata, sessionGeneration });
    return this.metadata;
  }

  async configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("RTL-SDR source is not connected");
    const modeSettings = normalizeModeSettings(settings);
    validateModeSampleRate(modeSettings.mode, this.metadata.actualSampleRateHz);
    this.modeSettings = modeSettings;
    this.metadata = { ...this.metadata, mode: modeSettings.mode, channelBandwidthHz: modeSettings.bandwidthHz, squelch: modeSettings.squelch };
    return this.tune(this.metadata.selectedChannelFrequencyHz, sessionGeneration);
  }

  async setGain(gainDb: number | null): Promise<number | null> {
    if (!this.source) throw new Error("RTL-SDR source is not connected");
    const configured = await this.source.setParameter("gain", normalizeGain(gainDb)) as number | null;
    if (this.metadata) this.metadata = { ...this.metadata, gainDb: configured };
    return configured;
  }

  startRecording(survey?: import("./fieldSurvey").SurveyCaptureContext): RecordingStatus {
    if (!this.receiving || !this.metadata) throw new Error("RTL-SDR source is not receiving");
    this.recorder = new IqRecorder({ ...this.metadata, sessionGeneration: this.sessionGeneration }, undefined, undefined, undefined, survey);
    return this.recorder.status();
  }
  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user"): IqRecording | undefined {
    const recorder = this.recorder;
    this.recorder = undefined;
    return recorder?.finish(reason);
  }
  getRecordingStatus(): RecordingStatus | undefined { return this.recorder?.status(); }

  private async configureConnectedSource(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source!;
    this.modeSettings = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
    const requestedSampleRateHz = options.sampleRateHz ?? RTL_SAMPLE_RATE_HZ;
    const actualSampleRateHz = await source.setSampleRate(requestedSampleRateHz);
    const hardwareCenterFrequencyHz = await source.setCenterFrequency(options.channelFrequencyHz);
    const gainDb = await source.setParameter("gain", normalizeGain(options.gainDb ?? null)) as number | null;
    await source.setParameter("frequency_correction", 0);
    await source.setParameter("direct_sampling_method", 0);
    await source.setParameter("bias_tee", false);
    this.metadata = {
      source: "rtl-sdr", requestedSampleRateHz, actualSampleRateHz,
      hardwareCenterFrequencyHz, selectedChannelFrequencyHz: options.channelFrequencyHz,
      mode: this.modeSettings.mode, channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch, gainDb, sampleFormat: "planar-f32-iq-normalized",
    };
    return this.metadata;
  }

  private async acquireAndConfigure(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = new IdempotentSource(await this.provider.get());
    this.source = source;
    this.throwIfDisconnectRequested();
    const metadata = await this.configureConnectedSource(options);
    this.throwIfDisconnectRequested();
    return metadata;
  }

  private throwIfDisconnectRequested(): void {
    if (this.disconnectRequested) throw new DOMException("RTL-SDR startup was cancelled", "AbortError");
  }

  private async releaseResources(): Promise<void> {
    // Audio ownership is independent of a device chooser or source startup that
    // may still be pending, so begin releasing it immediately.
    const audioResult = Promise.allSettled([this.pipeline.close()]);
    const stopResultTask = Promise.allSettled([this.stop()]);
    const pendingStartup: Promise<unknown>[] = [];
    if (this.connectTask) pendingStartup.push(this.connectTask);
    if (this.startTask) pendingStartup.push(this.startTask);
    await Promise.allSettled(pendingStartup);
    const stopResult = await stopResultTask;

    const source = this.source;
    const sourceRelease = source
      ? source.close().then(() => {
        if (this.source === source) this.source = undefined;
      })
      : Promise.resolve();
    const [sourceResult, settledAudioResult] = await Promise.all([Promise.allSettled([sourceRelease]), audioResult]);
    const failures = [...stopResult, ...sourceResult, ...settledAudioResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw failures[0]!.reason;
    this.disconnected = true;
  }

  private async pump(samplesPerBuffer: number): Promise<void> {
    while (this.receiving) {
      try {
        const block = await this.source!.readSamples(samplesPerBuffer);
        if (this.receiving) this.pipeline.receiveSamples(block);
      } catch (error) {
        if (this.receiving && !this.streamFailureReported) {
          this.streamFailureReported = true;
          this.events.runtimeError(error);
        }
        return;
      }
    }
  }

}

export function createRtlSdrBackend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  sessionGeneration = 0,
  initialChannelFrequencyHz = 100_000_000,
  dependencies?: RtlSdrBackendDependencies,
): ReceiverBackend {
  return new RtlSdrBackend(events, analysis, sessionGeneration, initialChannelFrequencyHz, dependencies);
}
