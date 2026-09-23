import type { AdsbSnapshot, AisSnapshot, DabSnapshot, RdsSnapshot, ReceiverLifecycle, SourceKind, SourceSessionMetadata } from "./types";
import {
  defaultModeSettings,
  normalizeGain,
  normalizeModeSettings,
  type ReceiverModeSettings,
} from "./receiverConfig";
import type { IqRecording, RecordingStatus } from "./iqRecording";
import type { SurveyCaptureContext } from "./fieldSurvey";
import { validateDabSampleRate } from "../dab/dabReceiver";
import { validateAdsbSampleRate } from "../adsb/adsbReceiver";

export const FM_MIN_HZ = 87_500_000;
export const FM_MAX_HZ = 108_000_000;
export const RTL_SAMPLE_RATE_HZ = 1_024_000;
export const RTL_SAMPLE_RATE_OPTIONS_HZ = [1_024_000, 2_400_000] as const;

export interface ReceiverStartOptions {
  source?: SourceKind;
  channelFrequencyHz: number;
  volume: number;
  modeSettings?: ReceiverModeSettings;
  gainDb?: number | null;
  sampleRateHz?: number;
}

export interface ReceiverBackendEvents {
  permissionGranted(): void;
  runtimeError(error: unknown): void;
  audioStateChanged(state: AudioContextState): void;
  sourceEnded(): void;
  rdsChanged(state: RdsSnapshot): void;
  dabChanged?(state: DabSnapshot): void;
  adsbChanged?(state: AdsbSnapshot): void;
  aisChanged?(state: AisSnapshot): void;
}

