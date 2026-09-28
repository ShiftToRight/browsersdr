import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { ADSB_FREQUENCY_HZ } from "../adsb/adsbReceiver";
import { IngressTimings, type IngressDiagnostics } from "./ingressTimings";
import type { IqRecording, RecordingStatus } from "./iqRecording";
import type { SurveyCaptureContext } from "./fieldSurvey";
import {
  defaultModeSettings,
  normalizeModeSettings,
  type ReceiverModeSettings,
} from "./receiverConfig";
import type {
  ReceiverBackend,
  ReceiverBackendEvents,
  ReceiverStartOptions,
} from "./receiverController";
import {
  validateSourceConfiguration,
  validateSourceFrequency,
  validateSourceRoute,
} from "./sourceCapabilities";
import {
  createUsrpB205RequestedConfiguration,
  USRP_B205_SAMPLE_RATE_HZ,
  usrpB205RateProfile,
  type UsrpB205SampleRateHz,
  validateUsrpB205SessionDetails,
  type UsrpB205RxSettings,
  type UsrpB205SessionDetails,
} from "./usrpB205Capabilities";
import {
  UsrpB205Fx3Connection,
  type UsrpB205ClaimedBulkIo,
  type UsrpB205Fx3Diagnostics,
  type UsrpB205Fx3Identity,
} from "./usrpB205Fx3";
import type { VerifiedUsrpB205Image } from "./usrpB205Images";
import type { VerifiedUsrpB205Firmware } from "./usrpB205Firmware";
import { UsrpB205ControlLink } from "./usrpB205Control";
import {
  UsrpB205RxConfigurator,
  type UsrpB205Ad9364Driver,
  type UsrpB205ConfigurationDiagnostics,
  type UsrpB205RxBoundary,
} from "./usrpB205RxConfig";
import {
  UsrpB205RxTransport,
  type UsrpB205NativeBlock,
  type UsrpB205RxTransportDiagnostics,
  type UsrpB205RxTransportEvents,
} from "./usrpB205RxTransport";
import { UsrpB205SampleAdapter } from "./usrpB205Source";
import type {
  UsrpB205WorkerSessionEvents,
  UsrpB205WorkerSessionPort,
} from "./usrpB205WorkerSession";
import {
  LiveReceiverPipeline,
  type LiveReceiverDependencies,
} from "./liveReceiverPipeline";
import type { UsrpB205SourceSessionMetadata } from "./types";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { ChannelDiagnostics } from "./widebandChannel";
import { DEFAULT_USRP_B205_RX_SETTINGS } from "./usrpB205Capabilities";

type Metadata = Omit<UsrpB205SourceSessionMetadata, "sessionGeneration">;

interface Selection {
  readonly channel: number;
  readonly mode: ReceiverModeSettings;
  readonly settings: UsrpB205RxSettings;
  readonly sampleRateHz: UsrpB205SampleRateHz;
}

export type UsrpB205ConnectionPort = Pick<
  UsrpB205Fx3Connection,
  "requestAndOpen" | "open" | "claimedBulkIo" | "close" | "diagnostics"
>;
export type UsrpB205ControlPort = Pick<UsrpB205ControlLink, "start" | "close">;
export type UsrpB205ConfiguratorPort = Pick<
  UsrpB205RxConfigurator,
  "initialize" | "retune" | "startContinuous" | "stopContinuous" | "diagnostics"
>;
export type UsrpB205TransportPort = Pick<
  UsrpB205RxTransport,
  | "start"
  | "stopAndDrain"
  | "close"
  | "observedSessionDetails"
  | "diagnostics"
  | keyof UsrpB205RxBoundary
>;

export interface UsrpB205PipelinePort extends SampleReceiver {
  receiveUsrpSc16(bytes: Uint8Array, frequency: number): boolean;
  resume(): Promise<void>;
  requireRunning(): void;
  validateRateBudget(sampleRate: number): void;
  prepare(metadata: UsrpB205SourceSessionMetadata): Promise<void>;
  begin(metadata: UsrpB205SourceSessionMetadata, volume: number): void;
  retune(metadata: UsrpB205SourceSessionMetadata): void;
  markDiscontinuity(missingSamples: number | null): void;
  reset(): void;
  suspend(): Promise<void>;
  close(): Promise<void>;
  setVolume(volume: number): void;
  updateAnalogMode(settings: ReceiverModeSettings): void;
  selectDabService(key: string): void;
  readonly channelDiagnostics: ChannelDiagnostics | undefined;
}

