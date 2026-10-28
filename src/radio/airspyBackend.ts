import {
  LiveReceiverPipeline,
  type LiveReceiverDependencies,
} from "./liveReceiverPipeline";
import { AirspyTransport } from "./airspyTransport";
import { ADSB_FREQUENCY_HZ } from "../adsb/adsbReceiver";
import {
  DEFAULT_AIRSPY_SETTINGS,
  validateAirspySettings,
  type AirspySettings,
  type AirspyIdentity,
} from "./airspySettings";
import { airspyRecordingFormat } from "./airspyRecording";
import {
  IqRecorder,
  preferredRecordingStorageMode,
  type IqRecording,
  type RecordingStatus,
} from "./iqRecording";
import {
  defaultModeSettings,
  normalizeModeSettings,
  planChannelTune,
  type ReceiverModeSettings,
  type ReceiverTuneOptions,
} from "./receiverConfig";
import {
  validateSourceConfiguration,
  validateSourceFrequency,
  validateSourceRoute,
} from "./sourceCapabilities";
import type {
  ReceiverBackend,
  ReceiverBackendEvents,
  ReceiverStartOptions,
} from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { RecordingOptions } from "./channelRecording";
import type { SurveyCaptureContext } from "./fieldSurvey";

type Metadata = Omit<SourceSessionMetadata, "sessionGeneration">;
type Selection = {
  channel: number;
  rate: number;
  mode: ReceiverModeSettings;
  settings: AirspySettings;
};
type Transport = Pick<
  AirspyTransport,
  "open" | "requestAndOpen" | "configure" | "gains" | "start" | "stop" | "close"
>;
export interface AirspyBackendDependencies extends LiveReceiverDependencies {
  usb?: USB;
  createTransport?: (error: (error: unknown) => void) => Transport;
  createConversionWorker?: () => Pick<
    Worker,
    "postMessage" | "terminate" | "onmessage" | "onerror"
  >;
}
/** Airspy ADC conversion is isolated in one bounded worker; raw complex fan-out
 * still precedes mutating channel/audio DSP. No second USB pump or audio graph. */