export interface ReceiverBackend {
  /** Optional persistent hardware connection used by RTL-SDR. */
  connect?(options: ReceiverStartOptions): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  start(options: ReceiverStartOptions, sessionGeneration?: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  stop(): Promise<void>;
  /** Final teardown for a persistent backend. */
  disconnect?(): Promise<void>;
  setVolume(volume: number): void;
  tune(channelFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  /** Explicit acquisition-center retune used by bounded spectrum scans. */
  scanTune?(centerFrequencyHz: number, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  configureMode(settings: ReceiverModeSettings, sessionGeneration: number): Promise<Omit<SourceSessionMetadata, "sessionGeneration">>;
  setGain(gainDb: number | null): Promise<number | null>;
  startRecording?(survey?: SurveyCaptureContext): RecordingStatus;
  stopRecording?(reason?: "user" | "source-stop" | "metadata-change"): IqRecording | undefined;
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
  /** A failed close retains ownership; only Stop/retry is safe until it closes. */
  cleanupRequired?: boolean;
}

type Listener = (snapshot: ReceiverSnapshot) => void;

const INITIAL_SNAPSHOT: ReceiverSnapshot = {
  lifecycle: "idle",
  message: "Receiver not started",
  sessionGeneration: 0,
};

export class ReceiverController {
  private snapshot: ReceiverSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<Listener>();
  private backend?: ReceiverBackend;
  private startTask?: Promise<void>;
  private generation = 0;
  private completedRecording?: IqRecording;
  private readonly cleanupTasks = new Map<ReceiverBackend, Promise<void>>();

  constructor(private readonly createBackend: ReceiverBackendFactory) {}

  getSnapshot = (): ReceiverSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(options: ReceiverStartOptions): Promise<void> {
    const restartingConnectedBackend = this.snapshot.lifecycle === "connected" && Boolean(this.backend?.connect);
    if (!restartingConnectedBackend && this.snapshot.lifecycle !== "idle" && this.snapshot.lifecycle !== "error") {
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
      lifecycle: source === "rtl-sdr" ? "requesting-permission" : "starting",
      message: source === "synthetic" ? "Starting the synthetic RF spectrum demo…" : source === "replay" ? "Starting paced I/Q replay and audio…" : "Choose an RTL-SDR device in the browser prompt…",
      sessionGeneration: generation,
      session: this.snapshot.session,
      audioState: this.snapshot.audioState,
    });

    let backend = this.backend;
    if (!backend) {
      try { backend = this.createAndAttachBackend(options, generation); }
      catch (error) { this.publishFailure(generation, error); return Promise.resolve(); }
    } else {
      this.publish({ ...this.snapshot, lifecycle: "starting", message: `Starting ${options.modeSettings?.mode ?? "WBFM"} reception…`, sessionGeneration: generation });
    }
    const task = this.runStart(backend, options, generation);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    return task;
  }

  async connect(options: ReceiverStartOptions): Promise<void> {
    if (this.snapshot.lifecycle !== "idle" && this.snapshot.lifecycle !== "error") return;
    if (this.backend) return;
    const generation = ++this.generation;
    try { validateOptions(options); }
    catch (error) { this.publishFailure(generation, error); return; }
    let backend: ReceiverBackend;
    try { backend = this.createAndAttachBackend(options, generation); }
    catch (error) { this.publishFailure(generation, error); return; }
    if (!backend.connect) {
      await this.runStart(backend, options, generation);
      return;
    }
    this.publish({ lifecycle: "requesting-permission", message: "Choose an RTL-SDR device in the browser prompt…", sessionGeneration: generation });
    try {
      const metadata = await backend.connect(options);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishConnected(metadata, generation, "RTL-SDR connected. Start reception when ready.");
    } catch (error) {
      try { await this.cleanupBackend(backend); } catch { /* Retain ownership for cleanup retry. */ }
      if (generation === this.generation) this.publishFailure(generation, error);
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
    const preserveConnection = persistent && ["running", "tuning"].includes(this.snapshot.lifecycle);
    this.publish({
      lifecycle: "stopping",
      message: preserveConnection ? "Stopping sample transfers; keeping the device connected…" : "Stopping sample transfers and closing the source…",
      sessionGeneration: generation,
      session: this.snapshot.session,
      audioState: this.snapshot.audioState,
    });

    try {
      if (preserveConnection && backend) await backend.stop();
      else await this.cleanupBackend(backend);
      if (generation === this.generation) {
        if (preserveConnection && this.snapshot.session) this.publishConnected(this.snapshot.session, generation, "Reception stopped. RTL-SDR remains connected.");
        else this.publish({ lifecycle: "idle", message: "Receiver stopped.", sessionGeneration: generation });
      }
    } catch (error) {
      this.publishFailure(generation, error);
    }
  }

  async disconnect(): Promise<void> {
    const backend = this.backend;
    if (!backend) {
      if (this.snapshot.lifecycle !== "idle") this.publish({ lifecycle: "idle", message: "Receiver disconnected.", sessionGeneration: ++this.generation });
      return;
    }
    const generation = ++this.generation;
    this.captureCompletedRecording(backend.stopRecording?.("source-stop"));
    this.publish({ ...this.snapshot, lifecycle: "disconnecting", message: "Releasing the signal source…", sessionGeneration: generation });
    try {
      await this.cleanupBackend(backend);
      if (generation === this.generation) this.publish({ lifecycle: "idle", message: "Receiver disconnected.", sessionGeneration: generation });
    } catch (error) {
      if (generation === this.generation) this.publishFailure(generation, error);
    }
  }

  setVolume(volume: number): void {
    const safeVolume = clampVolume(volume);
    this.backend?.setVolume(safeVolume);
  }

  startRecording(survey?: SurveyCaptureContext): RecordingStatus | undefined {
    if (this.snapshot.lifecycle !== "running" || !this.backend) return undefined;
    return this.backend.startRecording?.(survey);
  }

  stopRecording(): IqRecording | undefined {
    const recording = this.backend?.stopRecording?.("user");
    this.captureCompletedRecording(recording);
    return recording;
  }

  getRecordingStatus(): RecordingStatus | undefined { return this.backend?.getRecordingStatus?.(); }

  finalizeCapacityRecording(): IqRecording | undefined {
    if (this.backend?.getRecordingStatus?.()?.state !== "capacity-reached") return undefined;
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
    if (this.snapshot.lifecycle !== "running" || !this.snapshot.session || !this.backend) return;
    try {
      validateOptions({ channelFrequencyHz, volume: 0 });
    } catch (error) {
      this.publish({
        ...this.snapshot,
        message: error instanceof Error ? error.message : "Enter a valid channel frequency.",
      });
      return;
    }
    this.captureCompletedRecording(this.backend.stopRecording?.("metadata-change"));
    const generation = ++this.generation;
    const backend = this.backend;
    this.publish({
      lifecycle: "tuning",
      message: `Retuning to ${(channelFrequencyHz / 1_000_000).toFixed(3)} MHz…`,
      sessionGeneration: generation,
      session: { ...this.snapshot.session, sessionGeneration: generation, selectedChannelFrequencyHz: channelFrequencyHz },
      audioState: this.snapshot.audioState,
    });
    try {
      const metadata = await backend.tune(channelFrequencyHz, generation);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishRunning(metadata, generation);
    } catch (error) {
      if (generation === this.generation && this.backend === backend) await this.failBackend(backend, error);
    }
  }

  async scanTune(centerFrequencyHz: number): Promise<SourceSessionMetadata | undefined> {
    const backend = this.backend;
    const scanTune = backend?.scanTune;
    if (this.snapshot.lifecycle !== "running" || !this.snapshot.session || !backend || !scanTune) return undefined;
    try { validateOptions({ channelFrequencyHz: centerFrequencyHz, volume: 0 }); }
    catch (error) {
      this.publish({ ...this.snapshot, message: error instanceof Error ? error.message : "Enter a valid scan frequency." });
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
      const metadata = await scanTune.call(backend, centerFrequencyHz, generation);
      if (generation !== this.generation || this.backend !== backend) return undefined;
      this.publishRunning(metadata, generation);
      return { ...metadata, sessionGeneration: generation };
    } catch (error) {
      if (generation === this.generation && this.backend === backend) await this.failBackend(backend, error);
      return undefined;
    }
  }

  async configureMode(settings: ReceiverModeSettings): Promise<void> {
    if (this.snapshot.lifecycle !== "running" || !this.snapshot.session || !this.backend) return;
    let normalized: ReceiverModeSettings;
    try {
      normalized = normalizeModeSettings(settings);
    } catch (error) {
      this.publish({ ...this.snapshot, message: error instanceof Error ? error.message : "Invalid receiver mode settings." });
      return;
    }
    this.captureCompletedRecording(this.backend.stopRecording?.("metadata-change"));
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
      },
    });
    try {
      const metadata = await backend.configureMode(normalized, generation);
      if (generation !== this.generation || this.backend !== backend) return;
      this.publishRunning(metadata, generation);
    } catch (error) {
      if (generation === this.generation && this.backend === backend) await this.failBackend(backend, error);
    }
  }

