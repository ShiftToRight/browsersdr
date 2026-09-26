import type { IngressDiagnostics } from "./ingressTimings";
import type { ChannelDiagnostics } from "./widebandChannel";
import type {
  AdsbSnapshot,
  AisSnapshot,
  DabSnapshot,
  RdsSnapshot,
  ReceiverLifecycle,
  SourceKind,
  SourceSessionMetadata,
  SquelchMeterState,
} from "./types";
import type { SrdSnapshot } from "../srd/types";
import type { DigitalWorkerAdapterDiagnostics } from "../digital";
import {
  normalizeGain,
  normalizeModeSettings,
  type ReceiverModeSettings,
} from "./receiverConfig";
import type { IqRecording, RecordingStatus } from "./iqRecording";
import type { SurveyCaptureContext } from "./fieldSurvey";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";
import {
  LIVE_SAMPLE_RATES_HZ,
  sourceCapabilities,
  validateSourceConfiguration,
  validateSourceRoute,
  validateSourceFrequency,
  validateHackrfRxSettings,
  type HackrfRxSettings,
} from "./sourceCapabilities";

export const FM_MIN_HZ = 87_500_000;
export const FM_MAX_HZ = 108_000_000;
export const RTL_SAMPLE_RATE_HZ = 1_024_000;
export const RTL_SAMPLE_RATE_OPTIONS_HZ = LIVE_SAMPLE_RATES_HZ;

export interface ReceiverStartOptions {
  source?: SourceKind;
  channelFrequencyHz: number;
  volume: number;
  modeSettings?: ReceiverModeSettings;
  gainDb?: number | null;
  sampleRateHz?: number;
  hardwareSettings?: HackrfRxSettings;
}

export interface ReceiverBackendEvents {
  permissionGranted(): void;
  statusChanged?(message: string): void;
  runtimeError(error: unknown): void;
  audioStateChanged(state: AudioContextState): void;
  sourceEnded(): void;
  rdsChanged(state: RdsSnapshot): void;
  dabChanged?(state: DabSnapshot): void;
  adsbChanged?(state: AdsbSnapshot): void;
  aisChanged?(state: AisSnapshot): void;
  srdChanged?(
    state: SrdSnapshot,
    diagnostics: DigitalWorkerAdapterDiagnostics,
  ): void;
  squelchChanged?(state: SquelchMeterState): void;
}