export interface Usrpb205BackendDependencies extends LiveReceiverDependencies {
  usb?: USB;
  /** Must already be verified before the gesture that opens the chooser. */
  image?: VerifiedUsrpB205Image;
  firmware?: VerifiedUsrpB205Firmware;
  createAd9364Driver?: () => UsrpB205Ad9364Driver;
  createConnection?: () => UsrpB205ConnectionPort;
  createControl?: (
    io: UsrpB205ClaimedBulkIo,
    onFatal: (error: unknown) => void,
  ) => UsrpB205ControlLink;
  createConfigurator?: (
    identity: UsrpB205Fx3Identity,
    control: UsrpB205ControlLink,
    driver: UsrpB205Ad9364Driver,
    closeOwner: () => Promise<void>,
  ) => UsrpB205ConfiguratorPort;
  createTransport?: (
    io: UsrpB205ClaimedBulkIo,
    commands: UsrpB205ConfiguratorPort,
    details: UsrpB205SessionDetails,
    events: UsrpB205RxTransportEvents,
    closeOwner: () => Promise<void>,
  ) => UsrpB205TransportPort;
  /** Worker owns discovery after permission, configuration, control and RX. */
  createWorkerSession?: (
    events: UsrpB205WorkerSessionEvents,
  ) => UsrpB205WorkerSessionPort;
  createPipeline?: (
    events: ReceiverBackendEvents,
    analysis: AnalysisPipeline | undefined,
    timings: IngressTimings,
  ) => UsrpB205PipelinePort;
  nativeCapture?: (
    block: UsrpB205NativeBlock,
    metadata: Readonly<UsrpB205SourceSessionMetadata>,
  ) => void;
}

const cancelled = () =>
  new DOMException("USRP B205-mini receiver operation was cancelled.", "AbortError");

/** Persistent receive-only B205-mini backend. Protocol, RF configuration and
 * endpoint ownership remain in the Step 03–05 components it composes. */
export class Usrpb205Backend implements ReceiverBackend {
  private readonly ingressTimings = new IngressTimings([
    "Native capture",
    "Main-thread normalization",
    "GPU tap",
    "Spectrum copy",
    "Spectrum dispatch",
  ]);
  private readonly pipeline: UsrpB205PipelinePort;
  private readonly adapter: UsrpB205SampleAdapter;
  private connection?: UsrpB205ConnectionPort;
  private control?: UsrpB205ControlPort;
  private configurator?: UsrpB205ConfiguratorPort;
  private transport?: UsrpB205TransportPort;
  private workerSession?: UsrpB205WorkerSessionPort;
  private details?: UsrpB205SessionDetails;
  private selection?: Selection;
  private metadata?: UsrpB205SourceSessionMetadata;
  private receiving = false;
  private acquired = false;
  private disconnected = false;
  private disconnectRequested = false;
  private volume = 0;
  private transportGeneration = 0;
  private cancelled = 0;
  private command?: { name: string; task: Promise<Metadata> };
  private stopTask?: Promise<void>;
  private disconnectTask?: Promise<void>;

  constructor(
    private readonly events: ReceiverBackendEvents,
    analysis?: AnalysisPipeline,
    private sessionGeneration = 0,
    private readonly dependencies: Usrpb205BackendDependencies = {},
  ) {
    this.pipeline =
      dependencies.createPipeline?.(
        { ...events, runtimeError: this.runtimeError },
        analysis,
        this.ingressTimings,
      ) ??
      new LiveReceiverPipeline(
        { ...events, runtimeError: this.runtimeError },
        analysis,
        dependencies,
        this.ingressTimings,
      );
    this.adapter = new UsrpB205SampleAdapter(
      this.pipeline,
      (block) => dependencies.nativeCapture?.(block, this.metadata!),
      (gap) => this.pipeline.markDiscontinuity(gap.missingSamples),
      this.ingressTimings,
    );
  }

  get diagnostics(): {
    readonly connection: UsrpB205Fx3Diagnostics | null;
    readonly configuration: UsrpB205ConfigurationDiagnostics | null;
    readonly receive: UsrpB205RxTransportDiagnostics | null;
  } {
    if (this.workerSession) return this.workerSession.diagnostics;
    return {
      connection: this.connection?.diagnostics ?? null,
      configuration: this.configurator?.diagnostics ?? null,
      receive: this.transport?.diagnostics ?? null,
    };
  }