  async setGain(gainDb: number | null): Promise<void> {
    if (!["connected", "running"].includes(this.snapshot.lifecycle) || !this.snapshot.session || !this.backend) return;
    const backend = this.backend;
    this.captureCompletedRecording(backend.stopRecording?.("metadata-change"));
    const generation = this.generation;
    try {
      const actual = await backend.setGain(normalizeGain(gainDb));
      if (this.backend !== backend || this.generation !== generation || !this.snapshot.session) return;
      this.publish({
        ...this.snapshot,
        message: actual === null ? "Automatic RF gain enabled." : `Manual RF gain set to ${actual.toFixed(1)} dB.`,
        session: { ...this.snapshot.session, gainDb: actual },
      });
    } catch (error) {
      if (this.backend === backend && this.generation === generation) {
        this.publish({ ...this.snapshot, message: describeReceiverError(error) });
      }
    }
  }

  private async runStart(
    backend: ReceiverBackend,
    options: ReceiverStartOptions,
    generation: number,
  ): Promise<void> {
    try {
      const metadata = await backend.start({ ...options, volume: clampVolume(options.volume) }, generation);
      if (!this.isCurrent(generation, "starting") && !this.isCurrent(generation, "requesting-permission") && !this.isCurrent(generation, "connecting")) {
        await backend.stop();
        return;
      }
      this.publishRunning(metadata, generation);
    } catch (error) {
      try { await this.cleanupBackend(backend); } catch { /* Keep ownership for Stop to retry. */ }
      if (generation === this.generation) this.publishFailure(generation, error);
    }
  }

