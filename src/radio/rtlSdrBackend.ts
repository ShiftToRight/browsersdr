import { SavedCaptureRds } from "./savedCaptureRds";
import { RtlIngress } from "./rtlIngress";
import { RTL_EXPERIMENTAL_SAMPLE_RATE_HZ, validateRtlAcceptedRate } from "./rtlSampleRate";
import type { RecordingOptions } from "./channelRecording";
import {
  LiveReceiverPipeline,
  type LiveReceiverDependencies,
} from "./liveReceiverPipeline";
import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import { RTL2832U_Provider } from "@jtarrio/webrtlsdr/rtlsdr.js";
import type {
  DirectSampling,
  RtlDevice,
} from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { RadioError, RadioErrorType } from "@jtarrio/webrtlsdr/errors.js";
import { AcknowledgedRtlSource } from "./acknowledgedRtlSource";
import { rtlTunerIdentity } from "./rtlTunerIdentity";
import { browserOwnedRtlDevice, closeBrowserUsbDevice } from "./browserUsbOwnership";
import {
  RTL_SAMPLE_RATE_HZ,
  type ReceiverBackend,
  type ReceiverBackendEvents,
  type ReceiverStartOptions,
} from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import {
  IqRecorder,
  preferredRecordingStorageMode,
  type IqRecording,
  type RecordingStatus,
} from "./iqRecording";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { validateSourceRoute } from "./sourceCapabilities";
import {
  defaultModeSettings,
  normalizeGain,
  normalizeModeSettings,
  planChannelTune,
  validateModeSampleRate,
  type ReceiverModeSettings,
  type ReceiverTuneOptions,
} from "./receiverConfig";

const PARALLEL_TRANSFERS = 2;
const BUFFERS_PER_SECOND = 20;

function isDeviceUnavailableError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "NetworkError" ||
    name === "InvalidStateError" ||
    name.includes("UsbTransferError") ||
    /unplug|disconnect|device.*(?:gone|removed|unavailable)|transfer error/i.test(
      message,
    )
  );
}

class IdempotentSource implements SignalSource {
  private closed = false;
  private closeTask?: Promise<void>;
  constructor(private readonly source: SignalSource) {}
  setSampleRate(sampleRate: number) {
    return this.source.setSampleRate(sampleRate);
  }
  setCenterFrequency(frequency: number) {
    return this.source.setCenterFrequency(frequency);
  }
  setParameter<V>(parameter: string, value: V) {
    return this.source.setParameter(parameter, value);
  }
  startReceiving() {
    return this.source.startReceiving();
  }
  readSamples(length: number) {
    return this.source.readSamples(length);
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    const task = Promise.resolve()
      .then(() => this.source.close())
      .then(() => {
        this.closed = true;
      })
      .finally(() => {
        if (this.closeTask === task) this.closeTask = undefined;
      });
    this.closeTask = task;
    return task;
  }
}

interface RtlSourceProvider {
  get(): Promise<SignalSource>;
}

export interface RtlSdrBackendDependencies extends LiveReceiverDependencies {
  createSourceProvider?: (
    permissionGranted: () => void,
    capture: (data: ArrayBuffer) => void,
    grantedDevice?: USBDevice,
  ) => RtlSourceProvider;
}

class TrackedRtlProvider {
  private readonly deviceProvider: RTL2832U_Provider;
  private usbDevice?: USBDevice;
  constructor(
    private readonly permissionGranted: () => void,
    private readonly capture: (data: ArrayBuffer) => void,
    grantedDevice?: USBDevice,
  ) {
    const nativeUsb = navigator.usb;
    const trackedUsb = {
      requestDevice: async (options: USBDeviceRequestOptions) => {
        if (!grantedDevice && !nativeUsb)
          throw new DOMException("WebUSB is unavailable", "NotSupportedError");
        this.usbDevice = grantedDevice ?? await nativeUsb!.requestDevice(options);
        return browserOwnedRtlDevice(this.usbDevice);
      },
    } as USB;
    this.deviceProvider = new RTL2832U_Provider({ webusb: trackedUsb });
  }