  getIngressDiagnostics(): IngressDiagnostics {
    const stages = this.ingressTimings.snapshot();
    const budgetMs = 4086 / (this.details?.nativeSampleRateHz ?? USRP_B205_SAMPLE_RATE_HZ) * 1000;
    const debtMs = Math.max(
      0,
      Object.values(stages).reduce((sum, stage) => sum + stage.meanMs, 0) -
        budgetMs,
    );
    return { stages, debtMs, budgetMs };
  }

  getChannelDiagnostics() {
    return this.pipeline.channelDiagnostics;
  }

  connect(options: ReceiverStartOptions): Promise<Metadata> {
    return this.run("connect", async (token) => {
      const selection = this.request(options);
      await this.prepare(selection, token);
      this.check(token);
      this.selection = selection;
      return this.publish(this.details!, selection);
    });
  }

  connectGranted(options: ReceiverStartOptions, device: USBDevice): Promise<Metadata> {
    return this.run("connect", async (token) => {
      const selection = this.request(options);
      await this.prepare(selection, token, device);
      this.check(token);
      this.selection = selection;
      return this.publish(this.details!, selection);
    });
  }

  start(options: ReceiverStartOptions, generation = this.sessionGeneration): Promise<Metadata> {
    if (this.receiving) return Promise.resolve(this.result());
    return this.run("start", async (token) => {
      const selection = this.request(options);
      this.sessionGeneration = generation;
      this.volume = options.volume;
      // Resume and chooser acquisition are both initiated before the first await.
      const resume = this.pipeline.resume();
      const prepared = this.prepare(selection, token);
      await Promise.all([resume, prepared]);
      this.check(token);
      this.pipeline.requireRunning();
      if (
        this.details!.configuration.requested.requestedCenterFrequencyHz !==
        selection.channel
      ) {
        throw new Error(
          "The connected USRP B205-mini is configured for another center; start it, then use the serialized tune operation.",
        );
      }
      if (this.details!.nativeSampleRateHz !== selection.sampleRateHz)
        throw new Error("Disconnect the USRP B205-mini before changing its sample rate.");
      this.selection = selection;
      return this.startConfigured(selection, token);
    });
  }

  private request(options: ReceiverStartOptions): Selection {
    if (options.source !== undefined && options.source !== "usrp-b205")
      throw new Error("Usrpb205Backend accepts only the USRP B205-mini source.");
    validateSourceConfiguration({ ...options, source: "usrp-b205" });
    const mode = normalizeModeSettings(
      options.modeSettings ?? defaultModeSettings("WBFM"),
    );
    if (mode.mode === "ADS-B" && options.channelFrequencyHz !== ADSB_FREQUENCY_HZ)
      throw new Error("USRP B205-mini ADS-B reception requires a 1090 MHz center.");
    const sampleRateHz = usrpB205RateProfile(options.sampleRateHz ?? USRP_B205_SAMPLE_RATE_HZ).sampleRateHz;
    validateSourceRoute("usrp-b205", mode, sampleRateHz, options.channelFrequencyHz);
    return {
      channel: options.channelFrequencyHz,
      mode,
      settings: options.usrpSettings ?? DEFAULT_USRP_B205_RX_SETTINGS,
      sampleRateHz,
    };
  }