  private async handleRuntimeError(backend: ReceiverBackend, error: unknown): Promise<void> {
    if (this.backend !== backend || (this.snapshot.lifecycle !== "running" && this.snapshot.lifecycle !== "tuning")) return;
    await this.failBackend(backend, error);
  }

  private async failBackend(backend: ReceiverBackend, error: unknown): Promise<void> {
    // Invalidate in-flight reconfiguration and prevent Start until close settles.
    const generation = ++this.generation;
    this.captureCompletedRecording(backend.stopRecording?.("source-stop"));
    this.publish({ lifecycle: "stopping", message: "Closing the receiver after a failed command…", sessionGeneration: generation });
    try { await this.cleanupBackend(backend); } catch { /* Stop remains available to retry. */ }
    if (generation === this.generation) this.publishFailure(generation, error);
  }

  private async handleSourceEnded(backend: ReceiverBackend): Promise<void> {
    if (this.backend !== backend || !["starting", "running", "tuning"].includes(this.snapshot.lifecycle)) return;
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
      if (generation === this.generation) this.publishFailure(generation, error);
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
    if (recording) this.completedRecording = recording;
  }

  private publishRunning(metadata: Omit<SourceSessionMetadata, "sessionGeneration">, generation: number): void {
    this.publish({
      lifecycle: "running",
      message: metadata.source === "synthetic"
        ? `Synthetic RF demo running in ${metadata.mode} — no hardware or audio`
        : metadata.source === "replay"
          ? `Replaying ${metadata.mode} capture at ${(metadata.selectedChannelFrequencyHz / 1_000_000).toFixed(3)} MHz`
          : `Receiving ${metadata.mode} at ${(metadata.selectedChannelFrequencyHz / 1_000_000).toFixed(3)} MHz`,
      sessionGeneration: generation,
      session: { ...metadata, sessionGeneration: generation },
      audioState: this.snapshot.audioState,
      rds: metadata.mode === "WBFM"
        ? (this.snapshot.sessionGeneration === generation ? this.snapshot.rds : undefined) ?? { pi: null, programmeService: null, radioText: null, validGroups: 0 }
        : undefined,
      dab: metadata.mode === "DAB" ? this.snapshot.dab : undefined,
      adsb: metadata.mode === "ADS-B" ? this.snapshot.adsb : undefined,
      ais: metadata.mode === "AIS" ? this.snapshot.ais : undefined,
    });
  }

  private publishConnected(metadata: Omit<SourceSessionMetadata, "sessionGeneration"> | SourceSessionMetadata, generation: number, message: string): void {
    this.publish({
      lifecycle: "connected",
      message,
      sessionGeneration: generation,
      session: { ...metadata, sessionGeneration: generation },
      audioState: "suspended",
    });
  }

  private createAndAttachBackend(options: ReceiverStartOptions, generation: number): ReceiverBackend {
    let backend!: ReceiverBackend;
    backend = this.createBackend({
      permissionGranted: () => {
        if (this.isCurrent(generation, "requesting-permission")) this.publish({ ...this.snapshot, lifecycle: "connecting", message: "Opening and configuring the RTL-SDR…" });
      },
      runtimeError: (error) => void this.handleRuntimeError(backend, error),
      audioStateChanged: (audioState) => {
        if (this.backend !== backend || ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)) return;
        this.publish({ ...this.snapshot, audioState });
      },
      sourceEnded: () => void this.handleSourceEnded(backend),
      rdsChanged: (rds) => {
        if (this.backend !== backend || ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)) return;
        this.publish({ ...this.snapshot, rds });
      },
      dabChanged: (dab) => {
        if (this.backend !== backend || ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)) return;
        this.publish({ ...this.snapshot, dab });
      },
      adsbChanged: (adsb) => {
        if (this.backend !== backend || ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)) return;
        this.publish({ ...this.snapshot, adsb });
      },
      aisChanged: (ais) => {
        if (this.backend !== backend || ["stopping", "disconnecting"].includes(this.snapshot.lifecycle)) return;
        this.publish({ ...this.snapshot, ais });
      },
    }, options, generation);
    this.backend = backend;
    return backend;
  }

  private cleanupBackend(backend?: ReceiverBackend): Promise<void> {
    if (!backend) return Promise.resolve();
    const existing = this.cleanupTasks.get(backend);
    if (existing) return existing;
    const task = Promise.resolve().then(() => backend.disconnect?.() ?? backend.stop()).then(() => {
      if (this.backend === backend) this.backend = undefined;
    }).finally(() => { this.cleanupTasks.delete(backend); });
    this.cleanupTasks.set(backend, task);
    return task;
  }

  private publishFailure(generation: number, error: unknown): void {
    this.publish({
      lifecycle: "error",
      message: describeReceiverError(error),
      sessionGeneration: generation,
      audioState: this.snapshot.audioState,
      cleanupRequired: Boolean(this.backend),
    });
  }

  private isCurrent(generation: number, lifecycle: ReceiverLifecycle): boolean {
    return generation === this.generation && this.snapshot.lifecycle === lifecycle;
  }

  private publish(snapshot: ReceiverSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
}