export class AirspyBackend implements ReceiverBackend {
  private readonly pipeline: LiveReceiverPipeline;
  private readonly transport: Transport;
  private identity?: AirspyIdentity;
  private selection?: Selection;
  private metadata?: SourceSessionMetadata;
  private worker?: ReturnType<
    NonNullable<AirspyBackendDependencies["createConversionWorker"]>
  >;
  private workerGeneration = 0;
  private pending = 0;
  private releaseIngress?: () => void;
  private conversionMs = 0;
  private conversionAverageMs = 0;
  private lastConversionReply = 0;
  private receiving = false;
  private closed = false;
  private epoch = 0;
  private command?: Promise<Metadata>;
  private stopping?: Promise<void>;
  private volume = 0;
  private recorder?: IqRecorder;
  private completed?: IqRecording;
  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private generation = 0,
    private readonly dependencies: AirspyBackendDependencies = {},
  ) {
    this.pipeline = new LiveReceiverPipeline(
      { ...events, runtimeError: this.runtimeError },
      analysis,
      dependencies,
    );
    this.transport =
      dependencies.createTransport?.(this.runtimeError) ??
      new AirspyTransport(this.runtimeError);
  }
  private readonly runtimeError = (error: unknown) => {
    this.receiving = false;
    this.releaseIngress?.();
    this.releaseIngress = undefined;
    this.pipeline.reset();
    this.events.runtimeError(error);
  };
  getChannelDiagnostics() {
    return this.pipeline.channelDiagnostics;
  }
  private request(options: ReceiverStartOptions): Selection {
    const settings = validateAirspySettings(
      options.airspySettings ?? DEFAULT_AIRSPY_SETTINGS,
    );
    // A Mini's lowest advertised rate is selected automatically only when no explicit rate is supplied.
    const rate =
      options.sampleRateHz ?? this.identity?.sampleRates.at(-1) ?? 2_500_000;
    validateSourceConfiguration({
      ...options,
      source: "airspy",
      sampleRateHz: rate,
      airspySettings: settings,
    });
    return {
      channel: options.channelFrequencyHz,
      rate,
      mode: normalizeModeSettings(
        options.modeSettings ?? defaultModeSettings("WBFM"),
      ),
      settings,
    };
  }
  private check(epoch: number) {
    if (epoch !== this.epoch || this.closed)
      throw new DOMException("Airspy operation cancelled", "AbortError");
  }
  private run(
    operation: (epoch: number) => Promise<Metadata>,
  ): Promise<Metadata> {
    if (this.closed || this.stopping || this.command)
      return Promise.reject(new Error("Airspy is busy or disconnected."));
    const epoch = this.epoch;
    const task = operation(epoch);
    this.command = task;
    void task
      .finally(() => {
        if (this.command === task) this.command = undefined;
      })
      .catch(() => undefined);
    return task;
  }
  private async prepare(
    selection: Selection,
    epoch: number,
    center = selection.channel,
    device?: USBDevice,
  ): Promise<Metadata> {
    const discovering = !this.identity;
    if (!this.identity) {
      this.identity = device
        ? await this.transport.open(device)
        : await this.transport.requestAndOpen(this.dependencies.usb);
      this.check(epoch);
      this.events.permissionGranted();
    }
    if (discovering && !this.identity.sampleRates.includes(selection.rate)) {
      selection = {
        ...selection,
        rate: Math.min(...this.identity.sampleRates),
      };
      validateSourceConfiguration({
        source: "airspy",
        channelFrequencyHz: selection.channel,
        sampleRateHz: selection.rate,
        modeSettings: selection.mode,
        airspySettings: selection.settings,
      });
    }
    if (!this.identity.sampleRates.includes(selection.rate))
      throw new Error(
        `This Airspy ${this.identity.rateProfile === "r2" ? "R2" : "Mini"} supports ${this.identity.sampleRates.map((rate) => rate / 1e6).join(" / ")} MS/s. Choose one of its advertised rates.`,
      );
    validateSourceFrequency("airspy", center);
    const corrected = await this.transport.configure(
      selection.rate,
      center,
      selection.settings,
    );
    this.check(epoch);
    this.selection = selection;
    this.metadata = {
      source: "airspy",
      sessionGeneration: this.generation,
      requestedSampleRateHz: selection.rate,
      actualSampleRateHz: selection.rate / selection.settings.decimation,
      hardwareCenterFrequencyHz: center,
      selectedChannelFrequencyHz: selection.channel,
      mode: selection.mode.mode,
      channelBandwidthHz: selection.mode.bandwidthHz,
      squelch: selection.mode.squelch,
      beatToneHz: selection.mode.beatToneHz,
      srd: selection.mode.srd,
      textModem: selection.mode.textModem,
      pocsag: selection.mode.pocsag,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
      airspy: {
        identity: structuredClone(this.identity),
        settings: { ...selection.settings },
        deviceSampleRateHz: selection.rate,
        adcSampleRateHz: selection.rate * 2,
        outputSampleRateHz: selection.rate / selection.settings.decimation,
        requestedCenterFrequencyHz: center,
        correctedDeviceFrequencyHz: corrected,
        rateEvidence: "firmware-advertised-and-usb-acknowledged",
        conversion: "airspy-fs4-real-to-iq-v1",
      },
    };
    return this.result();
  }
  connect(options: ReceiverStartOptions) {
    return this.run((epoch) => this.prepare(this.request(options), epoch));
  }
  connectGranted(options: ReceiverStartOptions, device: USBDevice) {
    return this.run((epoch) =>
      this.prepare(
        this.request(options),
        epoch,
        options.channelFrequencyHz,
        device,
      ),
    );
  }
  start(options: ReceiverStartOptions, generation = this.generation) {
    return this.run(async (epoch) => {
      const selection = this.request(options);
      this.generation = generation;
      this.volume = options.volume;
      const resume = this.pipeline.resume();
      await Promise.all([this.prepare(selection, epoch), resume]);
      this.check(epoch);
      this.pipeline.requireRunning();
      await this.begin(epoch);
      return this.result();
    });
  }
  private async begin(epoch: number): Promise<void> {
    const metadata = this.metadata!,
      selection = this.selection!;
    await this.pipeline.prepare(metadata);
    this.check(epoch);
    this.worker?.terminate();
    const worker =
      this.dependencies.createConversionWorker?.() ??
      new Worker(new URL("../workers/airspy.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker = worker;
    const generation = ++this.workerGeneration;
    this.pending = 0;
    let ready!: () => void, failed!: (error: Error) => void;
    const waiting = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const timer = setTimeout(
      () => failed(new Error("Airspy conversion worker did not become ready.")),
      5000,
    );
    worker.onerror = (event) => {
      const error = new Error(event.message);
      failed(error);
      if (this.receiving) this.runtimeError(error);
    };
    worker.onmessage = (
      event: MessageEvent<{
        type: string;
        generation: number;
        message?: string;
        I: Float32Array;
        Q: Float32Array;
        processingMs?: number;
      }>,
    ) => {
      const message = event.data;
      if (this.worker !== worker || message.generation !== generation) return;
      if (message.type === "ready") {
        ready();
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.message);
        failed(error);
        this.runtimeError(error);
        return;
      }
      this.pending--;
      this.releaseIngress?.();
      this.releaseIngress = undefined;
      this.conversionMs = message.processingMs ?? 0;
      this.conversionAverageMs =
        this.conversionAverageMs * 0.9 + this.conversionMs * 0.1;
      this.lastConversionReply = performance.now();
      if (!this.receiving || !this.metadata || message.I.length === 0) return;
      // Quantize only for the optional 16-bit recording tap; never truncate live DSP to 8 bits.
      if (
        this.recorder ||
        (this.events.captureSamplesRequested?.() ??
          Boolean(this.events.captureSamples))
      ) {
        const bytes = new Uint8Array(message.I.length * 4),
          view = new DataView(bytes.buffer);
        for (let n = 0; n < message.I.length; n++) {
          view.setInt16(
            n * 4,
            Math.max(
              -32768,
              Math.min(32767, Math.round(message.I[n]! * 32768)),
            ),
            true,
          );
          view.setInt16(
            n * 4 + 2,
            Math.max(
              -32768,
              Math.min(32767, Math.round(message.Q[n]! * 32768)),
            ),
            true,
          );
        }
        this.recorder?.appendCi16(bytes);
        this.events.captureSamples?.(bytes, this.metadata);
      }
      try {
        this.pipeline.receiveSamples({
          I: message.I,
          Q: message.Q,
          frequency: this.metadata.hardwareCenterFrequencyHz,
        });
      } catch (error) {
        this.runtimeError(error);
      }
    };
    worker.postMessage({
      type: "configure",
      generation,
      settings: selection.settings,
      rate: selection.rate,
    });
    try {
      await waiting;
    } finally {
      clearTimeout(timer);
    }
    this.check(epoch);
    this.pipeline.begin(metadata, this.volume);
    this.receiving = true;
    // Discard receiver startup transient before handing any samples to the conversion FIR.
    let settlingBytes =
      Math.ceil(selection.rate * 2 * 0.05) *
      (selection.settings.packing ? 1.5 : 2);
    await this.transport.start(selection.settings.packing, (bytes) => {
      if (!this.receiving || this.worker !== worker || epoch !== this.epoch)
        return;
      if (settlingBytes > 0) {
        settlingBytes -= bytes.length;
        return;
      }
      if (this.pending >= 64) {
        this.runtimeError(
          new Error(
            `Airspy conversion queue is full; reception stopped. Last block ${this.conversionMs.toFixed(2)} ms, average ${this.conversionAverageMs.toFixed(2)} ms, budget ${((16384 / selection.rate) * 1000).toFixed(2)} ms, last reply ${(performance.now() - this.lastConversionReply).toFixed(2)} ms ago. Use a lower device rate.`,
          ),
        );
        return;
      }
      this.pending++;
      // The transport supplies an owned copy; this is its sole consumer.
      const owned = bytes;
      worker.postMessage({ type: "samples", generation, bytes: owned }, [
        owned.buffer,
      ]);
      // Transfer completions and worker replies use different task sources.
      // Bound the handoff to one USB ring, giving replies a chance to run even
      // during a burst of already-completed transfers. Keep all ordered reads.
      if (this.pending >= 16)
        return new Promise<void>((resolve) => {
          this.releaseIngress = resolve;
        });
    });
    this.check(epoch);
  }
  private result(): Metadata {
    if (!this.metadata) throw new Error("Airspy is not configured.");
    const { sessionGeneration: _generation, ...result } = structuredClone(
      this.metadata,
    );
    return result;
  }
  private async halt() {
    this.receiving = false;
    this.releaseIngress?.();
    this.releaseIngress = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.pending = 0;
    this.pipeline.reset();
    await this.transport.stop();
  }
  tune(channel: number, generation: number, options: ReceiverTuneOptions = {}) {
    return this.reconfigure(channel, this.selection!.mode, generation, options);
  }
  scanTune(center: number, generation: number) {
    return this.reconfigure(center, this.selection!.mode, generation, {
      centerFrequencyHz: center,
    });
  }
  configureMode(mode: ReceiverModeSettings, generation: number) {
    return this.reconfigure(
      mode.mode === "ADS-B" ? ADSB_FREQUENCY_HZ : this.selection!.channel,
      mode,
      generation,
    );
  }
  private reconfigure(
    channel: number,
    mode: ReceiverModeSettings,
    generation: number,
    options: ReceiverTuneOptions = {},
  ) {
    const selection = {
      ...this.selection!,
      channel,
      mode: normalizeModeSettings(mode),
    };
    validateSourceRoute(
      "airspy",
      selection.mode,
      this.metadata!.actualSampleRateHz,
      channel,
    );
    const plan = planChannelTune(
      this.metadata!.hardwareCenterFrequencyHz,
      channel,
      this.metadata!.actualSampleRateHz,
      mode.bandwidthHz,
      options,
    );
    return this.run(async (epoch) => {
      this.stopRecording("metadata-change");
      this.generation = generation;
      if (!plan.hardwareRetuneRequired) {
        this.selection = selection;
        this.metadata = {
          ...this.metadata!,
          sessionGeneration: generation,
          selectedChannelFrequencyHz: channel,
          mode: mode.mode,
          channelBandwidthHz: mode.bandwidthHz,
          squelch: mode.squelch,
          beatToneHz: mode.beatToneHz,
          srd: mode.srd,
          pocsag: mode.pocsag,
          textModem: mode.textModem,
        };
        await this.pipeline.prepare(this.metadata);
        this.check(epoch);
        this.pipeline.retune(this.metadata);
      } else {
        await this.halt();
        this.check(epoch);
        await this.prepare(selection, epoch, plan.hardwareCenterFrequencyHz);
        await this.begin(epoch);
      }
      return this.result();
    });
  }
  updateAnalogMode(mode: ReceiverModeSettings) {
    if (!this.receiving || mode.mode !== this.metadata?.mode)
      throw new Error(
        "Start Airspy in the same mode before changing analog settings.",
      );
    const accepted = normalizeModeSettings(mode);
    this.selection = { ...this.selection!, mode: accepted };
    this.metadata = {
      ...this.metadata,
      channelBandwidthHz: accepted.bandwidthHz,
      squelch: accepted.squelch,
      beatToneHz: accepted.beatToneHz,
    };
    this.pipeline.updateAnalogMode(accepted);
    return this.result();
  }
  configureAirspy(settings: AirspySettings, generation: number) {
    const accepted = validateAirspySettings(settings),
      selection = { ...this.selection!, settings: accepted };
    validateSourceConfiguration({
      source: "airspy",
      channelFrequencyHz: selection.channel,
      modeSettings: selection.mode,
      sampleRateHz: selection.rate,
      airspySettings: accepted,
    });
    const center = this.metadata!.hardwareCenterFrequencyHz;
    planChannelTune(
      center,
      selection.channel,
      selection.rate / accepted.decimation,
      selection.mode.bandwidthHz,
      { autoRecenter: false },
    );
    return this.run(async (epoch) => {
      this.stopRecording("metadata-change");
      const running = this.receiving;
      await this.halt();
      this.check(epoch);
      this.generation = generation;
      await this.prepare(selection, epoch, center);
      if (running) await this.begin(epoch);
      return this.result();
    });
  }
  configureSampleRate(rate: number, generation: number) {
    const options = {
      source: "airspy" as const,
      channelFrequencyHz: this.selection!.channel,
      modeSettings: this.selection!.mode,
      airspySettings: this.selection!.settings,
      sampleRateHz: rate,
      volume: this.volume,
    };
    const selection = this.request(options);
    if (!this.identity!.sampleRates.includes(rate))
      return Promise.reject(
        new Error("This Airspy does not advertise that rate."),
      );
    return this.run(async (epoch) => {
      this.stopRecording("metadata-change");
      await this.halt();
      this.check(epoch);
      this.generation = generation;
      await this.prepare(selection, epoch);
      await this.begin(epoch);
      return this.result();
    });
  }
  setVolume(volume: number) {
    this.volume = volume;
    this.pipeline.setVolume(volume);
  }
  setGain(): Promise<number | null> {
    return Promise.reject(
      new Error(
        "Airspy uses gain presets or independent LNA/mixer/VGA controls.",
      ),
    );
  }
  selectDabService(key: string) {
    this.pipeline.selectDabService(key);
  }
  configureSecondaryVfo(
    settings?: import("./secondaryVfo").SecondaryVfoSettings,
  ) {
    return this.pipeline.configureSecondaryVfo(settings);
  }
  startRecording(
    survey?: SurveyCaptureContext,
    options: RecordingOptions = {},
  ): RecordingStatus {
    if (!this.receiving || !this.metadata?.airspy)
      throw new Error("Start Airspy reception before recording.");
    const metadata = this.pipeline.recordingContext(
      this.metadata,
      options.vfo ?? "A",
    );
    this.recorder = new IqRecorder(
      metadata,
      undefined,
      undefined,
      "Airspy real ADC converted to complex I/Q with DC removal, Fs/4 translation, FIR filtering and optional decimation; quantized to int16. Not unchanged USB bytes.",
      survey,
      airspyRecordingFormat(this.metadata.airspy),
      options.storageMode ?? preferredRecordingStorageMode(),
      options,
    );
    return this.recorder.status();
  }
  stopRecording(reason: "user" | "source-stop" | "metadata-change" = "user") {
    if (this.recorder) {
      this.completed = this.recorder.finish(reason);
      this.recorder = undefined;
    }
    const result = this.completed;
    this.completed = undefined;
    return result;
  }
  getRecordingStatus() {
    return this.recorder?.status();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.epoch;
    this.stopRecording("source-stop");
    if (this.selection)
      this.selection.settings = { ...this.selection.settings, biasTee: false };
    if (this.metadata?.airspy)
      this.metadata.airspy.settings = {
        ...this.metadata.airspy.settings,
        biasTee: false,
      };
    return (this.stopping = (async () => {
      await this.halt();
      await this.command?.catch(() => undefined);
      await this.transport.stop();
    })().finally(() => {
      this.stopping = undefined;
    }));
  }
  async disconnect(): Promise<void> {
    this.closed = true;
    await this.stop();
    await this.transport.close();
    await this.pipeline.close();
  }
}