  private async prepare(
    selection: Selection,
    token: number,
    grantedDevice?: USBDevice,
  ): Promise<void> {
    if (this.acquired) return;
    const image = this.dependencies.image;
    if (!image)
      throw new Error(
        "Import and verify the pinned official USRP B205-mini FPGA image before connecting; image loading cannot be deferred past the chooser gesture.",
      );
    const firmware = this.dependencies.firmware;
    if (!firmware)
      throw new Error(
        "Import and verify the pinned official USRP B205-mini FX3 firmware before connecting; WestBridge recovery cannot be deferred past the chooser gesture.",
      );
    const createWorkerSession = this.dependencies.createWorkerSession;
    if (createWorkerSession) {
      const usb = this.dependencies.usb ?? navigator.usb;
      if (!grantedDevice && !usb)
        throw new DOMException("WebUSB is unavailable; use HTTPS or localhost in a compatible browser.", "RadioError.NoUsbSupport");
      // Keep requestDevice on the unbroken initiating gesture stack. The
      // returned object remains closed; the worker resolves the authorization
      // by serial and becomes the sole USB interface owner.
      const permission = grantedDevice
        ? Promise.resolve(grantedDevice)
        : usb!.requestDevice({ filters: [{ vendorId: 0x2500, productId: 0x0022 }] });
      const device = await permission;
      this.check(token);
      this.acquired = true;
      this.events.permissionGranted();
      const worker = createWorkerSession({
        usrpSc16: (bytes, frequency, generation) => {
          if (this.receiving && generation === this.transportGeneration)
            this.pipeline.receiveUsrpSc16(bytes, frequency);
        },
        error: this.runtimeError,
        discontinuity: (gap) => {
          this.events.statusChanged?.(
            gap.missingSamples === null
              ? `USRP receive discontinuity: ${gap.reason}; loss count unknown.`
              : `USRP receive discontinuity: ${gap.reason}; ${gap.missingSamples} samples missing.`,
          );
          if (this.receiving) this.pipeline.markDiscontinuity(gap.missingSamples);
        },
        generationChanged: (generation, reason, next) => {
          this.transportGeneration = Math.max(this.transportGeneration, generation);
          this.details = structuredClone(next);
          if (this.selection) this.publish(next, this.selection);
          if (this.receiving && reason !== "retune") this.pipeline.markDiscontinuity(null);
        },
      });
      this.workerSession = worker;
      try {
        const details = await worker.initialize(
          device.serialNumber ?? null,
          image,
          firmware,
          createUsrpB205RequestedConfiguration(selection.channel, selection.sampleRateHz),
        );
        this.check(token);
        validateUsrpB205SessionDetails(details);
        this.details = details;
        this.pipeline.validateRateBudget(details.effectiveSampleRateHz);
        return;
      } catch (error) {
        try { await worker.close(); } catch { /* Worker retains diagnostic evidence until termination. */ }
        throw error;
      }
    }
    const createDriver = this.dependencies.createAd9364Driver;
    if (!createDriver)
      throw new Error(
        "The pinned receive-only AD9364 driver binding is unavailable in this build.",
      );
    const connection =
      this.connection ??
      (this.dependencies.createConnection?.() ?? new UsrpB205Fx3Connection());
    this.connection = connection;
    // requestAndOpen synchronously invokes requestDevice and preserves activation.
    const identityPromise = grantedDevice
      ? connection.open(grantedDevice, image, firmware, this.dependencies.usb ?? navigator.usb)
      : connection.requestAndOpen(image, this.dependencies.usb, firmware);
    const identity = await identityPromise;
    this.check(token);
    this.acquired = true;
    this.events.permissionGranted();
    try {
      const io = connection.claimedBulkIo();
      const closeOwner = () => connection.close();
      const control =
        this.dependencies.createControl?.(io, this.runtimeError) ??
        new UsrpB205ControlLink(io, { onFatal: this.runtimeError });
      this.control = control;
      const driver = createDriver();
      const configurator =
        this.dependencies.createConfigurator?.(
          identity,
          control as UsrpB205ControlLink,
          driver,
          closeOwner,
        ) ?? new UsrpB205RxConfigurator(identity, control as UsrpB205ControlLink, driver, { closeOwner });
      this.configurator = configurator;
      const details = await configurator.initialize(
        createUsrpB205RequestedConfiguration(selection.channel, selection.sampleRateHz),
      );
      this.check(token);
      validateUsrpB205SessionDetails(details);
      this.details = details;
      this.pipeline.validateRateBudget(details.effectiveSampleRateHz);
      const transportEvents: UsrpB205RxTransportEvents = {
      error: this.runtimeError,
      discontinuity: (gap) =>
        this.events.statusChanged?.(
          gap.missingSamples === null
            ? `USRP receive discontinuity: ${gap.reason}; loss count unknown.`
            : `USRP receive discontinuity: ${gap.reason}; ${gap.missingSamples} samples missing.`,
        ),
      generationChanged: (generation, reason, next) => {
        this.transportGeneration = Math.max(this.transportGeneration, generation);
        this.details = structuredClone(next);
        if (this.selection) this.publish(next, this.selection);
        this.adapter.ready({ generation, details: next });
        if (this.receiving && reason !== "retune")
          this.pipeline.markDiscontinuity(null);
      },
      };
      this.transport =
        this.dependencies.createTransport?.(
          io,
          configurator,
          details,
          transportEvents,
          closeOwner,
        ) ?? new UsrpB205RxTransport(io, configurator, details, transportEvents, { closeOwner });
    } catch (error) {
      try { await this.control?.close(error); } catch { /* Connection owns retryable cleanup. */ }
      try { await connection.close(); } catch { /* disconnect() retries retained ownership. */ }
      throw error;
    }
  }

