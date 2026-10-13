import type { RecordingOptions } from "./channelRecording";
import { IngressTimings } from "./ingressTimings";
import { isWidebandRate } from "./sourceCapabilities";
import {
  IqRecorder,
  preferredRecordingStorageMode,
  type IqRecording,
  type RecordingStatus,
} from "./iqRecording";
import { hackrfRecordingFormat } from "./ci8Recording";
import type { SurveyCaptureContext } from "./fieldSurvey";
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
  DEFAULT_HACKRF_RX_SETTINGS,
  validateHackrfRxSettings,
  validateHackrfSessionDetails,
  validateSourceConfiguration,
  validateSourceFrequency,
  validateSourceRoute,
  type HackrfRxSettings,
  type HackrfIdentity,
  type HackrfSampleRateHz,
} from "./sourceCapabilities";
import {
  HackrfTransport,
  type NativeIqBlock,
  type HackrfTransportEvents,
} from "./hackrfTransport";
import type { HackrfConfiguredSession } from "./hackrfProtocol";
import { HackrfSampleAdapter } from "./hackrfSource";
import {
  LiveReceiverPipeline,
  type LiveReceiverDependencies,
} from "./liveReceiverPipeline";
import type { HackrfSourceSessionMetadata } from "./types";

export type HackrfTransportPort = Pick<
  HackrfTransport,
  | "requestAndOpen"
  | "configure"
  | "startRx"
  | "stopRx"
  | "close"
  | "diagnostics"
> &
  Partial<Pick<HackrfTransport, "open">>;
export interface HackrfBackendDependencies extends LiveReceiverDependencies {
  usb?: USB;
  createTransport?: (events: HackrfTransportEvents) => HackrfTransportPort;
  /** Step 05 may attach a synchronous, bounded native-byte recorder here. */
  nativeCapture?: (
    block: NativeIqBlock,
    metadata: Readonly<HackrfSourceSessionMetadata>,
  ) => void;
}
type Metadata = Omit<HackrfSourceSessionMetadata, "sessionGeneration">;
interface Selection {
  channel: number;
  mode: ReceiverModeSettings;
  rate: HackrfSampleRateHz;
  settings: HackrfRxSettings;
}
const abort = () =>
  new DOMException("HackRF receiver operation was cancelled", "AbortError");

/** Owns one transport and the shared live DSP. Controller generations are separate
 * from hardware acquisition generations: a digital offset change needs no USB read loop. */
