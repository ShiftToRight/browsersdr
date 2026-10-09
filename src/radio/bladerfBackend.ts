import type { RecordingOptions } from "./channelRecording";
import {
  IqRecorder,
  preferredRecordingStorageMode,
  type IqRecording,
  type RecordingStatus,
} from "./iqRecording";
import { bladeRfSc16RecordingFormat } from "./bladerfRecording";
import type { SurveyCaptureContext } from "./fieldSurvey";
import {
  DEFAULT_BLADERF_RX_SETTINGS,
  bladeRfSettingsAtFrequency,
  validateBladeRfRxSettings,
  type BladeRfRxSettings,
} from "./bladerfSettings";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { ADSB_FREQUENCY_HZ } from "../adsb/adsbReceiver";
import {
  defaultModeSettings,
  normalizeModeSettings,
  planChannelTune,
  type ReceiverModeSettings,
  type ReceiverTuneOptions,
} from "./receiverConfig";
import type {
  ReceiverBackend,
  ReceiverBackendEvents,
  ReceiverStartOptions,
} from "./receiverController";
import {
  isWidebandRate,
  validateSourceConfiguration,
  validateSourceFrequency,
  validateSourceRoute,
  type BladeRfSampleRateHz,
} from "./sourceCapabilities";
import {
  BladeRfTransport,
  type BladeRfConfiguredSession,
  type BladeRfTransportEvents,
} from "./bladerfTransport";
import { BladeRfSampleAdapter, validateBladeRfBlock } from "./bladerfSource";
import {
  LiveReceiverPipeline,
  type LiveReceiverDependencies,
} from "./liveReceiverPipeline";
import type { BladeRfSourceSessionMetadata } from "./types";
import type { BladeRfHostedImage } from "./bladerfImages";

export type BladeRfTransportPort = Pick<
  BladeRfTransport,
  | "requestAndOpen"
  | "configure"
  | "startRx"
  | "stopRx"
  | "close"
  | "diagnostics"
> &
  Partial<Pick<BladeRfTransport, "open">>;
export interface BladeRfBackendDependencies extends LiveReceiverDependencies {
  usb?: USB;
  loadImage?: (image: BladeRfHostedImage) => Promise<Uint8Array>;
  createTransport?: (events: BladeRfTransportEvents) => BladeRfTransportPort;
}
type Metadata = Omit<BladeRfSourceSessionMetadata, "sessionGeneration">;
interface Selection {
  channel: number;
  mode: ReceiverModeSettings;
  rate: BladeRfSampleRateHz;
  rxSettings: BladeRfRxSettings;
}

const cancelled = () =>
  new DOMException("bladeRF receiver operation was cancelled.", "AbortError");