  async get(): Promise<SignalSource> {
    const probed = await this.deviceProvider.get().catch(async error => {
      if (this.usbDevice) await closeBrowserUsbDevice(this.usbDevice);
      throw error;
    });
    const device = new RecordingRtlDevice(
      probed,
      this.capture,
    );
    const source = new AcknowledgedRtlSource(device);
    this.permissionGranted();
    return Object.assign(source, { rtlTuner: rtlTunerIdentity(probed) });
  }
}

class RecordingRtlDevice implements RtlDevice {
  constructor(
    private readonly device: RtlDevice,
    private readonly capture: (data: ArrayBuffer) => void,
  ) {}
  setSampleRate(rate: number) {
    return this.device.setSampleRate(rate);
  }
  setFrequencyCorrection(ppm: number) {
    return this.device.setFrequencyCorrection(ppm);
  }
  getFrequencyCorrection() {
    return this.device.getFrequencyCorrection();
  }
  setGain(gain: number | null) {
    return this.device.setGain(gain);
  }
  getGain() {
    return this.device.getGain();
  }
  setCenterFrequency(freq: number) {
    return this.device.setCenterFrequency(freq);
  }
  setDirectSamplingMethod(method: DirectSampling) {
    return this.device.setDirectSamplingMethod(method);
  }
  getDirectSamplingMethod() {
    return this.device.getDirectSamplingMethod();
  }
  enableBiasTee(enable: boolean) {
    return this.device.enableBiasTee(enable);
  }
  isBiasTeeEnabled() {
    return this.device.isBiasTeeEnabled();
  }
  resetBuffer() {
    return this.device.resetBuffer();
  }
  async readSamples(length: number) {
    const block = await this.device.readSamples(length);
    this.capture(block.data);
    return block;
  }
  close() {
    return this.device.close();
  }
}