export function validateOptions(options: ReceiverStartOptions): void {
  if (!Number.isFinite(options.channelFrequencyHz)) {
    throw new Error("Enter a valid channel frequency.");
  }
  if (options.channelFrequencyHz <= 0) {
    throw new Error("Choose a channel frequency above 0 Hz; the connected tuner's limits are detected when tuning.");
  }
  if (!Number.isSafeInteger(Math.round(options.channelFrequencyHz))) {
    throw new Error("Choose a channel frequency that can be represented safely in integer Hz.");
  }
  const mode = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
  normalizeGain(options.gainDb ?? null);
  if (options.sampleRateHz !== undefined && !RTL_SAMPLE_RATE_OPTIONS_HZ.includes(options.sampleRateHz as typeof RTL_SAMPLE_RATE_OPTIONS_HZ[number])) {
    throw new Error(`Choose a supported RTL-SDR sample rate (${RTL_SAMPLE_RATE_OPTIONS_HZ.join(" or ")} samples/s).`);
  }
  if ((options.source ?? "rtl-sdr") === "rtl-sdr" && mode.mode === "DAB") validateDabSampleRate(options.sampleRateHz ?? RTL_SAMPLE_RATE_HZ);
  if ((options.source ?? "rtl-sdr") === "rtl-sdr" && mode.mode === "ADS-B") validateAdsbSampleRate(options.sampleRateHz ?? RTL_SAMPLE_RATE_HZ);
  if (options.source === "synthetic" && ["DAB", "ADS-B", "AIS"].includes(mode.mode)) throw new Error(`${mode.mode} is available with RTL-SDR or replay, not the spectrum demo.`);
}

export function describeReceiverError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name.includes("NoDeviceSelected") || name === "NotFoundError") {
    return "Device selection was cancelled. Nothing was connected.";
  }
  if (name.includes("NoUsbSupport")) {
    return "WebUSB is unavailable. Use localhost or HTTPS in a compatible desktop browser.";
  }
  if (name.includes("UnsupportedDevice") || message.toLowerCase().includes("unsupported tuner")) {
    return "The selected dongle uses an unsupported tuner. Use an RTL2832U with an R820/R828/R860 tuner.";
  }
  if (
    name.includes("UsbTransferError") || name === "NetworkError" || name === "InvalidStateError"
    || message.toLowerCase().includes("another application") || message.toLowerCase().includes("busy")
    || message.toLowerCase().includes("claiminterface") || message.toLowerCase().includes("access denied")
  ) {
    return "The dongle is busy or its USB driver is unavailable. Close other SDR apps and check the setup guide.";
  }
  if (message.toLowerCase().includes("unplug") || message.toLowerCase().includes("transfer")) {
    return "The sample transfer stopped. Reconnect the dongle, then start again.";
  }
  if (name === "NotAllowedError" || message.toLowerCase().includes("audio")) {
    return "Audio could not start. Click Start receiving again and allow this page to play audio.";
  }
  return `Receiver failed: ${message || "Unknown error"}`;
}