/** Receive-only bladeRF 2.0 Micro backend: one selected RX input, native SC16 Q11. */
export class BladeRfBackend implements ReceiverBackend {
  private readonly pipeline: LiveReceiverPipeline;
  private readonly transport: BladeRfTransportPort;
  private readonly adapter: BladeRfSampleAdapter;
  private recorder?: IqRecorder;
  private completedRecording?: IqRecording;
  private acquired = false;
  private configured?: BladeRfConfiguredSession;
  private selection?: Selection;
  private metadata?: BladeRfSourceSessionMetadata;
  private receiving = false;
  private volume = 0;
  private transportGeneration = 0;
  private cancelled = 0;
  private disconnectRequested = false;
  private stopTask?: Promise<void>;
  private disconnectTask?: Promise<void>;
  private command?: Promise<Metadata>;

  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    private readonly dependencies: BladeRfBackendDependencies = {},
  ) {
    this.pipeline = new LiveReceiverPipeline(
      { ...events, runtimeError: this.runtimeError },
      analysis,
      dependencies,
    );
    this.transport =
      dependencies.createTransport?.({
        error: this.runtimeError,
        statusChanged: events.statusChanged,
      }) ??
      new BladeRfTransport({
        error: this.runtimeError,
        statusChanged: events.statusChanged,
        loadImage: dependencies.loadImage,
      });
    this.adapter = new BladeRfSampleAdapter(this.pipeline);
  }

  get diagnostics() {
    return this.transport.diagnostics;
  }
  getChannelDiagnostics() {
    return this.pipeline.channelDiagnostics;
  }

  connect(options: ReceiverStartOptions): Promise<Metadata> {
    return this.run(async (token) => {
      const selection = this.request(options);
      await this.prepare(selection, token);
      this.selection = selection;
      return this.publish(this.configured!, selection);
    });
  }

  connectGranted(
    options: ReceiverStartOptions,
    device: USBDevice,
  ): Promise<Metadata> {
    return this.run(async (token) => {
      const selection = this.request(options);
      await this.prepare(selection, token, selection.channel, device);
      this.selection = selection;
      return this.publish(this.configured!, selection);
    });
  }

  start(
    options: ReceiverStartOptions,
    generation = this.sessionGeneration,
  ): Promise<Metadata> {
    if (this.receiving) return Promise.resolve(this.result());
    return this.run(async (token) => {
      const selection = this.request(options);
      this.sessionGeneration = generation;
      this.volume = options.volume;
      await Promise.all([
        this.prepare(selection, token),
        this.pipeline.resume(),
      ]);
      this.check(token);
      this.pipeline.requireRunning();
      this.selection = selection;
      return this.startConfigured(selection, token);
    });
  }

  private request(options: ReceiverStartOptions): Selection {
    validateSourceConfiguration({ ...options, source: "bladerf" });
    const mode = normalizeModeSettings(
      options.modeSettings ?? defaultModeSettings("WBFM"),
    );
    const channel = options.channelFrequencyHz;
    if (mode.mode === "ADS-B" && channel !== ADSB_FREQUENCY_HZ)
      throw new Error(
        "bladeRF ADS-B reception requires a 1090 MHz hardware center.",
      );
    return {
      channel,
      mode,
      rate: (options.sampleRateHz ?? 2_400_000) as BladeRfSampleRateHz,
      rxSettings: validateBladeRfRxSettings(
        options.bladerfSettings ?? DEFAULT_BLADERF_RX_SETTINGS,
        channel,
      ),
    };
  }

  private async prepare(
    selection: Selection,
    token: number,
    center = selection.channel,
    grantedDevice?: USBDevice,
  ): Promise<void> {
    if (!this.acquired) {
      if (grantedDevice) {
        if (!this.transport.open)
          throw new Error(
            "This bladeRF transport cannot open an authorized device directly.",
          );
        await this.transport.open(grantedDevice);
      } else await this.transport.requestAndOpen(this.dependencies.usb);
      this.check(token);
      this.acquired = true;
      this.events.permissionGranted();
      this.check(token);
    }
    const prior = this.configured?.details;
    if (
      prior?.requestedCenterFrequencyHz === center &&
      prior.nativeSampleRateHz === selection.rate &&
      JSON.stringify(prior.rxSettings) === JSON.stringify(selection.rxSettings)
    )
      return;
    this.configured = await this.transport.configure(
      {
        centerFrequencyHz: center,
        sampleRateHz: selection.rate,
        bandwidthHz: selection.rate,
        rxSettings: bladeRfSettingsAtFrequency(selection.rxSettings, center),
      },
      ++this.transportGeneration,
    );
    this.check(token);
  }

  private async startConfigured(
    selection: Selection,
    token: number,
  ): Promise<Metadata> {
    this.publish(this.configured!, selection);
    if (isWidebandRate(selection.rate))
      await this.pipeline.prepare(this.metadata!);
    this.check(token);
    await this.transport.startRx(
      (block) => {
        if (
          !this.receiving ||
          !this.metadata ||
          !this.configured ||
          block.generation !== this.configured.generation
        )
          return;
        validateBladeRfBlock(block, this.configured.details);
        if (this.recorder) {
          if (this.recorder.status().sampleCount === 0)
            this.recorder.setCaptureStartedAt(new Date().toISOString());
          this.recorder.appendBladeRfSc16(block.bytes);
        }
        this.adapter.receive(block);
      },
      (session) => {
        this.check(token);
        this.configured = session;
        this.publish(session, selection);
        this.adapter.ready(session);
        this.pipeline.begin(this.metadata!, this.volume);
        this.receiving = true;
      },
    );
    this.check(token);
    return this.result();
  }

  private publish(
    session: BladeRfConfiguredSession,
    selection: Selection,
  ): Metadata {
    validateSourceRoute(
      "bladerf",
      selection.mode,
      session.details.nativeSampleRateHz,
      selection.channel,
    );
    this.pipeline.validateRateBudget(session.details.effectiveSampleRateHz);
    if (
      planChannelTune(
        session.hardwareCenterFrequencyHz,
        selection.channel,
        session.details.nativeSampleRateHz,
        selection.mode.bandwidthHz,
      ).hardwareRetuneRequired
    )
      throw new Error(
        "bladeRF capture center does not contain the selected channel.",
      );
    this.metadata = {
      source: "bladerf",
      sessionGeneration: this.sessionGeneration,
      requestedSampleRateHz: selection.rate,
      actualSampleRateHz: session.details.nativeSampleRateHz,
      hardwareCenterFrequencyHz: session.hardwareCenterFrequencyHz,
      selectedChannelFrequencyHz: selection.channel,
      mode: selection.mode.mode,
      channelBandwidthHz: selection.mode.bandwidthHz,
      squelch: selection.mode.squelch,
      beatToneHz: selection.mode.beatToneHz,
      srd: selection.mode.srd,
      gainDb: session.details.acceptedGainDb ?? null,
      sampleFormat: "planar-f32-iq-normalized",
      bladerf: structuredClone(session.details),
    };
    return this.result();
  }

  private result(): Metadata {
    if (!this.metadata) throw new Error("bladeRF is not configured.");
    const { sessionGeneration: _generation, ...metadata } = structuredClone(
      this.metadata,
    );
    return metadata;
  }

  selectDabService(key: string): void {
    this.pipeline.selectDabService(key);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.pipeline.setVolume(volume);
  }
  setGain(): Promise<number | null> {
    return Promise.reject(
      new Error("Use bladeRF RX settings to choose gain mode and manual gain."),
    );
  }

  configureBladeRf(
    settings: BladeRfRxSettings,
    generation: number,
  ): Promise<Metadata> {
    if (!this.selection || !this.metadata)
      return Promise.reject(
        new Error("Connect bladeRF before applying RX settings."),
      );
    const center = this.metadata.hardwareCenterFrequencyHz;
    const selection = {
      ...this.selection,
      rxSettings: validateBladeRfRxSettings(settings, center),
    };
    return this.run(async (token) => {
      this.finishRecording("metadata-change");
      const wasReceiving = this.receiving;
      this.receiving = false;
      this.adapter.reset();
      this.pipeline.reset();
      await this.transport.stopRx();
      this.check(token);
      this.sessionGeneration = generation;
      this.configured = undefined;
      await this.prepare(selection, token, center);
      this.selection = selection;
      return wasReceiving
        ? this.startConfigured(selection, token)
        : this.publish(this.configured!, selection);
    });
  }

  tune(channelFrequencyHz: number, generation: number, options: ReceiverTuneOptions = {}): Promise<Metadata> {
    return this.reconfigure(
      channelFrequencyHz,
      this.selection?.mode,
      generation,
      false,
      options,
    );
  }
  scanTune(centerFrequencyHz: number, generation: number): Promise<Metadata> {
    return this.reconfigure(
      centerFrequencyHz,
      this.selection?.mode,
      generation,
      true,
    );
  }
  configureMode(
    settings: ReceiverModeSettings,
    generation: number,
  ): Promise<Metadata> {
    return this.reconfigure(
      settings.mode === "ADS-B"
        ? ADSB_FREQUENCY_HZ
        : (this.selection?.channel ?? 0),
      settings,
      generation,
      false,
    );
  }
  updateAnalogMode(settings: ReceiverModeSettings): Metadata {
    if (!this.receiving || !this.selection || !this.metadata)
      throw new Error(
        "bladeRF reception must be running before changing analog settings.",
      );
    const mode = normalizeModeSettings(settings);
    if (mode.mode !== this.metadata.mode)
      throw new Error("Live analog settings cannot change receiver mode.");
    this.finishRecording("metadata-change");
    this.selection = { ...this.selection, mode };
    this.metadata = {
      ...this.metadata,
      channelBandwidthHz: mode.bandwidthHz,
      squelch: mode.squelch,
      beatToneHz: mode.beatToneHz,
    };
    this.pipeline.updateAnalogMode(mode);
    return this.result();
  }

  private async reconfigure(
    channel: number,
    requestedMode: ReceiverModeSettings | undefined,
    generation: number,
    scan: boolean,
    options: ReceiverTuneOptions = {},
  ): Promise<Metadata> {
    if (!this.receiving || !this.selection || !this.metadata || !requestedMode)
      return Promise.reject(
        new Error("bladeRF reception must be running before tuning."),
      );
    let mode: ReceiverModeSettings;
    try {
      mode = normalizeModeSettings(requestedMode);
      validateSourceRoute(
        "bladerf",
        mode,
        this.metadata.actualSampleRateHz,
        channel,
      );
      if (mode.mode === "ADS-B" && channel !== ADSB_FREQUENCY_HZ)
        throw new Error(
          "bladeRF ADS-B reception requires a 1090 MHz hardware center.",
        );
      if (scan)
        validateSourceFrequency(
          "bladerf",
          channel,
          this.metadata.actualSampleRateHz,
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const selection = { ...this.selection, channel, mode };
    const plan = planChannelTune(
      this.metadata.hardwareCenterFrequencyHz,
      channel,
      this.metadata.actualSampleRateHz,
      mode.bandwidthHz,
      options,
    );
    const mustCenter =
      !isWidebandRate(this.metadata.actualSampleRateHz) &&
      (mode.mode === "DAB" || mode.mode === "ADS-B");
    const center = scan || (mustCenter && options.centerFrequencyHz === undefined && options.autoRecenter !== false)
      ? channel : plan.hardwareCenterFrequencyHz;
    if (mustCenter && center !== channel)
      return Promise.reject(new Error(`${mode.mode} requires the receiver center to match the channel at this sample rate.`));
    if (plan.hardwareRetuneRequired)
      validateSourceFrequency(this.metadata.source, center, this.metadata.actualSampleRateHz);
    const hardware = scan || plan.hardwareRetuneRequired || mustCenter;
    if (hardware)
      selection.rxSettings = bladeRfSettingsAtFrequency(
        selection.rxSettings,
        center,
      );
    return this.run(async (token) => {
      this.finishRecording("metadata-change");
      this.sessionGeneration = generation;
      if (!hardware) {
        this.selection = selection;
        this.publish(this.configured!, selection);
        if (["APRS", "RS41"].includes((this.metadata!).mode)) {
          await this.pipeline.prepare(this.metadata!);
        }
        this.pipeline.retune(this.metadata!);
        return this.result();
      }
      this.receiving = false;
      this.adapter.reset();
      this.pipeline.reset();
      await this.transport.stopRx();
      this.configured = undefined;
      await this.prepare(selection, token, center);
      this.selection = selection;
      return this.startConfigured(selection, token);
    });
  }

  private run(body: (token: number) => Promise<Metadata>): Promise<Metadata> {
    if (this.disconnectRequested || this.stopTask)
      return Promise.reject(cancelled());
    if (this.command)
      return Promise.reject(
        new Error("bladeRF receiver is busy applying a command."),
      );
    const token = this.cancelled;
    const task = body(token).finally(() => {
      if (this.command === task) this.command = undefined;
    });
    this.command = task;
    return task;
  }
  private check(token: number): void {
    if (token !== this.cancelled || this.disconnectRequested) throw cancelled();
  }

  startRecording(survey?: SurveyCaptureContext, options?: RecordingOptions): RecordingStatus {
    if (
      !this.receiving ||
      !this.metadata ||
      !this.configured ||
      this.command ||
      this.disconnectRequested
    )
      throw new Error("bladeRF must be receiving before recording native IQ.");
    if (this.recorder || this.completedRecording)
      throw new Error("Finish or retrieve the existing recording first.");
    const details = this.configured.details;
    this.recorder = new IqRecorder(
      { ...this.metadata, actualSampleRateHz: details.acceptedSampleRateHz },
      undefined,
      undefined,
      `bladeRF ${details.identity.model} receive-only native SC16 Q11 I/Q bytes unchanged. Host timestamps and sample accounting do not prove hardware continuity.`,
      survey,
      bladeRfSc16RecordingFormat(details),
      preferredRecordingStorageMode(options?.storageMode),
      options,
    );
    return this.recorder.status();
  }

  stopRecording(
    reason: "user" | "source-stop" | "metadata-change" = "user",
  ): IqRecording | undefined {
    this.finishRecording(reason);
    const recording = this.completedRecording;
    this.completedRecording = undefined;
    return recording;
  }

  getRecordingStatus(): RecordingStatus | undefined {
    return this.recorder?.status();
  }

  private finishRecording(
    reason: "user" | "source-stop" | "metadata-change",
  ): void {
    if (!this.recorder) return;
    this.completedRecording = this.recorder.finish(reason);
    this.recorder = undefined;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    ++this.cancelled;
    this.finishRecording("source-stop");
    this.receiving = false;
    this.adapter.reset();
    this.pipeline.reset();
    const pending = this.command;
    const task = (async () => {
      const results = await Promise.allSettled([
        this.transport.stopRx(),
        this.pipeline.suspend(),
      ]);
      await pending?.catch(() => undefined);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
    });
    this.stopTask = task;
    return task;
  }

  disconnect(): Promise<void> {
    if (this.disconnectTask) return this.disconnectTask;
    this.disconnectRequested = true;
    ++this.cancelled;
    this.finishRecording("source-stop");
    this.receiving = false;
    this.adapter.reset();
    this.pipeline.reset();
    const pending = this.command;
    const task = (async () => {
      const results = await Promise.allSettled([
        this.transport.close(),
        this.pipeline.close(),
      ]);
      await pending?.catch(() => undefined);
      // A canceled open can acquire cleanup ownership after the first close.
      // Drain it only after that command settles; propagate retry failure.
      if (pending) await this.transport.close();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().finally(() => {
      if (this.disconnectTask === task) this.disconnectTask = undefined;
    });
    this.disconnectTask = task;
    return task;
  }

  private readonly runtimeError = (error: unknown): void => {
    if (this.disconnectRequested) return;
    this.recorder?.addGap(
      null,
      "bladeRF receive error; missing sample duration unknown.",
    );
    ++this.cancelled;
    this.finishRecording("source-stop");
    this.receiving = false;
    this.adapter.reset();
    this.pipeline.reset();
    this.events.runtimeError(error);
  };
}

export function createBladeRfBackend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  generation = 0,
  dependencies?: BladeRfBackendDependencies,
): ReceiverBackend {
  return new BladeRfBackend(events, analysis, generation, dependencies);
}