  private async startConfigured(selection: Selection, token: number): Promise<Metadata> {
    const metadata = this.publish(this.details!, selection);
    await this.pipeline.prepare({ ...metadata, sessionGeneration: this.sessionGeneration });
    this.check(token);
    const generation = ++this.transportGeneration;
    this.adapter.ready({ generation, details: this.details! });
    this.pipeline.begin({ ...metadata, sessionGeneration: this.sessionGeneration }, this.volume);
    this.receiving = true;
    try {
      if (this.workerSession) await this.workerSession.start(generation);
      else await this.transport!.start(generation, (block) => {
          if (this.receiving) this.adapter.receive(block);
        });
      this.check(token);
      return this.result();
    } catch (error) {
      this.invalidateSamples();
      throw error;
    }
  }

  private publish(details: UsrpB205SessionDetails, selection: Selection): Metadata {
    validateUsrpB205SessionDetails(details);
    validateSourceRoute(
      "usrp-b205",
      selection.mode,
      details.nativeSampleRateHz,
      selection.channel,
    );
    this.pipeline.validateRateBudget(details.nativeSampleRateHz);
    this.metadata = {
      source: "usrp-b205",
      sessionGeneration: this.sessionGeneration,
      requestedSampleRateHz:
        details.configuration.requested.requestedSampleRateHz,
      actualSampleRateHz: details.nativeSampleRateHz,
      hardwareCenterFrequencyHz:
        details.configuration.acceptedCenterFrequencyHz,
      selectedChannelFrequencyHz: selection.channel,
      mode: selection.mode.mode,
      channelBandwidthHz: selection.mode.bandwidthHz,
      squelch: selection.mode.squelch,
      beatToneHz: selection.mode.beatToneHz,
      srd: selection.mode.srd,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
      usrpB205: structuredClone(details),
    };
    return this.result();
  }

  private result(): Metadata {
    if (!this.metadata) throw new Error("USRP B205-mini is not configured.");
    if ((this.transport || this.workerSession) && this.details) {
      const observed = this.workerSession?.observedSessionDetails
        ?? this.transport!.observedSessionDetails;
      validateUsrpB205SessionDetails(observed);
      this.details = observed;
      this.metadata = { ...this.metadata, usrpB205: structuredClone(observed) };
    }
    const { sessionGeneration: _generation, ...metadata } = structuredClone(
      this.metadata,
    );
    return metadata;
  }

  tune(channelFrequencyHz: number, generation: number): Promise<Metadata> {
    return this.reconfigure(channelFrequencyHz, this.selection?.mode, generation, false);
  }

  scanTune(centerFrequencyHz: number, generation: number): Promise<Metadata> {
    return this.reconfigure(centerFrequencyHz, this.selection?.mode, generation, true);
  }

  configureMode(settings: ReceiverModeSettings, generation: number): Promise<Metadata> {
    const mode = normalizeModeSettings(settings);
    const channel = mode.mode === "ADS-B" ? ADSB_FREQUENCY_HZ : (this.selection?.channel ?? 0);
    return this.reconfigure(channel, mode, generation, false);
  }

