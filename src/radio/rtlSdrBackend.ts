import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AudioPlayer } from "@jtarrio/signals/players/audioplayer.js";
import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import { Radio, RtlProvider, type RadioEvent } from "@jtarrio/webrtlsdr/radio.js";
import { RTL2832U_Provider } from "@jtarrio/webrtlsdr/rtlsdr.js";
import { AcknowledgedRtlSource } from "./acknowledgedRtlSource";
import type { DirectSampling, RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { RadioError, RadioErrorType } from "@jtarrio/webrtlsdr/errors.js";
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
  createSignalsMode,
  defaultModeSettings,
  normalizeGain,
  normalizeModeSettings,
  planChannelTune,
  type ReceiverModeSettings,
} from "./receiverConfig";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";

class IdempotentSource implements SignalSource {
  private closed = false;

  constructor(private readonly source: SignalSource) {}

  setSampleRate(sampleRate: number) { return this.source.setSampleRate(sampleRate); }
  setCenterFrequency(frequency: number) { return this.source.setCenterFrequency(frequency); }
  setParameter<V>(parameter: string, value: V) { return this.source.setParameter(parameter, value); }
  startReceiving() { return this.source.startReceiving(); }
  readSamples(length: number) { return this.source.readSamples(length); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.source.close();
  }
}

class TrackedRtlProvider extends RtlProvider {
  private source?: IdempotentSource;

  constructor(
    private readonly selectedDevice: (device: USBDevice) => void,
    private readonly permissionGranted: () => void,
    private readonly capture: (data: ArrayBuffer) => void,
  ) {
    const nativeUsb = navigator.usb;
    const trackedUsb = {
      requestDevice: async (options: USBDeviceRequestOptions) => {
        if (!nativeUsb) throw new DOMException("WebUSB is unavailable", "NotSupportedError");
        const device = await nativeUsb.requestDevice(options);
        selectedDevice(device);
        return device;
      },
    } as USB;
    const deviceProvider = new RTL2832U_Provider({ webusb: trackedUsb });
    super(deviceProvider);
    this.deviceProvider = deviceProvider;
  }

  private readonly deviceProvider: RTL2832U_Provider;

  override async get(): Promise<SignalSource> {
    const device = new RecordingRtlDevice(await this.deviceProvider.get(), this.capture);
    const source = new IdempotentSource(new AcknowledgedRtlSource(device));
    this.source = source;
    this.permissionGranted();
    return source;
  }