/** RTL backend whose USB source remains open while reception is stopped. */
export class RtlSdrBackend implements ReceiverBackend {
  private readonly ingress = new RtlIngress();
  getIngressDiagnostics() { return this.ingress.snapshot(); }
  private rtlTuner?: SourceSessionMetadata["rtlTuner"];
  private readonly pipeline: LiveReceiverPipeline;
  private provider: RtlSourceProvider;
  private source?: IdempotentSource;
  private metadata?: Omit<SourceSessionMetadata, "sessionGeneration">;
  private modeSettings = defaultModeSettings("WBFM");
  private recorder?: IqRecorder;
  private captureRds?: SavedCaptureRds;
  private receiving = false;
  private disconnected = false;
  private disconnectRequested = false;
  private connectTask?: Promise<
    Omit<SourceSessionMetadata, "sessionGeneration">
  >;
  private startTask?: Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  private disconnectTask?: Promise<void>;
  private streamTasks: Promise<void>[] = [];
  private receptionEpoch = 0;
  private rateTask?: Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  private gainTask?: Promise<number | null>;
  private stopTask?: Promise<void>;
  private streamFailureReported = false;
  private sourceUnavailable = false;

  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    initialChannelFrequencyHz = 100_000_000,
    private readonly dependencies: RtlSdrBackendDependencies = {},
  ) {
    if (!navigator.usb)
      throw new RadioError(
        "This browser does not support the WebUSB API",
        RadioErrorType.NoUsbSupport,
      );
    this.pipeline = new LiveReceiverPipeline(events, analysis, dependencies);
    this.provider =
      dependencies.createSourceProvider?.(events.permissionGranted, (data) =>
        this.appendCaptureBytes(data),
      ) ??
      new TrackedRtlProvider(events.permissionGranted, (data) =>
        this.appendCaptureBytes(data),
      );
    this.metadata = {
      source: "rtl-sdr",
      requestedSampleRateHz: RTL_SAMPLE_RATE_HZ,
      actualSampleRateHz: RTL_SAMPLE_RATE_HZ,
      hardwareCenterFrequencyHz: initialChannelFrequencyHz,
      selectedChannelFrequencyHz: initialChannelFrequencyHz,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
      beatToneHz: this.modeSettings.beatToneHz,
      textModem: this.modeSettings.textModem, pocsag: this.modeSettings.pocsag,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    };
  }

  async connect(
    options: ReceiverStartOptions,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.disconnectRequested || this.disconnected)
      throw new DOMException(
        "The RTL-SDR backend was disconnected",
        "InvalidStateError",
      );
    if (this.source) return this.configureConnectedSource(options);
    if (this.connectTask) return this.connectTask;
    const task = this.acquireAndConfigure(options)
      .catch((error: unknown) => {
        // A device can disappear, be re-enumerated, or become inaccessible
        // before streaming begins. Remember that the owned USB handle is dead
        // so graceful close register writes cannot pin this backend forever.
        if (isDeviceUnavailableError(error)) this.sourceUnavailable = true;
        throw error;
      })
      .finally(() => {
        if (this.connectTask === task) this.connectTask = undefined;
      });
    this.connectTask = task;
    return task;
  }

  connectGranted(
    options: ReceiverStartOptions,
    device: USBDevice,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.source || this.connectTask) return this.connect(options);
    this.provider =
      this.dependencies.createSourceProvider?.(
        this.events.permissionGranted,
        (data) => this.appendCaptureBytes(data),
        device,
      ) ??
      new TrackedRtlProvider(
        this.events.permissionGranted,
        (data) => this.appendCaptureBytes(data),
        device,
      );
    return this.connect(options);
  }

  start(
    options: ReceiverStartOptions,
    sessionGeneration = this.sessionGeneration,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.receiving) return Promise.resolve(this.metadata!);
    if (this.startTask) return this.startTask;
    const task = this.startReception(options, sessionGeneration).finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  private async startReception(
    options: ReceiverStartOptions,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.disconnectRequested)
      throw new DOMException(
        "The RTL-SDR backend was disconnected",
        "InvalidStateError",
      );
    this.sessionGeneration = sessionGeneration;
    // Invoke resume before the first await so the Start button's user activation
    // is still available to Web Audio.
    const audioResume = this.pipeline.resume();
    const [metadata] = await Promise.all([this.connect(options), audioResume]);
    this.throwIfDisconnectRequested();
    const modeSettings = normalizeModeSettings(
      options.modeSettings ?? defaultModeSettings("WBFM"),
    );
    validateModeSampleRate(modeSettings.mode, metadata.actualSampleRateHz);
    this.modeSettings = modeSettings;
    if (["POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"].includes(({ ...metadata, sessionGeneration }).mode)) {
      await this.pipeline.prepare({ ...metadata, sessionGeneration });
      this.throwIfDisconnectRequested();
    }
    this.pipeline.begin({ ...metadata, sessionGeneration }, options.volume);
    this.pipeline.requireRunning();
    try {
      await this.source!.startReceiving();
    } catch (error) {
      if (isDeviceUnavailableError(error)) this.sourceUnavailable = true;
      throw error;
    }
    this.throwIfDisconnectRequested();
    this.receiving = true;
    this.streamFailureReported = false;
    this.sourceUnavailable = false;
    this.launchTransfers(metadata.actualSampleRateHz);
    return metadata;
  }

  private launchTransfers(sampleRateHz: number): void {
    this.ingress.begin(sampleRateHz);
    const epoch = ++this.receptionEpoch;
    const samplesPerBuffer =
      512 * Math.ceil(sampleRateHz / BUFFERS_PER_SECOND / 512);
    this.streamTasks = Array.from({ length: PARALLEL_TRANSFERS }, () =>
      this.pump(samplesPerBuffer, epoch),
    );
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.receiving && !this.rateTask && this.streamTasks.length === 0) return Promise.resolve();
    this.receiving = false;
    this.ingress.end();
    ++this.receptionEpoch;
    const pendingRate = this.rateTask;
    const task = (async () => {
      try {
        if (pendingRate) await pendingRate;
      } catch (error) {
        if (!(this.disconnectRequested && error instanceof DOMException && error.name === "AbortError")) throw error;
      } finally {
        await Promise.allSettled(this.streamTasks);
        this.streamTasks = [];
        this.pipeline.reset();
        await this.pipeline.suspend().catch(() => undefined);
      }
    })().finally(() => { if (this.stopTask === task) this.stopTask = undefined; });
    this.stopTask = task;
    return task;
  }

  configureSampleRate(
    sampleRateHz: number,
    sessionGeneration: number,
    options: ReceiverTuneOptions = {},
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.rateTask) return Promise.reject(new Error("A sample-rate change is already in progress."));
    const source = this.source;
    const previous = this.metadata;
    if (!source || !previous || !this.receiving || this.disconnectRequested || this.stopTask)
      return Promise.reject(new Error("RTL-SDR reception must be running before changing rate."));
    // Reject incompatible modes/passbands without disturbing the running stream.
    try {
      validateSourceRoute("rtl-sdr", this.modeSettings, sampleRateHz, previous.selectedChannelFrequencyHz);
      planChannelTune(previous.hardwareCenterFrequencyHz, previous.selectedChannelFrequencyHz,
        sampleRateHz, previous.channelBandwidthHz, options);
    } catch (error) { return Promise.reject(error); }
    if (this.recorder) return Promise.reject(new Error("Finish the recording before changing rate."));
    this.receiving = false;
    this.ingress.end();
    const epoch = ++this.receptionEpoch;
    const oldTransfers = this.streamTasks;
    const pendingGain = this.gainTask;
    const task = (async () => {
      // Drain all reads before register writes. Their bytes cannot reach DSP or a
      // new recording. Do not suspend/resume Web Audio or reopen the USB source.
      await Promise.all([...oldTransfers, ...(pendingGain ? [pendingGain] : [])]);
      this.throwIfDisconnectRequested();
      const actualSampleRateHz = await source.setSampleRate(sampleRateHz);
      this.validateAcceptedRate(sampleRateHz, actualSampleRateHz);
      this.throwIfDisconnectRequested();
      validateSourceRoute("rtl-sdr", this.modeSettings, actualSampleRateHz, previous.selectedChannelFrequencyHz);
      const plan = planChannelTune(previous.hardwareCenterFrequencyHz, previous.selectedChannelFrequencyHz,
        actualSampleRateHz, previous.channelBandwidthHz, options);
      const hardwareCenterFrequencyHz = plan.hardwareRetuneRequired
        ? await source.setCenterFrequency(plan.hardwareCenterFrequencyHz)
        : previous.hardwareCenterFrequencyHz;
      this.throwIfDisconnectRequested();
      planChannelTune(hardwareCenterFrequencyHz, previous.selectedChannelFrequencyHz,
        actualSampleRateHz, previous.channelBandwidthHz, { autoRecenter: false });
      await source.startReceiving(); // Flush old-rate device FIFO before new reads.
      this.throwIfDisconnectRequested();
      this.metadata = { ...previous, requestedSampleRateHz: sampleRateHz,
        actualSampleRateHz, hardwareCenterFrequencyHz, gainDb: this.metadata!.gainDb };
      this.sessionGeneration = sessionGeneration;
      if (epoch === this.receptionEpoch) {
        if (["POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"].includes(({ ...this.metadata, sessionGeneration }).mode)) {
          await this.pipeline.prepare({ ...this.metadata, sessionGeneration });
          this.throwIfDisconnectRequested();
        }
        this.pipeline.retune({ ...this.metadata, sessionGeneration });
        this.pipeline.markDiscontinuity(null);
        this.receiving = true;
        this.streamFailureReported = false;
        this.launchTransfers(actualSampleRateHz);
      }
      return this.metadata;
    })().catch((error: unknown) => {
      if (isDeviceUnavailableError(error)) this.sourceUnavailable = true;
      throw error;
    }).finally(() => { if (this.rateTask === task) this.rateTask = undefined; });
    this.rateTask = task;
    return task;
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

  selectDabService(key: string): void { this.pipeline.selectDabService(key); }

  setVolume(volume: number): void {
    this.pipeline.setVolume(volume);
  }

  async tune(
    channelFrequencyHz: number,
    sessionGeneration: number,
    options: ReceiverTuneOptions = {},
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source;
    if (!this.metadata || !source)
      throw new Error("RTL-SDR source is not connected");
    this.sessionGeneration = sessionGeneration;
    const plan = planChannelTune(
      this.metadata.hardwareCenterFrequencyHz,
      channelFrequencyHz,
      this.metadata.actualSampleRateHz,
      this.modeSettings.bandwidthHz,
      options,
    );
    const provisional = {
      ...this.metadata,
      selectedChannelFrequencyHz: channelFrequencyHz,
    };
    this.pipeline.reset();
    if (plan.hardwareRetuneRequired) {
      this.pipeline.demodulator.expectFrequencyAndSetOffset(
        plan.hardwareCenterFrequencyHz,
        plan.frequencyOffsetHz,
      );
      const actualFrequencyHz = await source.setCenterFrequency(
        plan.hardwareCenterFrequencyHz,
      );
      this.pipeline.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
      this.pipeline.demodulator.setFrequencyOffset(
        channelFrequencyHz - actualFrequencyHz,
      );
      provisional.hardwareCenterFrequencyHz = actualFrequencyHz;
    } else {
      this.pipeline.demodulator.setFrequencyOffset(plan.frequencyOffsetHz);
    }
    planChannelTune(provisional.hardwareCenterFrequencyHz, channelFrequencyHz, this.metadata.actualSampleRateHz, this.modeSettings.bandwidthHz, { autoRecenter: false });
    this.metadata = provisional;
    if (["POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"].includes(({ ...provisional, sessionGeneration }).mode)) {
      await this.pipeline.prepare({ ...provisional, sessionGeneration });
      this.throwIfDisconnectRequested();
    }
    this.pipeline.retune({ ...provisional, sessionGeneration });
    return provisional;
  }

  async scanTune(
    centerFrequencyHz: number,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source;
    if (!this.metadata || !source || !this.receiving)
      throw new Error("RTL-SDR reception must be running before scanning");
    this.sessionGeneration = sessionGeneration;
    const provisional = {
      ...this.metadata,
      hardwareCenterFrequencyHz: centerFrequencyHz,
      selectedChannelFrequencyHz: centerFrequencyHz,
    };
    this.pipeline.reset();
    this.pipeline.demodulator.expectFrequencyAndSetOffset(centerFrequencyHz, 0);
    const actualFrequencyHz =
      await source.setCenterFrequency(centerFrequencyHz);
    this.pipeline.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
    this.pipeline.demodulator.setFrequencyOffset(
      centerFrequencyHz - actualFrequencyHz,
    );
    this.metadata = {
      ...provisional,
      hardwareCenterFrequencyHz: actualFrequencyHz,
    };
    if (["POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"].includes(({ ...this.metadata, sessionGeneration }).mode)) {
      await this.pipeline.prepare({ ...this.metadata, sessionGeneration });
      this.throwIfDisconnectRequested();
    }
    this.pipeline.retune({ ...this.metadata, sessionGeneration });
    return this.metadata;
  }

  async configureMode(
    settings: ReceiverModeSettings,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("RTL-SDR source is not connected");
    const modeSettings = normalizeModeSettings(settings);
    validateModeSampleRate(modeSettings.mode, this.metadata.actualSampleRateHz);
    this.modeSettings = modeSettings;
    this.metadata = {
      ...this.metadata,
      mode: modeSettings.mode,
      channelBandwidthHz: modeSettings.bandwidthHz,
      squelch: modeSettings.squelch,
      beatToneHz: modeSettings.beatToneHz,
      srd: modeSettings.srd, textModem: modeSettings.textModem, pocsag: modeSettings.pocsag,
    };
    return this.tune(
      this.metadata.selectedChannelFrequencyHz,
      sessionGeneration,
    );
  }

  updateAnalogMode(
    settings: ReceiverModeSettings,
  ): Omit<SourceSessionMetadata, "sessionGeneration"> {
    if (!this.metadata) throw new Error("RTL-SDR source is not receiving");
    const mode = normalizeModeSettings(settings);
    if (mode.mode !== this.metadata.mode)
      throw new Error("Live analog settings cannot change receiver mode.");
    this.modeSettings = mode;
    this.metadata = {
      ...this.metadata,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      beatToneHz: mode.beatToneHz,
    };
    this.pipeline.updateAnalogMode(mode);
    return { ...this.metadata };
  }

  setGain(gainDb: number | null): Promise<number | null> {
    const source = this.source;
    if (!source || this.rateTask || this.disconnectRequested)
      return Promise.reject(new Error("Wait for the RTL-SDR operation to finish before changing gain."));
    const pendingGain = this.gainTask;
    const task = (async () => {
      if (pendingGain) await pendingGain;
      this.throwIfDisconnectRequested();
      const configured = await source.setParameter("gain", normalizeGain(gainDb)) as number | null;
      if (this.metadata) this.metadata = { ...this.metadata, gainDb: configured };
      return configured;
    })().finally(() => { if (this.gainTask === task) this.gainTask = undefined; });
    this.gainTask = task;
    return task;
  }

  private appendCaptureBytes(input: ArrayBuffer | Uint8Array): void {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const recorder = this.recorder;
    if (!recorder) return;
    const before = recorder.status().sampleCount;
    recorder.appendCu8(data);
    const accepted = recorder.status().sampleCount - before;
    if (accepted > 0) this.captureRds?.accept(data.subarray(0, accepted * 2));
  }

  startRecording(
    survey?: import("./fieldSurvey").SurveyCaptureContext,
    options?: RecordingOptions,
  ): RecordingStatus {
    if (!this.receiving || !this.metadata)
      throw new Error("RTL-SDR source is not receiving");
    this.recorder = new IqRecorder(
      { ...this.metadata, sessionGeneration: this.sessionGeneration },
      undefined,
      undefined,
      undefined,
      survey,
      undefined,
      preferredRecordingStorageMode(options?.storageMode),
      options,
    );
    this.captureRds = !options?.captureCurrentChannel && this.metadata.mode === "WBFM"
      ? new SavedCaptureRds(this.metadata.hardwareCenterFrequencyHz, this.metadata.actualSampleRateHz, this.metadata.selectedChannelFrequencyHz)
      : undefined;
    return this.recorder.status();
  }
  stopRecording(
    reason: "user" | "source-stop" | "metadata-change" = "user",
  ): IqRecording | undefined {
    const recorder = this.recorder;
    this.recorder = undefined;
    const recording = recorder?.finish(reason);
    if (recording) recording.metadata.reception = {source_kind:"real", decoded_evidence:this.captureRds?.finish(recording.metadata.sampleCount) ?? []};
    this.captureRds = undefined;
    return recording;
  }
  getRecordingStatus(): RecordingStatus | undefined {
    const status = this.recorder?.status();
    return status ? {...status, receptionEvidence:this.captureRds?.finish(status.sampleCount)} : undefined;
  }

  private async configureConnectedSource(
    options: ReceiverStartOptions,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source!;
    this.modeSettings = normalizeModeSettings(
      options.modeSettings ?? defaultModeSettings("WBFM"),
    );
    const requestedSampleRateHz = options.sampleRateHz ?? RTL_SAMPLE_RATE_HZ;
    const actualSampleRateHz = await source.setSampleRate(
      requestedSampleRateHz,
    );
    this.validateAcceptedRate(requestedSampleRateHz, actualSampleRateHz);
    const hardwareCenterFrequencyHz = await source.setCenterFrequency(
      options.channelFrequencyHz,
    );
    const gainDb = (await source.setParameter(
      "gain",
      normalizeGain(options.gainDb ?? null),
    )) as number | null;
    await source.setParameter("frequency_correction", 0);
    await source.setParameter("direct_sampling_method", 0);
    await source.setParameter("bias_tee", false);
    this.metadata = {
      source: "rtl-sdr",
      requestedSampleRateHz,
      rtlTuner: this.rtlTuner,
      actualSampleRateHz,
      hardwareCenterFrequencyHz,
      selectedChannelFrequencyHz: options.channelFrequencyHz,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
      beatToneHz: this.modeSettings.beatToneHz,
      srd: this.modeSettings.srd,
      textModem: this.modeSettings.textModem, pocsag: this.modeSettings.pocsag,
      gainDb,
      sampleFormat: "planar-f32-iq-normalized",
    };
    return this.metadata;
  }

  private async acquireAndConfigure(
    options: ReceiverStartOptions,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const provided = await this.provider.get();
    const tuner = (provided as SignalSource & { rtlTuner?: SourceSessionMetadata["rtlTuner"] }).rtlTuner;
    this.rtlTuner = tuner === "R820T-family" || tuner === "R828D" ? tuner : undefined;
    const source = new IdempotentSource(provided);
    this.source = source;
    this.throwIfDisconnectRequested();
    const metadata = await this.configureConnectedSource(options);
    this.throwIfDisconnectRequested();
    return metadata;
  }

  private throwIfDisconnectRequested(): void {
    if (this.disconnectRequested)
      throw new DOMException("RTL-SDR startup was cancelled", "AbortError");
  }

  private async releaseResources(): Promise<void> {
    // Audio ownership is independent of a device chooser or source startup that
    // may still be pending, so begin releasing it immediately.
    const audioResult = Promise.allSettled([this.pipeline.close()]);
    const stopResultTask = Promise.allSettled([this.stop()]);
    const pendingStartup: Promise<unknown>[] = [];
    if (this.connectTask) pendingStartup.push(this.connectTask);
    if (this.startTask) pendingStartup.push(this.startTask);
    if (this.rateTask) pendingStartup.push(this.rateTask);
    if (this.gainTask) pendingStartup.push(this.gainTask);
    await Promise.allSettled(pendingStartup);
    const stopResult = await stopResultTask;

    const source = this.source;
    const sourceRelease = source
      ? source
          .close()
          .catch((error) => {
            // An unplugged RTL2832U cannot perform WebRTLSDR's graceful tuner
            // shutdown writes. The browser/OS has already revoked the physical
            // device, so that expected close failure must not retain a dead
            // backend forever. Other close failures remain retryable.
            if (!this.sourceUnavailable || !isDeviceUnavailableError(error))
              throw error;
          })
          .then(() => {
            if (this.source === source) this.source = undefined;
          })
      : Promise.resolve();
    const [sourceResult, settledAudioResult] = await Promise.all([
      Promise.allSettled([sourceRelease]),
      audioResult,
    ]);
    const failures = [
      ...stopResult,
      ...sourceResult,
      ...settledAudioResult,
    ].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) throw failures[0]!.reason;
    this.disconnected = true;
  }

  private async pump(samplesPerBuffer: number, epoch: number): Promise<void> {
    while (this.receiving && epoch === this.receptionEpoch) {
      const readStartedAt = performance.now();
      let block: Awaited<ReturnType<SignalSource["readSamples"]>>;
      try {
        block = await this.source!.readSamples(samplesPerBuffer);
      } catch (error) {
        if (isDeviceUnavailableError(error)) this.sourceUnavailable = true;
        if (this.rateTask && epoch !== this.receptionEpoch && !this.disconnectRequested) throw error;
        if (epoch === this.receptionEpoch && !this.streamFailureReported) {
          this.streamFailureReported = true;
          this.events.runtimeError(error);
        }
        return;
      }
      try {
        if (this.receiving && epoch === this.receptionEpoch) {
          const startedAt = performance.now();
          if (block.frequency === this.metadata?.hardwareCenterFrequencyHz) {
            if (block.I.length !== block.Q.length || block.I.length === 0)
              throw new Error("RTL-SDR returned an empty or malformed sample block.");
            this.ingress.accept(block.I.length, startedAt - readStartedAt);
          }
          this.pipeline.receiveSamples(block);
          this.ingress.delivered(performance.now() - startedAt);
        }
      } catch (error) {
        if (this.receiving && !this.streamFailureReported) {
          this.streamFailureReported = true;
          this.events.runtimeError(error);
        }
        return;
      }
    }
  }

  private validateAcceptedRate(requested: number, actual: number): void {
    validateRtlAcceptedRate(requested, actual);
    if (requested === RTL_EXPERIMENTAL_SAMPLE_RATE_HZ)
      this.pipeline.validateRateBudget(actual);
  }
}

export function createRtlSdrBackend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  sessionGeneration = 0,
  initialChannelFrequencyHz = 100_000_000,
  dependencies?: RtlSdrBackendDependencies,
): ReceiverBackend {
  return new RtlSdrBackend(
    events,
    analysis,
    sessionGeneration,
    initialChannelFrequencyHz,
    dependencies,
  );
}
