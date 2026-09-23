import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AudioPlayer } from "@jtarrio/signals/players/audioplayer.js";
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
  createSignalsMode,
  defaultModeSettings,
  normalizeGain,
  normalizeModeSettings,
  planChannelTune,
  type ReceiverModeSettings,
} from "./receiverConfig";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";
import { DabReceiver, validateDabSampleRate } from "../dab/dabReceiver";
import { AdsbReceiver, validateAdsbSampleRate } from "../adsb/adsbReceiver";
import { AisReceiver } from "../ais/aisReceiver";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";

const PARALLEL_TRANSFERS = 2;
const BUFFERS_PER_SECOND = 20;

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

  async get(): Promise<IdempotentSource> {
    const device = new RecordingRtlDevice(await this.deviceProvider.get(), this.capture);
    const source = new IdempotentSource(new AcknowledgedRtlSource(device));
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
  private readonly audioContext: AudioContext;
  private readonly demodulator: Demodulator;
  private readonly provider: TrackedRtlProvider;
  private readonly rds: RdsMultiplexReceiver;
  private readonly sampleReceiver: AudioFirstRdsReceiver;
  private readonly dab: DabReceiver;
  private readonly adsb: AdsbReceiver;
  private readonly ais: AisReceiver;
  private source?: IdempotentSource;
  private metadata?: Omit<SourceSessionMetadata, "sessionGeneration">;
  private modeSettings = defaultModeSettings("WBFM");
  private recorder?: IqRecorder;
  private receiving = false;
  private disconnected = false;
  private streamTasks: Promise<void>[] = [];
  private streamFailureReported = false;

  constructor(
    private readonly events: ReceiverBackendEvents,
    private readonly analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    initialChannelFrequencyHz = 100_000_000,
  ) {
    if (!navigator.usb) throw new RadioError("This browser does not support the WebUSB API", RadioErrorType.NoUsbSupport);
    this.audioContext = new AudioContext();
    this.audioContext.addEventListener("statechange", this.onAudioStateChange);
    const player = new AudioPlayer({ newAudioContext: () => this.audioContext });
    this.demodulator = new Demodulator({ player });
    this.rds = new RdsMultiplexReceiver((state) => this.events.rdsChanged(state));
    this.dab = new DabReceiver((state) => this.events.dabChanged?.(state));
    this.adsb = new AdsbReceiver((state) => this.events.adsbChanged?.(state));
    this.ais = new AisReceiver((state) => this.events.aisChanged?.(state));
    this.sampleReceiver = new AudioFirstRdsReceiver(this.demodulator, this.rds);
    this.provider = new TrackedRtlProvider(events.permissionGranted, (data) => this.recorder?.appendCu8(data));
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
    if (this.disconnected) throw new DOMException("The RTL-SDR backend was disconnected", "InvalidStateError");
    if (this.source) return this.configureConnectedSource(options);
    this.source = await this.provider.get();
    try { return await this.configureConnectedSource(options); }
    catch (error) { await this.source.close().catch(() => undefined); this.source = undefined; throw error; }
  }

  async start(options: ReceiverStartOptions, sessionGeneration = this.sessionGeneration): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    if (this.receiving) return this.metadata!;
    this.sessionGeneration = sessionGeneration;
    // Invoke resume before the first await so the Start button's user activation
    // is still available to Web Audio.
    const audioResume = this.audioContext.resume();
    const [metadata] = await Promise.all([this.connect(options), audioResume]);
    this.modeSettings = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
    if (this.modeSettings.mode === "DAB") validateDabSampleRate(metadata.actualSampleRateHz);
    else if (this.modeSettings.mode === "ADS-B") validateAdsbSampleRate(metadata.actualSampleRateHz);
    else if (this.modeSettings.mode !== "AIS") this.demodulator.setMode(createSignalsMode(this.modeSettings));
    this.demodulator.setVolume(options.volume);
    this.demodulator.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    this.rds.setEnabled(this.modeSettings.mode === "WBFM");
    this.sampleReceiver.setDigitalReceiver(this.digitalReceiver());
    this.rds.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    this.dab.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    this.ais.setFrequencyOffset(metadata.selectedChannelFrequencyHz - metadata.hardwareCenterFrequencyHz);
    this.sampleReceiver.setAnalysis(this.analysis?.begin({ ...metadata, sessionGeneration }));
    this.sampleReceiver.setSampleRate(metadata.actualSampleRateHz);
    if (this.audioContext.state !== "running") throw new DOMException(`Audio context remained ${this.audioContext.state}`, "NotAllowedError");
    await this.source!.startReceiving();
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
    this.sampleReceiver.setAnalysis(undefined);
    this.analysis?.stop(this.sessionGeneration);
    this.rds.reset();
    this.dab.reset();
    this.adsb.reset();
    this.ais.reset();
    if (this.audioContext.state === "running") await this.audioContext.suspend().catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    await this.stop();
    this.disconnected = true;
    this.audioContext.removeEventListener("statechange", this.onAudioStateChange);
    const source = this.source;
    this.source = undefined;
    await source?.close();
    if (this.audioContext.state !== "closed") await this.audioContext.close().catch(() => undefined);
  }

  setVolume(volume: number): void { this.demodulator.setVolume(volume); }

  async tune(channelFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    const source = this.source;
    if (!this.metadata || !source) throw new Error("RTL-SDR source is not connected");
    this.sessionGeneration = sessionGeneration;
    const plan = planChannelTune(this.metadata.hardwareCenterFrequencyHz, channelFrequencyHz, this.metadata.actualSampleRateHz, this.modeSettings.bandwidthHz);
    const provisional = { ...this.metadata, selectedChannelFrequencyHz: channelFrequencyHz };
    this.analysis?.retune({ ...provisional, sessionGeneration });
    if (plan.hardwareRetuneRequired) {
      this.demodulator.expectFrequencyAndSetOffset(plan.hardwareCenterFrequencyHz, plan.frequencyOffsetHz);
      const actualFrequencyHz = await source.setCenterFrequency(plan.hardwareCenterFrequencyHz);
      this.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
      this.demodulator.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      this.rds.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      this.dab.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      this.ais.setFrequencyOffset(channelFrequencyHz - actualFrequencyHz);
      this.adsb.reset();
      provisional.hardwareCenterFrequencyHz = actualFrequencyHz;
    } else {
      this.demodulator.setFrequencyOffset(plan.frequencyOffsetHz);
      this.rds.setFrequencyOffset(plan.frequencyOffsetHz);
      this.dab.setFrequencyOffset(plan.frequencyOffsetHz);
      this.ais.setFrequencyOffset(plan.frequencyOffsetHz);
      this.adsb.reset();
    }
    this.metadata = provisional;
    this.analysis?.updateMetadata({ ...provisional, sessionGeneration });
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
    this.analysis?.retune({ ...provisional, sessionGeneration });
    this.demodulator.expectFrequencyAndSetOffset(centerFrequencyHz, 0);
    const actualFrequencyHz = await source.setCenterFrequency(centerFrequencyHz);
    this.demodulator.setSampleRate(this.metadata.actualSampleRateHz);
    this.demodulator.setFrequencyOffset(centerFrequencyHz - actualFrequencyHz);
    this.rds.reset();
    this.rds.setFrequencyOffset(centerFrequencyHz - actualFrequencyHz);
    this.dab.setFrequencyOffset(centerFrequencyHz - actualFrequencyHz);
    this.ais.setFrequencyOffset(centerFrequencyHz - actualFrequencyHz);
    this.adsb.reset();
    this.metadata = {
      ...provisional,
      hardwareCenterFrequencyHz: actualFrequencyHz,
    };
    this.analysis?.updateMetadata({ ...this.metadata, sessionGeneration });
    return this.metadata;
  }

  async configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">> {
    this.modeSettings = normalizeModeSettings(settings);
    if (this.modeSettings.mode === "DAB") validateDabSampleRate(this.metadata?.actualSampleRateHz ?? 0);
    else if (this.modeSettings.mode === "ADS-B") validateAdsbSampleRate(this.metadata?.actualSampleRateHz ?? 0);
    else if (this.modeSettings.mode !== "AIS") this.demodulator.setMode(createSignalsMode(this.modeSettings));
    this.rds.setEnabled(this.modeSettings.mode === "WBFM");
    this.sampleReceiver.setDigitalReceiver(this.digitalReceiver());
    if (!this.metadata) throw new Error("RTL-SDR source is not connected");
    this.metadata = { ...this.metadata, mode: this.modeSettings.mode, channelBandwidthHz: this.modeSettings.bandwidthHz, squelch: this.modeSettings.squelch };
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

  private digitalReceiver(): SampleReceiver | undefined {
    if (this.modeSettings.mode === "DAB") return this.dab;
    if (this.modeSettings.mode === "ADS-B") return this.adsb;
    if (this.modeSettings.mode === "AIS") return this.ais;
    return undefined;
  }

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

  private async pump(samplesPerBuffer: number): Promise<void> {
    while (this.receiving) {
      try {
        const block = await this.source!.readSamples(samplesPerBuffer);
        if (this.receiving) this.sampleReceiver.receiveSamples(block);
      } catch (error) {
        if (this.receiving && !this.streamFailureReported) {
          this.streamFailureReported = true;
          this.events.runtimeError(error);
        }
        return;
      }
    }
  }

  private readonly onAudioStateChange = (): void => this.events.audioStateChanged(this.audioContext.state);
}

export function createRtlSdrBackend(events: ReceiverBackendEvents, analysis?: AnalysisPipeline, sessionGeneration = 0, initialChannelFrequencyHz = 100_000_000): ReceiverBackend {
  return new RtlSdrBackend(events, analysis, sessionGeneration, initialChannelFrequencyHz);
}