  private reconfigure(
    channel: number,
    requestedMode: ReceiverModeSettings | undefined,
    generation: number,
    scan: boolean,
  ): Promise<Metadata> {
    if (!this.receiving || !this.selection
      || (!this.workerSession && (!this.transport || !this.configurator)) || !requestedMode)
      return Promise.reject(new Error("USRP B205-mini reception must be running before tuning."));
    let mode: ReceiverModeSettings;
    try {
      mode = normalizeModeSettings(requestedMode);
      validateSourceRoute("usrp-b205", mode, this.selection.sampleRateHz, channel);
      if (mode.mode === "ADS-B" && channel !== ADSB_FREQUENCY_HZ)
        throw new Error("USRP B205-mini ADS-B reception requires a 1090 MHz center.");
      if (scan) validateSourceFrequency("usrp-b205", channel, mode.bandwidthHz);
    } catch (error) {
      return Promise.reject(error);
    }
    const selection: Selection = { ...this.selection, channel, mode };
    return this.run("retune", async (token) => {
      this.invalidateSamples();
      this.sessionGeneration = generation;
      this.selection = selection;
      const workerDetails = this.workerSession
        ? await this.workerSession.retune(channel)
        : undefined;
      if (!this.workerSession) await this.configurator!.retune(channel, this.transport!);
      this.check(token);
      const details = workerDetails ?? this.transport!.observedSessionDetails;
      validateUsrpB205SessionDetails(details);
      this.details = details;
      const metadata = this.publish(details, selection);
      await this.pipeline.prepare({ ...metadata, sessionGeneration: generation });
      this.check(token);
      if (!this.workerSession)
        this.adapter.ready({ generation: this.transport!.diagnostics.generation, details });
      this.pipeline.retune({ ...metadata, sessionGeneration: generation });
      this.receiving = true;
      return this.result();
    });
  }

  updateAnalogMode(settings: ReceiverModeSettings): Metadata {
    if (!this.receiving || !this.selection || !this.metadata)
      throw new Error("USRP B205-mini reception must be running before changing analog settings.");
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

  setVolume(volume: number): void {
    this.volume = volume;
    this.pipeline.setVolume(volume);
  }

  setGain(_gainDb: number | null): Promise<number | null> {
    return Promise.reject(
      new Error("USRP B205-mini release 1 uses fixed slow-attack AGC with no exposed gain value."),
    );
  }

  selectDabService(key: string): void {
    this.pipeline.selectDabService(key);
  }

  startRecording(_survey?: SurveyCaptureContext): RecordingStatus {
    throw new Error(
      "USRP B205-mini recording is unavailable in release 1: native CHDR/VRT SC16 capture, gap-preserving replay and SigMF provenance are not yet implemented.",
    );
  }

  stopRecording(): IqRecording | undefined {
    return undefined;
  }

  getRecordingStatus(): RecordingStatus | undefined {
    return undefined;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.receiving && !this.command) return Promise.resolve();
    ++this.cancelled;
    this.invalidateSamples();
    const pending = this.command?.task;
    const task = (async () => {
      await pending?.catch(() => undefined);
      const results = await Promise.allSettled([
        this.workerSession?.stopAndDrain()
          ?? this.transport?.stopAndDrain()
          ?? Promise.resolve(),
        this.pipeline.suspend(),
      ]);
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
    this.disconnectRequested = true;
    ++this.cancelled;
    this.invalidateSamples();
    const pending = this.command?.task;
    const task = (async () => {
      const results = await Promise.allSettled([
        this.workerSession?.close()
          ?? this.transport?.close()
          ?? this.connection?.close()
          ?? Promise.resolve(),
        this.control?.close(cancelled()) ?? Promise.resolve(),
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

  private run(name: string, body: (token: number) => Promise<Metadata>): Promise<Metadata> {
    if (this.disconnectRequested || this.stopTask) return Promise.reject(cancelled());
    if (this.command) {
      if (this.command.name === name && (name === "connect" || name === "start"))
        return this.command.task;
      return Promise.reject(new Error("USRP B205-mini receiver is busy applying a command."));
    }
    const token = this.cancelled;
    const task = body(token).finally(() => {
      if (this.command?.task === task) this.command = undefined;
    });
    this.command = { name, task };
    return task;
  }

  private check(token: number): void {
    if (token !== this.cancelled || this.disconnectRequested) throw cancelled();
  }

  private invalidateSamples(): void {
    this.receiving = false;
    this.adapter.reset();
    this.pipeline.reset();
  }

  private readonly runtimeError = (error: unknown): void => {
    if (this.disconnectRequested) return;
    ++this.cancelled;
    this.invalidateSamples();
    this.events.runtimeError(error);
  };
}

export function createUsrpb205Backend(
  events: ReceiverBackendEvents,
  analysis?: AnalysisPipeline,
  generation = 0,
  dependencies?: Usrpb205BackendDependencies,
): ReceiverBackend {
  return new Usrpb205Backend(events, analysis, generation, dependencies);
}