export interface ReceiverBackend {
  getIngressDiagnostics?(): IngressDiagnostics | undefined;
  getChannelDiagnostics?(): ChannelDiagnostics | undefined;
  /** Optional persistent hardware connection used by RTL-SDR. */
  connect?(
    options: ReceiverStartOptions,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  /** Connect an already-authorized WebUSB device without opening the chooser. */
  connectGranted?(
    options: ReceiverStartOptions,
    device: USBDevice,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  start(
    options: ReceiverStartOptions,
    sessionGeneration?: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  stop(): Promise<void>;
  /** Final teardown for a persistent backend. */
  disconnect?(): Promise<void>;
  selectDabService?(key: string): void;
  setVolume(volume: number): void;
  tune(
    channelFrequencyHz: number,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  /** Explicit acquisition-center retune used by bounded spectrum scans. */
  scanTune?(
    centerFrequencyHz: number,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  configureMode(
    settings: ReceiverModeSettings,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  /** Update the active analog demodulator without retuning or replacing the
   * acquisition generation. Only same-mode bandwidth/squelch/tone changes are
   * accepted by the controller. */
  updateAnalogMode?(
    settings: ReceiverModeSettings,
  ): Omit<SourceSessionMetadata, "sessionGeneration">;
  setGain(gainDb: number | null): Promise<number | null>;
  /** Finish the old capture before invocation. Backend must invalidate old samples,
   * apply settings at a clean boundary and return accepted metadata after settling.
   * Rejection closes the session; no partial accepted configuration is published. */
  configureHardware?(
    settings: HackrfRxSettings,
    sessionGeneration: number,
  ): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  startRecording?(survey?: SurveyCaptureContext): RecordingStatus;
  stopRecording?(
    reason?: "user" | "source-stop" | "metadata-change",
  ): IqRecording | undefined;
  getRecordingStatus?(): RecordingStatus | undefined;
}

export type ReceiverBackendFactory = (
  events: ReceiverBackendEvents,
  options: ReceiverStartOptions,
  sessionGeneration: number,
) => ReceiverBackend;

export interface ReceiverSnapshot {
  lifecycle: ReceiverLifecycle;
  message: string;
  sessionGeneration: number;
  session?: SourceSessionMetadata;
  audioState?: AudioContextState;
  rds?: RdsSnapshot;
  dab?: DabSnapshot;
  adsb?: AdsbSnapshot;
  ais?: AisSnapshot;
  srd?: SrdSnapshot;
  srdWorker?: DigitalWorkerAdapterDiagnostics;
  /** A failed close retains ownership; only Stop/retry is safe until it closes. */
  cleanupRequired?: boolean;
}

type Listener = (snapshot: ReceiverSnapshot) => void;
type SquelchMeterListener = () => void;

const INITIAL_SNAPSHOT: ReceiverSnapshot = {
  lifecycle: "idle",
  message: "Receiver not started",
  sessionGeneration: 0,
};

export class ReceiverController {
  private snapshot: ReceiverSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<Listener>();
  private squelchMeter: SquelchMeterState | undefined;
  private readonly squelchMeterListeners = new Set<SquelchMeterListener>();
  private backend?: ReceiverBackend;
  private startTask?: Promise<void>;
  private generation = 0;
  private completedRecording?: IqRecording;
  private readonly cleanupTasks = new Map<ReceiverBackend, Promise<void>>();

  constructor(private readonly createBackend: ReceiverBackendFactory) {}

  private lastIngress?: IngressDiagnostics;
  getIngressDiagnostics = (): IngressDiagnostics | undefined =>
    this.backend?.getIngressDiagnostics?.() ?? this.lastIngress;
  getChannelDiagnostics = (): ChannelDiagnostics | undefined =>
    this.backend?.getChannelDiagnostics?.();

  getSnapshot = (): ReceiverSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSquelchMeterSnapshot = (): SquelchMeterState | undefined =>
    this.squelchMeter;

  subscribeSquelchMeter = (listener: SquelchMeterListener): (() => void) => {
    this.squelchMeterListeners.add(listener);
    return () => this.squelchMeterListeners.delete(listener);
  };

  start(options: ReceiverStartOptions): Promise<void> {
    const restartingConnectedBackend =
      this.snapshot.lifecycle === "connected" && Boolean(this.backend?.connect);
    if (
      !restartingConnectedBackend &&
      this.snapshot.lifecycle !== "idle" &&
      this.snapshot.lifecycle !== "error"
    ) {
      return this.startTask ?? Promise.resolve();
    }
    if (this.backend && !restartingConnectedBackend) return Promise.resolve();

    const generation = ++this.generation;
    try {
      validateOptions(options);
    } catch (error) {
      this.publishFailure(generation, error);
      return Promise.resolve();
    }
    const source = options.source ?? "rtl-sdr";
    this.publish({
      lifecycle: sourceCapabilities(source).requiresUsb
        ? "requesting-permission"
        : "starting",
      message:
        source === "synthetic"
          ? "Starting the synthetic RF spectrum demo…"
          : source === "replay"
            ? "Starting paced I/Q replay and audio…"
            : `Choose ${options.source === "hackrf" || options.source === "bladerf" ? "a" : "an"} ${sourceCapabilities(source).label} device in the browser prompt…`,
      sessionGeneration: generation,
      session: this.snapshot.session,
      audioState: this.snapshot.audioState,
    });

    let backend = this.backend;
    if (!backend) {
      try {
        backend = this.createAndAttachBackend(options, generation);
      } catch (error) {
        this.publishFailure(generation, error);
        return Promise.resolve();
      }
    } else {
      this.publish({
        ...this.snapshot,
        lifecycle: "starting",
        message: `Starting ${options.modeSettings?.mode ?? "WBFM"} reception…`,
        sessionGeneration: generation,
      });
    }
    const task = this.runStart(backend, options, generation);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    return task;
  }

  async connect(options: ReceiverStartOptions): Promise<void> {
    await this.connectDevice(options);
  }

  async connectGranted(
    options: ReceiverStartOptions,
    device: USBDevice,
  ): Promise<void> {
    await this.connectDevice(options, device);
  }

  private async connectDevice(
    options: ReceiverStartOptions,
    grantedDevice?: USBDevice,
  ): Promise<void> {
    if (
      this.snapshot.lifecycle !== "idle" &&
      this.snapshot.lifecycle !== "error"
    )
      return;
    if (this.backend) return;
    const generation = ++this.generation;
    try {
      validateOptions(options);
    } catch (error) {
      this.publishFailure(generation, error);
      return;
    }
    let backend: ReceiverBackend;
    try {
      backend = this.createAndAttachBackend(options, generation);
    } catch (error) {
      this.publishFailure(generation, error);
      return;
    }
    if (!backend.connect) {
      await this.runStart(backend, options, generation);
      return;
    }
    this.publish({
      lifecycle: grantedDevice ? "connecting" : "requesting-permission",
      message: grantedDevice
        ? `Reconnecting the authorized ${sourceCapabilities(options.source ?? "rtl-sdr").label} device…`
        : `Choose ${options.source === "hackrf" || options.source === "bladerf" ? "a" : "an"} ${sourceCapabilities(options.source ?? "rtl-sdr").label} device in the browser prompt…`,
      sessionGeneration: generation,
    });
    try {
      if (grantedDevice && !backend.connectGranted)
        throw new Error(
          "This receiver cannot reconnect an authorized USB device.",
        );
      const metadata = grantedDevice
        ? await backend.connectGranted!(options, grantedDevice)
        : await backend.connect(options);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishConnected(
        metadata,
        generation,
        `${sourceCapabilities(metadata.source).label} connected. Start reception when ready.`,
      );
    } catch (error) {
      try {
        await this.cleanupBackend(backend);
      } catch {
        /* Retain ownership for cleanup retry. */
      }
      if (generation === this.generation)
        this.publishFailure(generation, error);
    }
  }

  async stop(): Promise<void> {
    if (this.snapshot.lifecycle === "idle") return;
    if (this.snapshot.lifecycle === "connected") return;
    if (this.snapshot.lifecycle === "stopping") {
      await this.cleanupTasks.get(this.backend!);
      return;
    }

    const generation = ++this.generation;
    const backend = this.backend;
    this.captureCompletedRecording(backend?.stopRecording?.("source-stop"));
    const persistent = Boolean(backend?.disconnect);
    const preserveConnection =
      persistent && ["running", "tuning"].includes(this.snapshot.lifecycle);
    this.publish({
      lifecycle: "stopping",
      message: preserveConnection
        ? "Stopping sample transfers; keeping the device connected…"
        : "Stopping sample transfers and closing the source…",
      sessionGeneration: generation,
      session: this.snapshot.session,
      audioState: this.snapshot.audioState,
    });

    try {
      if (preserveConnection && backend) await backend.stop();
      else await this.cleanupBackend(backend);
      if (generation === this.generation) {
        if (preserveConnection && this.snapshot.session)
          this.publishConnected(
            this.snapshot.session,
            generation,
            `Reception stopped. ${sourceCapabilities(this.snapshot.session.source).label} remains connected.`,
          );
        else
          this.publish({
            lifecycle: "idle",
            message: "Receiver stopped.",
            sessionGeneration: generation,
          });
      }
    } catch (error) {
      this.publishFailure(generation, error);
    }
  }

  async disconnect(): Promise<void> {
    const backend = this.backend;
    if (!backend) {
      if (this.snapshot.lifecycle !== "idle")
        this.publish({
          lifecycle: "idle",
          message: "Receiver disconnected.",
          sessionGeneration: ++this.generation,
        });
      return;
    }
    const generation = ++this.generation;
    this.captureCompletedRecording(backend.stopRecording?.("source-stop"));
    this.publish({
      ...this.snapshot,
      lifecycle: "disconnecting",
      message: "Releasing the signal source…",
      sessionGeneration: generation,
    });
    try {
      await this.cleanupBackend(backend);
      if (generation === this.generation)
        this.publish({
          lifecycle: "idle",
          message: "Receiver disconnected.",
          sessionGeneration: generation,
        });
    } catch (error) {
      if (generation === this.generation)
        this.publishFailure(generation, error);
    }
  }

  selectDabService(key: string): void {
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.snapshot.dab?.stations?.some(
        (station) => station.key === key && station.playable,
      )
    )
      return;
    this.backend?.selectDabService?.(key);
  }

  setVolume(volume: number): void {
    const safeVolume = clampVolume(volume);
    this.backend?.setVolume(safeVolume);
  }

  startRecording(survey?: SurveyCaptureContext): RecordingStatus | undefined {
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.backend ||
      this.completedRecording
    )
      return undefined;
    return this.backend.startRecording?.(survey);
  }

  stopRecording(): IqRecording | undefined {
    const recording = this.backend?.stopRecording?.("user");
    this.captureCompletedRecording(recording);
    return recording;
  }

  getRecordingStatus(): RecordingStatus | undefined {
    return this.backend?.getRecordingStatus?.();
  }

  finalizeCapacityRecording(): IqRecording | undefined {
    if (this.backend?.getRecordingStatus?.()?.state !== "capacity-reached")
      return undefined;
    const recording = this.backend.stopRecording?.("user");
    this.captureCompletedRecording(recording);
    return recording;
  }

  takeCompletedRecording(): IqRecording | undefined {
    const recording = this.completedRecording;
    this.completedRecording = undefined;
    return recording;
  }

  async tune(channelFrequencyHz: number): Promise<void> {
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.snapshot.session ||
      !this.backend
    )
      return;
    try {
      const session = this.snapshot.session;
      validateSourceRoute(
        session.source,
        {
          mode: session.mode,
          bandwidthHz: session.channelBandwidthHz,
          squelch: session.squelch,
          beatToneHz: session.beatToneHz,
        },
        session.actualSampleRateHz,
        channelFrequencyHz,
      );
    } catch (error) {
      this.publish({
        ...this.snapshot,
        message:
          error instanceof Error
            ? error.message
            : "Enter a valid channel frequency.",
      });
      return;
    }
    this.captureCompletedRecording(
      this.backend.stopRecording?.("metadata-change"),
    );
    const generation = ++this.generation;
    const backend = this.backend;
    this.publish({
      lifecycle: "tuning",
      message: `Retuning to ${(channelFrequencyHz / 1_000_000).toFixed(3)} MHz…`,
      sessionGeneration: generation,
      session: {
        ...this.snapshot.session,
        sessionGeneration: generation,
        selectedChannelFrequencyHz: channelFrequencyHz,
      },
      audioState: this.snapshot.audioState,
    });
    try {
      const metadata = await backend.tune(channelFrequencyHz, generation);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishRunning(metadata, generation);
    } catch (error) {
      if (generation === this.generation && this.backend === backend)
        await this.failBackend(backend, error);
    }
  }

  async scanTune(
    centerFrequencyHz: number,
  ): Promise<SourceSessionMetadata | undefined> {
    const backend = this.backend;
    const scanTune = backend?.scanTune;
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.snapshot.session ||
      !backend ||
      !scanTune
    )
      return undefined;
    try {
      validateSourceFrequency(
        this.snapshot.session.source,
        centerFrequencyHz,
        this.snapshot.session.source === "hackrf" ||
          this.snapshot.session.source === "bladerf"
          ? this.snapshot.session.actualSampleRateHz
          : 0,
      );
    } catch (error) {
      this.publish({
        ...this.snapshot,
        message:
          error instanceof Error
            ? error.message
            : "Enter a valid scan frequency.",
      });
      return undefined;
    }
    this.captureCompletedRecording(backend.stopRecording?.("metadata-change"));
    const generation = ++this.generation;
    this.publish({
      ...this.snapshot,
      lifecycle: "tuning",
      message: `Scanning ${(centerFrequencyHz / 1_000_000).toFixed(3)} MHz…`,
      sessionGeneration: generation,
      session: {
        ...this.snapshot.session,
        sessionGeneration: generation,
        hardwareCenterFrequencyHz: centerFrequencyHz,
        selectedChannelFrequencyHz: centerFrequencyHz,
      },
      rds: undefined,
    });
    try {
      const metadata = await scanTune.call(
        backend,
        centerFrequencyHz,
        generation,
      );
      if (generation !== this.generation || this.backend !== backend)
        return undefined;
      this.publishRunning(metadata, generation);
      return { ...metadata, sessionGeneration: generation };
    } catch (error) {
      if (generation === this.generation && this.backend === backend)
        await this.failBackend(backend, error);
      return undefined;
    }
  }

  async configureMode(settings: ReceiverModeSettings): Promise<void> {
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.snapshot.session ||
      !this.backend
    )
      return;
    let normalized: ReceiverModeSettings;
    try {
      normalized = normalizeModeSettings(settings);
      validateSourceRoute(
        this.snapshot.session.source,
        normalized,
        this.snapshot.session.actualSampleRateHz,
        this.snapshot.session.selectedChannelFrequencyHz,
      );
    } catch (error) {
      this.publish({
        ...this.snapshot,
        message:
          error instanceof Error
            ? error.message
            : "Invalid receiver mode settings.",
      });
      return;
    }
    this.captureCompletedRecording(
      this.backend.stopRecording?.("metadata-change"),
    );
    const generation = ++this.generation;
    const backend = this.backend;
    this.publish({
      ...this.snapshot,
      lifecycle: "tuning",
      message: `Applying ${normalized.mode} channel settings…`,
      sessionGeneration: generation,
      session: {
        ...this.snapshot.session,
        sessionGeneration: generation,
        mode: normalized.mode,
        channelBandwidthHz: normalized.bandwidthHz,
        squelch: normalized.squelch,
        beatToneHz: normalized.beatToneHz,
        srd: normalized.srd,
      },
    });
    try {
      const metadata = await backend.configureMode(normalized, generation);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishRunning(metadata, generation);
    } catch (error) {
      if (generation === this.generation && this.backend === backend)
        await this.failBackend(backend, error);
    }
  }

  updateAnalogMode(settings: ReceiverModeSettings): void {
    if (
      this.snapshot.lifecycle !== "running" ||
      !this.snapshot.session ||
      !this.backend
    )
      return;
    let normalized: ReceiverModeSettings;
    try {
      normalized = normalizeModeSettings(settings);
      if (normalized.mode !== this.snapshot.session.mode)
        throw new Error("Live analog settings cannot change receiver mode.");
      if (["OFF", "DAB", "ADS-B", "AIS", "SRD"].includes(normalized.mode))
        throw new Error(
          `${normalized.mode} does not use the analog audio path.`,
        );
      validateSourceRoute(
        this.snapshot.session.source,
        normalized,
        this.snapshot.session.actualSampleRateHz,
        this.snapshot.session.selectedChannelFrequencyHz,
      );
      if (!this.backend.updateAnalogMode)
        throw new Error("This source cannot update analog settings live.");
      const metadata = this.backend.updateAnalogMode(normalized);
      this.publish({
        ...this.snapshot,
        session: {
          ...metadata,
          sessionGeneration: this.snapshot.sessionGeneration,
        },
      });
    } catch (error) {
      this.publish({
        ...this.snapshot,
        message:
          error instanceof Error
            ? error.message
            : "Invalid live analog settings.",
      });
    }
  }

  async setGain(gainDb: number | null): Promise<void> {
    if (
      !["connected", "running"].includes(this.snapshot.lifecycle) ||
      !this.snapshot.session ||
      !this.backend
    )
      return;
    const backend = this.backend;
    if (this.snapshot.session.source === "hackrf") {
      this.publish({
        ...this.snapshot,
        message: "HackRF uses RX stage settings, not RTL auto/manual gain.",
      });
      return;
    }
    try {
      normalizeGain(gainDb);
    } catch (error) {
      this.publish({ ...this.snapshot, message: describeReceiverError(error) });
      return;
    }
    this.captureCompletedRecording(backend.stopRecording?.("metadata-change"));
    const generation = this.generation;
    try {
      const actual = await backend.setGain(normalizeGain(gainDb));
      if (
        this.backend !== backend ||
        this.generation !== generation ||
        !this.snapshot.session
      )
        return;
      this.publish({
        ...this.snapshot,
        message:
          actual === null
            ? "Automatic RF gain enabled."
            : `Manual RF gain set to ${actual.toFixed(1)} dB.`,
        session: { ...this.snapshot.session, gainDb: actual },
      });
    } catch (error) {
      if (this.backend === backend && this.generation === generation) {
        this.publish({
          ...this.snapshot,
          message: describeReceiverError(error),
        });
      }
    }
  }

  async configureHardware(settings: HackrfRxSettings): Promise<void> {
    const backend = this.backend;
    const session = this.snapshot.session;
    if (
      !backend ||
      !session ||
      !["connected", "running"].includes(this.snapshot.lifecycle)
    )
      return;
    let validated: HackrfRxSettings;
    try {
      if (session.source !== "hackrf" || !backend.configureHardware)
        throw new Error("This source does not support HackRF RX settings.");
      validated = validateHackrfRxSettings(settings);
    } catch (error) {
      this.publish({ ...this.snapshot, message: describeReceiverError(error) });
      return;
    }
    const wasRunning = this.snapshot.lifecycle === "running";
    this.captureCompletedRecording(backend.stopRecording?.("metadata-change"));
    const generation = ++this.generation;
    this.publish({
      ...this.snapshot,
      lifecycle: "tuning",
      sessionGeneration: generation,
      message: "Applying HackRF RX settings…",
    });
    try {
      const metadata = await backend.configureHardware!(validated, generation);
      if (this.backend !== backend || this.generation !== generation) return;
      if (wasRunning) this.publishRunning(metadata, generation);
      else
        this.publishConnected(
          metadata,
          generation,
          "HackRF RX settings accepted.",
        );
    } catch (error) {
      if (this.backend === backend && this.generation === generation)
        await this.failBackend(backend, error);
    }
  }

  private async runStart(
    backend: ReceiverBackend,
    options: ReceiverStartOptions,
    generation: number,
  ): Promise<void> {
    try {
      const metadata = await backend.start(
        { ...options, volume: clampVolume(options.volume) },
        generation,
      );
      if (
        !this.isCurrent(generation, "starting") &&
        !this.isCurrent(generation, "requesting-permission") &&
        !this.isCurrent(generation, "connecting")
      ) {
        await this.cleanupBackend(backend);
        return;
      }
      this.publishRunning(metadata, generation);
    } catch (error) {
      try {
        await this.cleanupBackend(backend);
      } catch {
        /* Keep ownership for Stop to retry. */
      }
      if (generation === this.generation)
        this.publishFailure(generation, error);
    }
  }

  private async handleRuntimeError(
    backend: ReceiverBackend,
    error: unknown,
  ): Promise<void> {
    if (
      this.backend !== backend ||
      (this.snapshot.lifecycle !== "running" &&
        this.snapshot.lifecycle !== "tuning")
    )
      return;
    await this.failBackend(backend, error);
  }

  private async failBackend(
    backend: ReceiverBackend,
    error: unknown,
  ): Promise<void> {
    // Invalidate in-flight reconfiguration and prevent Start until close settles.
    const generation = ++this.generation;
    this.captureCompletedRecording(backend.stopRecording?.("source-stop"));
    this.publish({
      lifecycle: "stopping",
      message: "Closing the receiver after a failed command…",
      sessionGeneration: generation,
    });
    try {
      await this.cleanupBackend(backend);
    } catch {
      /* Stop remains available to retry. */
    }
    if (generation === this.generation) this.publishFailure(generation, error);
  }

  private async handleSourceEnded(backend: ReceiverBackend): Promise<void> {
    if (
      this.backend !== backend ||
      !["starting", "running", "tuning"].includes(this.snapshot.lifecycle)
    )
      return;
    // Keep the completed capture metadata attached while the backend closes. The
    // spectrum view keys its GPU resources to this session generation, so
    // retaining it preserves the final rendered spectrum and waterfall at EOF.
    const completedSnapshot = this.snapshot;
    const generation = ++this.generation;
    this.captureCompletedRecording(backend.stopRecording?.("source-stop"));
    this.publish({
      ...completedSnapshot,
      lifecycle: "stopping",
      message: "Closing the completed replay…",
      sessionGeneration: generation,
    });
    try {
      await this.cleanupBackend(backend);
    } catch (error) {
      if (generation === this.generation)
        this.publishFailure(generation, error);
      return;
    }
    if (generation === this.generation) {
      this.publish({
        ...completedSnapshot,
        lifecycle: "idle",
        message: "Replay reached end of file. Final spectrum retained.",
        sessionGeneration: generation,
      });
    }
  }

  private captureCompletedRecording(recording: IqRecording | undefined): void {
    if (recording && !this.completedRecording)
      this.completedRecording = recording;
  }

  private publishRunning(
    metadata: Omit<SourceSessionMetadata, "sessionGeneration">,
    generation: number,
  ): void {
    this.publish({
      lifecycle: "running",
      message:
        metadata.mode === "OFF"
          ? `Spectrum-only acquisition at ${(metadata.selectedChannelFrequencyHz / 1_000_000).toFixed(3)} MHz — no demodulator or decoder output`
          : metadata.source === "synthetic"
            ? `Synthetic RF demo running in ${metadata.mode} — no hardware or audio`
            : metadata.source === "replay"
              ? `Replaying ${metadata.mode} capture at ${(metadata.selectedChannelFrequencyHz / 1_000_000).toFixed(3)} MHz`
              : `Receiving ${metadata.mode} at ${(metadata.selectedChannelFrequencyHz / 1_000_000).toFixed(3)} MHz`,
      sessionGeneration: generation,
      session: { ...metadata, sessionGeneration: generation },
      audioState: this.snapshot.audioState,
      rds:
        metadata.mode === "WBFM"
          ? ((this.snapshot.sessionGeneration === generation
              ? this.snapshot.rds
              : undefined) ?? {
              pi: null,
              programmeService: null,
              radioText: null,
              validGroups: 0,
            })
          : undefined,
      dab: metadata.mode === "DAB" ? this.snapshot.dab : undefined,
      adsb: metadata.mode === "ADS-B" ? this.snapshot.adsb : undefined,
      ais: metadata.mode === "AIS" ? this.snapshot.ais : undefined,
      srd: metadata.mode === "SRD" ? this.snapshot.srd : undefined,
      srdWorker: metadata.mode === "SRD" ? this.snapshot.srdWorker : undefined,
    });
  }

  private publishConnected(
    metadata:
      Omit<SourceSessionMetadata, "sessionGeneration"> | SourceSessionMetadata,
    generation: number,
    message: string,
  ): void {
    this.publish({
      lifecycle: "connected",
      message,
      sessionGeneration: generation,
      session: { ...metadata, sessionGeneration: generation },
      audioState: "suspended",
    });
  }

  private createAndAttachBackend(
    options: ReceiverStartOptions,
    generation: number,
  ): ReceiverBackend {
    // Callbacks may run during construction, so this binding must exist before createBackend executes.
    let backend: ReceiverBackend | undefined = undefined;
    backend = this.createBackend(
      {
        permissionGranted: () => {
          if (this.isCurrent(generation, "requesting-permission"))
            this.publish({
              ...this.snapshot,
              lifecycle: "connecting",
              message: `Opening and configuring the ${sourceCapabilities(options.source ?? "rtl-sdr").label}…`,
            });
        },
        statusChanged: (message) => {
          if (
            this.backend === backend &&
            ["requesting-permission", "connecting"].includes(
              this.snapshot.lifecycle,
            )
          ) {
            this.publish({
              ...this.snapshot,
              lifecycle: "connecting",
              message,
            });
          }
        },
        runtimeError: (error) => {
          if (backend) void this.handleRuntimeError(backend, error);
        },
        audioStateChanged: (audioState) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, audioState });
        },
        sourceEnded: () => {
          if (backend) void this.handleSourceEnded(backend);
        },
        rdsChanged: (rds) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, rds });
        },
        dabChanged: (dab) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, dab });
        },
        adsbChanged: (adsb) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, adsb });
        },
        aisChanged: (ais) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, ais });
        },
        srdChanged: (srd, srdWorker) => {
          if (
            this.backend !== backend ||
            this.snapshot.session?.mode !== "SRD" ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publish({ ...this.snapshot, srd, srdWorker });
        },
        squelchChanged: (squelchMeter) => {
          if (
            this.backend !== backend ||
            ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)
          )
            return;
          this.publishSquelchMeter(squelchMeter);
        },
      },
      options,
      generation,
    );
    this.backend = backend;
    this.lastIngress = undefined;
    return backend;
  }

  private cleanupBackend(backend?: ReceiverBackend): Promise<void> {
    if (!backend) return Promise.resolve();
    const existing = this.cleanupTasks.get(backend);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() => {
        if (this.backend === backend)
          this.lastIngress = backend.getIngressDiagnostics?.();
        return backend.disconnect?.() ?? backend.stop();
      })
      .then(() => {
        if (this.backend === backend) this.backend = undefined;
      })
      .finally(() => {
        this.cleanupTasks.delete(backend);
      });
    this.cleanupTasks.set(backend, task);
    return task;
  }

  private publishFailure(generation: number, error: unknown): void {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const expected =
      name.includes("NoDeviceSelected") || name === "NotFoundError";
    const setup =
      name.includes("NoUsbSupport") ||
      name.includes("UnsupportedDevice") ||
      /unsupported tuner|profile|firmware|busy|another application|access denied/i.test(
        message,
      );
    if (!expected)
      defaultDiagnosticRecorder.record({
        area: /usb|device|transfer|firmware|tuner/i.test(`${name} ${message}`)
          ? "usb"
          : "receiver",
        code: setup ? "RECEIVER_SETUP_FAILURE" : "RECEIVER_TERMINAL_FAILURE",
        severity: setup ? "warning" : "error",
        operation: this.snapshot.lifecycle,
        error,
        autoSubmitEligible: !setup,
        context: { generation },
      });
    this.publish({
      lifecycle: "error",
      message: describeReceiverError(error),
      sessionGeneration: generation,
      audioState: this.snapshot.audioState,
      cleanupRequired: Boolean(this.backend),
    });
  }

  private isCurrent(generation: number, lifecycle: ReceiverLifecycle): boolean {
    return (
      generation === this.generation && this.snapshot.lifecycle === lifecycle
    );
  }

  private publish(snapshot: ReceiverSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (
      this.squelchMeter &&
      (snapshot.sessionGeneration !== previous.sessionGeneration ||
        snapshot.lifecycle !== "running" ||
        !snapshot.session ||
        !["NBFM", "AM", "USB", "LSB"].includes(snapshot.session.mode))
    )
      this.publishSquelchMeter(undefined);
    for (const listener of this.listeners) listener(snapshot);
  }

  private publishSquelchMeter(state: SquelchMeterState | undefined): void {
    if (
      this.squelchMeter?.level === state?.level &&
      this.squelchMeter?.peak === state?.peak &&
      this.squelchMeter?.open === state?.open
    )
      return;
    this.squelchMeter = state;
    for (const listener of this.squelchMeterListeners) listener();
  }
}