export class HackrfBackend implements ReceiverBackend {
  private readonly ingressTimings = new IngressTimings([
    "Native capture",
    "Main-thread normalization",
    "GPU tap",
    "Spectrum copy",
    "Spectrum dispatch",
    "Channel copy",
    "Channel dispatch",
  ]);
  private readonly pipeline: LiveReceiverPipeline;
  private readonly transport: HackrfTransportPort;
  private readonly adapter: HackrfSampleAdapter;
  private acquired = false;
  private identity?: HackrfIdentity;
  private configuredOff = false;
  private transportGeneration = 0;
  private transportSession?: HackrfConfiguredSession;
  private selection?: Selection;
  private metadata?: HackrfSourceSessionMetadata;
  private recorder?: IqRecorder;
  private completedRecording?: IqRecording;
  private volume = 0;
  private receiving = false;
  private cancelled = 0;
  private disconnectRequested = false;
  private disconnected = false;
  private command?: { name: string; task: Promise<Metadata> };
  private stopTask?: Promise<void>;
  private disconnectTask?: Promise<void>;
  private rxToken?: symbol;
  private sampleBase?: number;
  private sequence = 0;

  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    private readonly dependencies: HackrfBackendDependencies = {},
  ) {
    this.pipeline = new LiveReceiverPipeline(
      { ...events, runtimeError: this.runtimeError },
      analysis,
      dependencies,
      this.ingressTimings,
    );
    this.transport =
      dependencies.createTransport?.({ error: this.runtimeError }) ??
      new HackrfTransport({ error: this.runtimeError });
    this.adapter = new HackrfSampleAdapter(
      this.pipeline,
      (block) => {
        if (this.recorder) {
          if (this.recorder.status().sampleCount === 0)
            this.recorder.setCaptureStartedAt(
              new Date(
                Date.now() -
                  Math.max(0, performance.now() - block.receivedAtMonotonicMs),
              ).toISOString(),
            );
          this.recorder.appendCi8(block.bytes);
        }
        return dependencies.nativeCapture?.(block, this.metadata!);
      },
      this.ingressTimings,
    );
  }
  getIngressDiagnostics() {
    const transport = this.transport.diagnostics.ingress;
    return {
      debtMs: transport?.debtMs ?? 0,
      budgetMs: transport?.budgetMs ?? 0,
      stages: { ...transport?.stages, ...this.ingressTimings.snapshot() },
    };
  }
  getChannelDiagnostics() {
    return this.pipeline.channelDiagnostics;
  }
  get diagnostics() {
    return {
      ...this.transport.diagnostics,
      nativeSampleRateHz: this.metadata?.hackrf.nativeSampleRateHz ?? null,
      effectiveSampleRateHz:
        this.metadata?.hackrf.effectiveSampleRateHz ?? null,
    };
  }
  connect(options: ReceiverStartOptions): Promise<Metadata> {
    return this.run("connect", async (token) => {
      if (this.receiving)
        throw new Error("Stop HackRF reception before connecting again.");
      const selection = this.request(options);
      await this.prepare(selection, token);
      this.check(token);
      this.selection = selection;
      return this.publishMetadata(this.transportSession!, selection);
    });
  }
  connectGranted(
    options: ReceiverStartOptions,
    device: USBDevice,
  ): Promise<Metadata> {
    return this.run("connect", async (token) => {
      if (this.receiving)
        throw new Error("Stop HackRF reception before connecting again.");
      const selection = this.request(options);
      await this.prepare(selection, token, selection.channel, device);
      this.check(token);
      this.selection = selection;
      return this.publishMetadata(this.transportSession!, selection);
    });
  }
  start(
    options: ReceiverStartOptions,
    generation = this.sessionGeneration,
  ): Promise<Metadata> {
    if (this.receiving) return Promise.resolve(this.result());
    return this.run("start", async (token) => {
      const selection = this.request(options);
      this.sessionGeneration = generation;
      this.volume = options.volume;
      // Both operations are invoked now, in the originating user gesture.
      const resume = this.pipeline.resume();
      await Promise.all([this.prepare(selection, token), resume]);
      this.check(token);
      this.pipeline.requireRunning();
      this.selection = selection;
      return this.startConfigured(selection, token);
    });
  }
  private request(options: ReceiverStartOptions): Selection {
    validateSourceConfiguration({ ...options, source: "hackrf", hackrfIdentity: this.identity });
    const mode = normalizeModeSettings(
      options.modeSettings ?? defaultModeSettings("WBFM"),
    );
    this.validateCenter(mode, options.channelFrequencyHz);
    return {
      channel: options.channelFrequencyHz,
      mode,
      rate: (options.sampleRateHz ?? 9_600_000) as HackrfSampleRateHz,
      settings: validateHackrfRxSettings(
        options.hardwareSettings ?? DEFAULT_HACKRF_RX_SETTINGS, this.identity?.kind ?? "unknown",
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
            "This HackRF transport cannot open an authorized device directly.",
          );
        this.identity = await this.transport.open(grantedDevice);
      } else this.identity = await this.transport.requestAndOpen(this.dependencies.usb);
      this.check(token);
      this.acquired = true;
      this.events.permissionGranted();
    }
    this.check(token);
    validateSourceConfiguration({ source: "hackrf", hackrfIdentity: this.identity, channelFrequencyHz: selection.channel, modeSettings: selection.mode, sampleRateHz: selection.rate, hardwareSettings: selection.settings });
    validateSourceFrequency("hackrf", center, 0, this.identity);
    const previous = this.transportSession?.details.captureSettings;
    const same =
      this.configuredOff &&
      previous?.requestedCenterFrequencyHz === center &&
      previous.requestedSampleRateHz === selection.rate &&
      previous.rxLnaGainCode === selection.settings.rxLnaGainCode &&
      previous.rxVgaGainDb === selection.settings.rxVgaGainDb &&
      previous.rfAmplifierEnabled === selection.settings.rfAmplifierEnabled;
    if (!same) {
      this.transportSession = await this.transport.configure({
        generation: ++this.transportGeneration,
        centerFrequencyHz: center,
        sampleRateHz: selection.rate,
        settings: selection.settings,
      });
      this.check(token);
      this.configuredOff = true;
    }
  }
  private async startConfigured(
    selection: Selection,
    token: number,
  ): Promise<Metadata> {
    this.ingressTimings.reset();
    const rxToken = Symbol("HackRF acquisition");
    this.rxToken = rxToken;
    this.configuredOff = false;
    if (isWidebandRate(selection.rate)) {
      this.publishMetadata(this.transportSession!, selection);
      await this.pipeline.prepare(this.metadata!);
      this.check(token);
    }
    await this.transport.startRx(
      (block) => {
        if (
          this.rxToken !== rxToken ||
          !this.receiving ||
          !this.metadata ||
          block.generation !== this.transportSession?.generation
        )
          return;
        this.sampleBase ??= block.firstSampleIndex;
        // A digital-only tune resets the application sample clock and decoder state,
        // while the physical stream keeps its own generation and ordering.
        this.adapter.receive({
          ...block,
          generation: this.sessionGeneration,
          sequence: this.sequence++,
          firstSampleIndex: block.firstSampleIndex - this.sampleBase,
        });
      },
      (ready) => {
        this.check(token);
        if (this.rxToken !== rxToken) throw abort();
        this.transportSession = ready;
        this.publishMetadata(ready, selection);
        this.pipeline.requireRunning();
        this.adapter.ready({ ...ready, generation: this.sessionGeneration });
        this.pipeline.begin(this.metadata!, this.volume);
        this.sampleBase = undefined;
        this.sequence = 0;
        this.receiving = true;
      },
    );
    this.check(token);
    return this.result();
  }
  private publishMetadata(
    session: HackrfConfiguredSession,
    selection: Selection,
  ): Metadata {
    validateHackrfSessionDetails(session.details);
    this.pipeline.validateRateBudget(session.details.effectiveSampleRateHz);
    validateSourceRoute(
      "hackrf",
      selection.mode,
      session.details.nativeSampleRateHz,
      selection.channel,
    );
    if (
      planChannelTune(
        session.hardwareCenterFrequencyHz,
        selection.channel,
        session.details.nativeSampleRateHz,
        selection.mode.bandwidthHz,
      ).hardwareRetuneRequired
    )
      throw new Error(
        "HackRF reported center does not contain the selected channel.",
      );
    this.metadata = {
      source: "hackrf",
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
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
      hackrf: structuredClone(session.details),
    };
    return this.result();
  }
  private result(): Metadata {
    if (!this.metadata) throw new Error("HackRF is not configured.");
    const { sessionGeneration: _generation, ...metadata } = structuredClone(
      this.metadata,
    );
    return metadata;
  }
  selectDabService(key: string): void { this.pipeline.selectDabService(key); }

  setVolume(volume: number): void {
    this.volume = volume;
    this.pipeline.setVolume(volume);
  }
  setGain(_gainDb: number | null): Promise<number | null> {
    return Promise.reject(
      new Error(
        "HackRF uses independently configured RX stages, not RTL auto/manual gain.",
      ),
    );
  }
  tune(channelFrequencyHz: number, generation: number, options: ReceiverTuneOptions = {}): Promise<Metadata> {
    return this.reconfigureChannel(
      channelFrequencyHz,
      this.selection?.mode,
      generation,
      false,
      options,
    );
  }
  scanTune(centerFrequencyHz: number, generation: number): Promise<Metadata> {
    return this.reconfigureChannel(
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
    return this.reconfigureChannel(
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
      throw new Error("HackRF reception must be running before changing analog settings.");
    const mode = normalizeModeSettings(settings);
    if (mode.mode !== this.metadata.mode)
      throw new Error("Live analog settings cannot change receiver mode.");
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
  private validateCenter(mode: ReceiverModeSettings, channel: number): void {
    if (mode.mode === "ADS-B" && channel !== ADSB_FREQUENCY_HZ)
      throw new Error(
        "HackRF ADS-B reception requires a 1090 MHz hardware center.",
      );
  }
  private async reconfigureChannel(
    channel: number,
    settings: ReceiverModeSettings | undefined,
    generation: number,
    scan: boolean,
    options: ReceiverTuneOptions = {},
  ): Promise<Metadata> {
    // All validation precedes invalidation, so an unsupported mode keeps its route.
    if (!this.receiving || !this.selection || !this.metadata || !settings)
      return Promise.reject(
        new Error("HackRF reception must be running before tuning."),
      );
    let mode: ReceiverModeSettings;
    try {
      mode = normalizeModeSettings(settings);
      this.validateCenter(mode, channel);
      validateSourceRoute(
        "hackrf",
        mode,
        this.metadata.actualSampleRateHz,
        channel,
        this.identity,
      );
      if (scan)
        validateSourceFrequency(
          "hackrf",
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
      validateSourceFrequency(this.metadata.source, center, this.metadata.actualSampleRateHz, this.identity);
    const hardware =
      scan ||
      plan.hardwareRetuneRequired ||
      (mustCenter &&
        this.transportSession?.details.captureSettings
          .requestedCenterFrequencyHz !== channel);
    return this.run("tune", async (token) => {
      this.finishRecording("metadata-change");
      this.sessionGeneration = generation;
      if (!hardware) {
        this.publishMetadata(this.transportSession!, selection);
        this.adapter.ready({ ...this.transportSession!, generation });
        if (["APRS", "RS41"].includes((this.metadata!).mode)) {
          await this.pipeline.prepare(this.metadata!);
        }
        this.pipeline.retune(this.metadata!);
        this.sampleBase = undefined;
        this.sequence = 0;
        this.selection = selection;
        return this.result();
      }
      this.invalidateSamples();
      await this.prepare(selection, token, center);
      this.check(token);
      this.selection = selection;
      return this.startConfigured(selection, token);
    });
  }
  configureHardware(
    settings: HackrfRxSettings,
    generation: number,
  ): Promise<Metadata> {
    if (!this.selection || !this.metadata)
      return Promise.reject(
        new Error("HackRF must be connected before setting RX stages."),
      );
    let validated: HackrfRxSettings;
    try {
      validated = validateHackrfRxSettings(settings, this.identity?.kind);
    } catch (error) {
      return Promise.reject(error);
    }
    const selection = { ...this.selection, settings: validated };
    const wasRunning = this.receiving;
    const center =
      this.transportSession!.details.captureSettings.requestedCenterFrequencyHz;
    return this.run("hardware", async (token) => {
      this.finishRecording("metadata-change");
      this.invalidateSamples();
      this.sessionGeneration = generation;
      await this.prepare(selection, token, center);
      this.check(token);
      this.selection = selection;
      if (wasRunning) return this.startConfigured(selection, token);
      return this.publishMetadata(this.transportSession!, selection);
    });
  }
  startRecording(survey?: SurveyCaptureContext, options?: RecordingOptions): RecordingStatus {
    if (!this.receiving || !this.metadata)
      throw new Error("HackRF is not receiving.");
    if (this.recorder || this.completedRecording)
      throw new Error("Finish or retrieve the existing recording first.");
    this.recorder = new IqRecorder(
      this.metadata,
      undefined,
      undefined,
      undefined,
      survey,
      hackrfRecordingFormat(this.metadata.hackrf),
      preferredRecordingStorageMode(options?.storageMode),
      options,
    );
    return this.recorder.status();
  }
  private finishRecording(
    reason: "user" | "source-stop" | "metadata-change",
  ): void {
    if (!this.recorder) return;
    this.completedRecording = this.recorder.finish(reason);
    this.recorder = undefined;
  }
  stopRecording(
    reason: "user" | "source-stop" | "metadata-change" = "user",
  ): IqRecording | undefined {
    this.finishRecording(reason);
    const result = this.completedRecording;
    this.completedRecording = undefined;
    return result;
  }
  getRecordingStatus(): RecordingStatus | undefined {
    return this.recorder?.status();
  }
  private run(
    name: string,
    body: (token: number) => Promise<Metadata>,
  ): Promise<Metadata> {
    if (this.disconnectRequested || this.stopTask)
      return Promise.reject(abort());
    if (this.command) {
      if (
        this.command.name === name &&
        (name === "connect" || name === "start")
      )
        return this.command.task;
      return Promise.reject(
        new Error("HackRF receiver is busy applying a command."),
      );
    }
    const token = this.cancelled;
    const task = body(token).finally(() => {
      if (this.command?.task === task) this.command = undefined;
    });
    this.command = { name, task };
    return task;
  }
  private check(token: number): void {
    if (token !== this.cancelled || this.disconnectRequested) throw abort();
  }
  private invalidateSamples(): void {
    this.receiving = false;
    this.rxToken = undefined;
    this.adapter.reset();
    this.pipeline.reset();
    this.sampleBase = undefined;
    this.sequence = 0;
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.finishRecording("source-stop");
    ++this.cancelled;
    this.invalidateSamples();
    this.configuredOff = false;
    const pending = this.command?.task;
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
    if (this.disconnected) return Promise.resolve();
    if (this.disconnectTask) return this.disconnectTask;
    this.finishRecording("source-stop");
    this.disconnectRequested = true;
    ++this.cancelled;
    this.invalidateSamples();
    const pending = this.command?.task;
    const task = (async () => {
      const results = await Promise.allSettled([
        this.transport.close(),
        this.pipeline.close(),
      ]);
      await pending?.catch(() => undefined);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      this.disconnected = true;
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
      "Acquisition failure; missing hardware samples are unknown.",
    );
    this.finishRecording("source-stop");
    ++this.cancelled;
    this.invalidateSamples();
    this.configuredOff = false;
    this.events.runtimeError(error);
  };
}

export function createHackrfBackend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  generation = 0,
  dependencies?: HackrfBackendDependencies,
): ReceiverBackend {
  return new HackrfBackend(events, analysis, generation, dependencies);
}