  closeCurrent(): Promise<void> {
    return this.source?.close() ?? Promise.resolve();
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

export class RtlSdrBackend implements ReceiverBackend {
  private readonly audioContext: AudioContext;
  private readonly audioResume: Promise<void>;
  private readonly demodulator: Demodulator;
  private readonly provider: TrackedRtlProvider;
  private readonly radio: Radio;
  private selectedUsbDevice?: USBDevice;
  private stopTask?: Promise<void>;
  private startSettled = false;
  private rejectStart?: (error: unknown) => void;
  private startedListener?: (event: Event) => void;
  private metadata?: Omit<SourceSessionMetadata, "sessionGeneration">;
  private modeSettings = defaultModeSettings("WBFM");
  private recorder?: IqRecorder;
  private readonly rds: RdsMultiplexReceiver;

  constructor(
    private readonly events: ReceiverBackendEvents,
    private readonly analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    initialChannelFrequencyHz = 100_000_000,
  ) {
    if (!navigator.usb) {
      throw new RadioError("This browser does not support the WebUSB API", RadioErrorType.NoUsbSupport);
    }
    this.audioContext = new AudioContext();
    this.audioContext.addEventListener("statechange", this.onAudioStateChange);
    this.audioResume = this.audioContext.resume();
    const player = new AudioPlayer({ newAudioContext: () => this.audioContext });
    this.demodulator = new Demodulator({ player });
    this.demodulator.setMode(createSignalsMode(this.modeSettings));
    this.provider = new TrackedRtlProvider(
      (device) => { this.selectedUsbDevice = device; },
      events.permissionGranted,
      (data) => this.recorder?.appendCu8(data),
    );
    this.rds = new RdsMultiplexReceiver((state) => this.events.rdsChanged(state));
    const analysisReceiver = analysis?.begin({
      source: "rtl-sdr",
      sessionGeneration,
      requestedSampleRateHz: RTL_SAMPLE_RATE_HZ,
      actualSampleRateHz: RTL_SAMPLE_RATE_HZ,
      hardwareCenterFrequencyHz: initialChannelFrequencyHz,
      selectedChannelFrequencyHz: initialChannelFrequencyHz,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    });
    this.radio = new Radio(this.provider, new AudioFirstRdsReceiver(this.demodulator, this.rds, analysisReceiver));
    this.radio.addEventListener("radio", this.onRadioEvent);
  }

  async start(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    this.modeSettings = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
    const gainDb = normalizeGain(options.gainDb ?? null);
    this.demodulator.setMode(createSignalsMode(this.modeSettings));
    this.demodulator.setVolume(options.volume);
    this.demodulator.setFrequencyOffset(0);
    this.rds.setEnabled(this.modeSettings.mode === "WBFM");
    this.rds.setFrequencyOffset(0);

    // Queue configuration and start without awaiting anything first, preserving
    // the transient user activation needed by WebUSB and Web Audio.
    void this.radio.setSampleRate(RTL_SAMPLE_RATE_HZ);
    void this.radio.setFrequency(options.channelFrequencyHz);
    void this.radio.setGain(gainDb);
    const outcome = new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      const started = (event: Event) => {
        const radioEvent = event as RadioEvent;
        if (radioEvent.detail.type !== "started") return;
        this.radio.removeEventListener("radio", started);
        this.startedListener = undefined;
        resolve();
      };
      this.startedListener = started;
      this.radio.addEventListener("radio", started);
    });

    await Promise.all([this.radio.start(), outcome, this.audioResume]);
    if (this.audioContext.state !== "running") {
      throw new DOMException(`Audio context remained ${this.audioContext.state}`, "NotAllowedError");
    }
    this.startSettled = true;
    this.rejectStart = undefined;
    const actualFrequencyHz = this.radio.getFrequency();
    this.demodulator.setFrequencyOffset(options.channelFrequencyHz - actualFrequencyHz);
    this.rds.setFrequencyOffset(options.channelFrequencyHz - actualFrequencyHz);
    const metadata = {
      source: "rtl-sdr",
      requestedSampleRateHz: RTL_SAMPLE_RATE_HZ,
      actualSampleRateHz: this.radio.getSampleRate(),
      hardwareCenterFrequencyHz: actualFrequencyHz,
      selectedChannelFrequencyHz: options.channelFrequencyHz,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
      gainDb: this.radio.getGain(),
      sampleFormat: "planar-f32-iq-normalized",
    } satisfies Omit<SourceSessionMetadata, "sessionGeneration">;
    this.analysis?.updateMetadata({ ...metadata, sessionGeneration: this.sessionGeneration });
    this.metadata = metadata;
    return metadata;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.startSettled && this.rejectStart) {
      this.rejectStart(new DOMException("Receiver start was stopped", "AbortError"));
      this.rejectStart = undefined;
    }
    this.stopTask = this.stopInternal();
    return this.stopTask;
  }

  setVolume(volume: number): void {
    this.demodulator.setVolume(volume);
  }

  async tune(channelFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (!this.metadata) throw new Error("RTL-SDR source is not running");
    this.sessionGeneration = sessionGeneration;
    const plan = planChannelTune(
      this.metadata.hardwareCenterFrequencyHz,
      channelFrequencyHz,
      this.metadata.actualSampleRateHz,
      this.modeSettings.bandwidthHz,
    );
    const provisional: SourceSessionMetadata = { ...this.metadata, sessionGeneration, selectedChannelFrequencyHz: channelFrequencyHz };
    this.analysis?.retune(provisional);
    if (plan.hardwareRetuneRequired) {
      // Incoming reads already in flight may still use the old center. Signals
      // changes offset only when a block tagged with the requested center arrives.
      this.demodulator.expectFrequencyAndSetOffset(plan.hardwareCenterFrequencyHz, plan.frequencyOffsetHz);
      await this.radio.setFrequency(plan.hardwareCenterFrequencyHz);
      const actualFrequencyHz = this.radio.getFrequency();
      // Reapplying the actual rate uses Demodulator's public reconstruction
      // path, clearing shifter/resampler/filter/demodulator history after a
      // discontinuous RF-center change.
      this.demodulator.setSampleRate(this.radio.getSampleRate());
      this.demodulator.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      this.rds.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      provisional.hardwareCenterFrequencyHz = actualFrequencyHz;
    } else {
      this.demodulator.setFrequencyOffset(plan.frequencyOffsetHz);
      this.rds.setFrequencyOffset(plan.frequencyOffsetHz);
    }
    const { sessionGeneration: _generation, ...metadata } = provisional;
    this.metadata = metadata;
    this.analysis?.updateMetadata({ ...metadata, sessionGeneration });
    return metadata;
  }

  async configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    this.modeSettings = normalizeModeSettings(settings);
    this.demodulator.setMode(createSignalsMode(this.modeSettings));
    this.rds.setEnabled(this.modeSettings.mode === "WBFM");
    if (!this.metadata) throw new Error("RTL-SDR source is not running");
    this.metadata = {
      ...this.metadata,
      mode: this.modeSettings.mode,
      channelBandwidthHz: this.modeSettings.bandwidthHz,
      squelch: this.modeSettings.squelch,
    };
    return this.tune(this.metadata.selectedChannelFrequencyHz, sessionGeneration);
  }

  async setGain(gainDb: number | null): Promise<number | null> {
    await this.radio.setGain(normalizeGain(gainDb));
    const configured = this.radio.getGain();
    if (this.metadata) this.metadata = { ...this.metadata, gainDb: configured };
    return configured;
  }

  startRecording(): RecordingStatus {
    if (!this.metadata) throw new Error("RTL-SDR source is not running");
    this.recorder = new IqRecorder({ ...this.metadata, sessionGeneration: this.sessionGeneration });
    return this.recorder.status();
  }

  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user"): IqRecording | undefined {
    const recorder = this.recorder;
    this.recorder = undefined;
    return recorder?.finish(reason);
  }

  getRecordingStatus(): RecordingStatus | undefined { return this.recorder?.status(); }

  private readonly onRadioEvent = (event: Event): void => {
    const radioEvent = event as RadioEvent;
    if (radioEvent.detail.type !== "error") return;
    if (!this.startSettled && this.rejectStart) {
      if (this.startedListener) this.radio.removeEventListener("radio", this.startedListener);
      this.startedListener = undefined;
      this.rejectStart(radioEvent.detail.exception);
      this.rejectStart = undefined;
    } else if (this.startSettled) {
      this.events.runtimeError(radioEvent.detail.exception);
    }
  };

  private readonly onAudioStateChange = (): void => {
    this.events.audioStateChanged(this.audioContext.state);
  };

  private async stopInternal(): Promise<void> {
    this.radio.removeEventListener("radio", this.onRadioEvent);
    if (this.startedListener) this.radio.removeEventListener("radio", this.startedListener);
    this.startedListener = undefined;
    this.audioContext.removeEventListener("statechange", this.onAudioStateChange);
    try {
      await this.radio.stop();
    } finally {
      this.analysis?.stop(this.sessionGeneration);
      await this.provider.closeCurrent().catch(() => undefined);
      if (this.selectedUsbDevice?.opened) {
        await this.selectedUsbDevice.close().catch(() => undefined);
      }
      if (this.audioContext.state !== "closed") {
        await this.audioContext.close().catch(() => undefined);
      }
    }
  }
}

export function createRtlSdrBackend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  sessionGeneration = 0,
  initialChannelFrequencyHz = 100_000_000,
): ReceiverBackend {
  return new RtlSdrBackend(events, analysis, sessionGeneration, initialChannelFrequencyHz);
}