export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
}

export function validateOptions(options: ReceiverStartOptions): void {
  validateSourceConfiguration(options);
}

export function describeReceiverError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("HackRF USB access denied")) return message;
  if (
    message.includes("HackRF") &&
    /profile|USB API|revision|standard image|firmware/i.test(message)
  )
    return `${message} Check the detected firmware against the supported Pro profile before reconnecting.`;
  if (name.includes("NoDeviceSelected") || name === "NotFoundError") {
    return "Device selection was cancelled. Nothing was connected.";
  }
  if (name.includes("NoUsbSupport")) {
    return "WebUSB is unavailable. Use localhost or HTTPS in a compatible desktop browser.";
  }
  if (
    name.includes("UnsupportedDevice") ||
    message.toLowerCase().includes("unsupported tuner")
  ) {
    return "The selected dongle uses an unsupported tuner. Use an RTL2832U with an R820/R828/R860 tuner.";
  }
  if (
    name.includes("UsbTransferError") ||
    name === "NetworkError" ||
    name === "InvalidStateError" ||
    message.toLowerCase().includes("another application") ||
    message.toLowerCase().includes("busy") ||
    message.toLowerCase().includes("claiminterface") ||
    message.toLowerCase().includes("access denied")
  ) {
    return "The dongle is busy or its USB driver is unavailable. Close other SDR apps and check the setup guide.";
  }
  if (
    message.toLowerCase().includes("unplug") ||
    message.toLowerCase().includes("transfer")
  ) {
    return "The sample transfer stopped. Reconnect the dongle, then start again.";
  }
  if (name === "NotAllowedError" || message.toLowerCase().includes("audio")) {
    return "Audio could not start. Click Start receiving again and allow this page to play audio.";
  }
  return `Receiver failed: ${message || "Unknown error"}`;
}
