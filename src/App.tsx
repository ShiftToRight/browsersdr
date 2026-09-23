import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnalysisPipeline, type AnalysisDiagnostics } from "./dsp/analysisPipeline";
import { WebGpuSpectrum } from "./graphics/WebGpuSpectrum";
import { SpectrumExplorer } from "./ui/SpectrumExplorer";
import {
  ReceiverController,
  RTL_SAMPLE_RATE_OPTIONS_HZ,
  type ReceiverSnapshot,
} from "./radio/receiverController";
import { createRtlSdrBackend } from "./radio/rtlSdrBackend";
import { SyntheticBackend } from "./radio/syntheticBackend";
import { ReplayBackend } from "./radio/replayBackend";
import type { SourceKind } from "./radio/types";
import {
  parseRecording,
  recordingCapacitySeconds,
  RECORDING_MAX_BYTES,
  RECORDING_METADATA_MAX_BYTES,
  type IqRecording,
  type RecordingStatus,
} from "./radio/iqRecording";
import {
  formatControlDisabled,
  RecordingExportCoordinator,
  RecordingFormatLatch,
  type ExportAttemptResult,
  type RecordingExportFormat,
} from "./radio/recordingExport";
import { createDeterministicRecordingFixture } from "./testing/recordingFixture";
import {
  defaultModeSettings,
  MANUAL_GAIN_MAX_DB,
  modeCapabilities,
  normalizeModeSettings,
  RECEIVER_MODES,
  type ReceiverMode,
} from "./radio/receiverConfig";
import type { SurveyCandidateRecord, SurveyProfile } from "./radio/fieldSurvey";
import { DAB_BAND_III_CHANNELS, dabChannelAt } from "./dab/channels";
import { ADSB_FREQUENCY_HZ } from "./adsb/adsbReceiver";
import { AIS_CENTER_FREQUENCY_HZ } from "./ais/aisReceiver";

interface Capability {
  label: string;
  available: boolean;
  detail: string;
}

const FREQUENCY_KEY = "browsersdr.channelFrequencyMhz";
const VOLUME_KEY = "browsersdr.volume";
const MODE_KEY = "browsersdr.mode";
const BANDWIDTH_KEY = "browsersdr.bandwidthHz";
const SQUELCH_KEY = "browsersdr.squelch";
const GAIN_KEY = "browsersdr.gainDb";
const SAMPLE_RATE_KEY = "browsersdr.sampleRateHz";
const DEFAULT_FREQUENCY_MHZ = 100;
const DEFAULT_VOLUME = 0.65;
const MAX_SAFE_FREQUENCY_MHZ = Number.MAX_SAFE_INTEGER / 1_000_000;
type AppView = "receiver" | "explorer" | "diagnostics";

function capabilities(): Capability[] {
  const secure = window.isSecureContext;
  const webUsb = "usb" in navigator;
  const webGpu = "gpu" in navigator;
  return [
    { label: "Secure context", available: secure, detail: secure ? "available" : "Use localhost or HTTPS" },
    { label: "WebUSB API", available: webUsb, detail: webUsb ? "available" : "Use a WebUSB-compatible browser" },
    {
      label: "WebGPU API",
      available: webGpu,
      detail: webGpu ? "API detected; device check below" : "Use a WebGPU-compatible browser",
    },
  ];
}

function loadNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const value = Number(stored);
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in privacy modes; receiver operation is unaffected.
  }
}

function loadMode(): ReceiverMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return RECEIVER_MODES.includes(stored as ReceiverMode) ? stored as ReceiverMode : "WBFM";
  } catch {
    return "WBFM";
  }
}

function saveText(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Optional preferences only. */ }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function PositionPlot({ targets, label }: { targets: { latitude: number | null; longitude: number | null; label: string }[]; label: string }) {
  const positioned = targets.filter((target): target is { latitude: number; longitude: number; label: string } => target.latitude !== null && target.longitude !== null);
  return (
    <div className="target-plot">
      <svg viewBox="0 0 720 280" role="img" aria-label={`${label}: ${positioned.length} positioned targets`}>
        <rect width="720" height="280" />
        {[90, 180, 270, 360, 450, 540, 630].map((x) => <line key={`x${x}`} x1={x} x2={x} y1="0" y2="280" />)}
        {[70, 140, 210].map((y) => <line key={`y${y}`} x1="0" x2="720" y1={y} y2={y} />)}
        {positioned.map((target) => <g key={target.label} transform={`translate(${(target.longitude + 180) * 2} ${(90 - target.latitude) * 280 / 180})`}><circle r="4" /><title>{target.label}</title></g>)}
      </svg>
      <small>License-free equirectangular position plot · transmitted coordinates only</small>
    </div>
  );
}

function downloadDecodedTargets(mode: string, targets: unknown[]): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ mode, exportedAt: new Date().toISOString(), targets }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `browsersdr-${mode.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-targets.json`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DiagnosticsPanel({ pipeline, receiver }: { pipeline: AnalysisPipeline; receiver: ReceiverSnapshot }) {
  const [diagnostics, setDiagnostics] = useState<AnalysisDiagnostics>(() => pipeline.getDiagnostics());
  useEffect(() => {
    const refresh = () => setDiagnostics(pipeline.getDiagnostics());
    refresh();
    const timer = window.setInterval(refresh, 500);
    return () => window.clearInterval(timer);
  }, [pipeline, receiver.sessionGeneration]);
  const processing = diagnostics.processingTimeAverageMs === null
    ? "unavailable"
    : `${diagnostics.processingTimeAverageMs.toFixed(2)} ms avg · ${(diagnostics.processingTimeMaximumMs ?? 0).toFixed(2)} ms max`;
  const audio = diagnostics.source === "synthetic"
    ? "not applicable (demo has no audio)"
    : receiver.audioState ?? "unavailable until audio starts";

  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-heading">
      <div className="panel-heading"><div><p className="eyebrow">Bounded telemetry</p><h2 id="diagnostics-heading">Session diagnostics</h2></div></div>
      <dl className="diagnostics-grid">
        <div><dt>Received bytes</dt><dd>{diagnostics.receivedBytes === null
          ? diagnostics.source === "synthetic" ? "not applicable to generated demo" : "unavailable until a source starts"
          : formatCount(diagnostics.receivedBytes)}</dd></div>
        <div><dt>Complex samples</dt><dd>{formatCount(diagnostics.receivedComplexSamples)}</dd></div>
        <div><dt>Worker processing</dt><dd>{processing}</dd></div>
        <div><dt>Analysis backend</dt><dd>{diagnostics.analysisBackend ?? "initializing when a source starts"}{diagnostics.backendStartupMs === null ? "" : ` · ${diagnostics.backendStartupMs.toFixed(2)} ms startup`}{diagnostics.backendFallbackReason ? ` · ${diagnostics.backendFallbackReason}` : ""}</dd></div>
        <div><dt>Analysis blocks</dt><dd>{formatCount(diagnostics.processedBlocks)}</dd></div>
        <div><dt>Display frames delivered</dt><dd>{formatCount(diagnostics.deliveredDisplayFrames)}</dd></div>
        <div><dt>Display frames skipped</dt><dd>{formatCount(diagnostics.skippedSpectrumFrames)}</dd></div>
        <div><dt>Input blocks skipped</dt><dd>{formatCount(diagnostics.skippedInputBlocks)} · {formatCount(diagnostics.skippedInputSamples)} samples</dd></div>
        <div><dt>Known app discontinuities</dt><dd>{formatCount(diagnostics.knownApplicationDiscontinuities)}</dd></div>
        <div><dt>Audio output state</dt><dd>{audio}</dd></div>
        <div><dt>Audio underruns</dt><dd>unavailable (upstream player exposes no counter)</dd></div>
        <div><dt>Hardware sample loss</dt><dd>unavailable (RTL byte stream has no sequence numbers)</dd></div>
      </dl>
    </section>
  );
}

export default function App() {
  const [analysis] = useState(() => new AnalysisPipeline());
  const replayRef = useRef<IqRecording>(undefined);
  const [controller] = useState(() => new ReceiverController((events, options, generation) =>
    options.source === "synthetic"
      ? new SyntheticBackend(events, analysis, generation)
      : options.source === "replay"
        ? new ReplayBackend(events, analysis, replayRef.current ?? (() => { throw new Error("Load a valid CU8 recording and JSON sidecar before starting replay."); })(), generation)
        : createRtlSdrBackend(events, analysis, generation, options.channelFrequencyHz),
  ));
  const [receiver, setReceiver] = useState<ReceiverSnapshot>(controller.getSnapshot());
  const [source, setSource] = useState<SourceKind>("rtl-sdr");
  const [mode, setMode] = useState<ReceiverMode>(loadMode);
  const defaults = defaultModeSettings(mode);
  const [frequencyMhz, setFrequencyMhz] = useState(() =>
    loadNumber(FREQUENCY_KEY, loadNumber("browsersdr.fmFrequencyMhz", DEFAULT_FREQUENCY_MHZ, 0.000001, MAX_SAFE_FREQUENCY_MHZ), 0.000001, MAX_SAFE_FREQUENCY_MHZ),
  );
  const [volume, setVolume] = useState(() => loadNumber(VOLUME_KEY, DEFAULT_VOLUME, 0, 1));
  const [bandwidthHz, setBandwidthHz] = useState(() => loadNumber(BANDWIDTH_KEY, defaults.bandwidthHz, modeCapabilities(mode).minimumBandwidthHz, modeCapabilities(mode).maximumBandwidthHz));
  const [squelch, setSquelch] = useState(() => loadNumber(SQUELCH_KEY, defaults.squelch, 0, 6));
  const [gainDb, setGainDb] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem(GAIN_KEY);
      if (stored === "auto" || stored === null) return null;
      const value = Number(stored);
      return Number.isFinite(value) && value >= 0 && value <= MANUAL_GAIN_MAX_DB ? value : null;
    } catch { return null; }
  });
  const [sampleRateHz, setSampleRateHz] = useState(() => {
    if (mode === "DAB" || mode === "ADS-B") return 2_400_000;
    const stored = loadNumber(SAMPLE_RATE_KEY, RTL_SAMPLE_RATE_OPTIONS_HZ[0], RTL_SAMPLE_RATE_OPTIONS_HZ[0], RTL_SAMPLE_RATE_OPTIONS_HZ.at(-1)!);
    return RTL_SAMPLE_RATE_OPTIONS_HZ.includes(stored as typeof RTL_SAMPLE_RATE_OPTIONS_HZ[number]) ? stored : RTL_SAMPLE_RATE_OPTIONS_HZ[0];
  });
  const [loadedReplay, setLoadedReplay] = useState<IqRecording>();
  const [replayBinary, setReplayBinary] = useState<File>();
  const [replayMetadata, setReplayMetadata] = useState<File>();
  const [fileMessage, setFileMessage] = useState("Load a .cu8 binary and its .json sidecar, or use the deterministic fixture.");
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>();
  const [recordingFormat, setRecordingFormat] = useState<RecordingExportFormat>("browsersdr");
  const [exportingRecording, setExportingRecording] = useState(false);
  const [exportRetryAvailable, setExportRetryAvailable] = useState(false);
  const [exportCoordinator] = useState(() => new RecordingExportCoordinator());
  const [recordingFormatLatch] = useState(() => new RecordingFormatLatch());
  const capacityStopPending = useRef(false);
  const [activeView, setActiveView] = useState<AppView>("receiver");
  const [scanActive, setScanActive] = useState(false);
  const detectedCapabilities = capabilities();
  const busy = Boolean(receiver.cleanupRequired) || ["requesting-permission", "starting", "running", "tuning", "stopping"].includes(receiver.lifecycle);
  const running = receiver.lifecycle === "running";
  const hardwareConnected = source === "rtl-sdr" && ["connected", "starting", "running", "tuning", "stopping"].includes(receiver.lifecycle);
  const transitioning = scanActive || ["requesting-permission", "connecting", "starting", "tuning", "stopping", "disconnecting"].includes(receiver.lifecycle);
  const frequencyValid = Number.isFinite(frequencyMhz) && frequencyMhz > 0;
  const modeCaps = modeCapabilities(mode);

  const settleExport = useCallback((attempt: Promise<ExportAttemptResult>) => {
    setExportingRecording(true);
    setFileMessage("Preparing recording export…");
    void attempt.then((result) => {
      if (result.status === "success") {
        const format = result.prepared.format === "sigmf" ? "SigMF" : "BrowserSDR replay";
        setFileMessage(`Downloaded ${result.prepared.sampleCount.toLocaleString()} samples as ${format} (${result.prepared.files.map((file) => file.name).join(" and ")}).`);
      } else if (result.status === "failure") {
        setFileMessage(`${result.error.message} The completed recording remains in memory; retry the export.`);
      }
      setExportRetryAvailable(exportCoordinator.hasRetry);
      setExportingRecording(exportCoordinator.isBusy);
    });
  }, [exportCoordinator]);

  const exportCompletedRecording = useCallback((recording: IqRecording) => {
    const format = recordingFormatLatch.complete(recordingFormat);
    capacityStopPending.current = false;
    setRecordingStatus(undefined);
    settleExport(exportCoordinator.export(recording, format));
  }, [exportCoordinator, recordingFormat, recordingFormatLatch, settleExport]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setReceiver);
    return () => {
      unsubscribe();
      void controller.disconnect().finally(() => analysis.dispose());
    };
  }, [analysis, controller]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const status = controller.getRecordingStatus();
      setRecordingStatus(status);
      if (status?.state === "capacity-reached" && !capacityStopPending.current) {
        capacityStopPending.current = true;
        const recording = controller.finalizeCapacityRecording();
        controller.takeCompletedRecording();
        if (recording) exportCompletedRecording(recording);
        return;
      }
      const completed = controller.takeCompletedRecording();
      if (completed) exportCompletedRecording(completed);
    }, 250);
    return () => window.clearInterval(timer);
  }, [controller, exportCompletedRecording]);

  const start = () => {
    const rawSettings = { mode, bandwidthHz, squelch };
    try {
      const settings = normalizeModeSettings(rawSettings);
      if (!frequencyValid) throw new Error("Invalid frequency");
      saveNumber(FREQUENCY_KEY, frequencyMhz);
      saveNumber(VOLUME_KEY, volume);
      saveText(MODE_KEY, mode);
      saveNumber(BANDWIDTH_KEY, settings.bandwidthHz);
      saveNumber(SQUELCH_KEY, settings.squelch);
      saveText(GAIN_KEY, gainDb === null ? "auto" : String(gainDb));
    } catch {
      // The controller publishes the validation error; unsafe values are not persisted.
    }
    saveNumber(SAMPLE_RATE_KEY, sampleRateHz);
    void controller.start({ source, channelFrequencyHz: frequencyMhz * 1_000_000, volume, modeSettings: rawSettings, gainDb, sampleRateHz });
  };

  const startReceptionForScan = useCallback(async (): Promise<ReceiverSnapshot> => {
    if (controller.getSnapshot().lifecycle === "connected") {
      await controller.start({
        source,
        channelFrequencyHz: frequencyMhz * 1_000_000,
        volume,
        modeSettings: { mode, bandwidthHz, squelch },
        gainDb,
        sampleRateHz,
      });
    }
    return controller.getSnapshot();
  }, [bandwidthHz, controller, frequencyMhz, gainDb, mode, sampleRateHz, source, squelch, volume]);

  const connectReceiver = () => {
    const rawSettings = { mode, bandwidthHz, squelch };
    try {
      const settings = normalizeModeSettings(rawSettings);
      if (!frequencyValid) throw new Error("Invalid frequency");
      saveNumber(FREQUENCY_KEY, frequencyMhz);
      saveNumber(VOLUME_KEY, volume);
      saveText(MODE_KEY, settings.mode);
      saveNumber(BANDWIDTH_KEY, settings.bandwidthHz);
      saveNumber(SQUELCH_KEY, settings.squelch);
      saveText(GAIN_KEY, gainDb === null ? "auto" : String(gainDb));
    } catch { /* The controller publishes validation errors. */ }
    saveNumber(SAMPLE_RATE_KEY, sampleRateHz);
    void controller.connect({ source, channelFrequencyHz: frequencyMhz * 1_000_000, volume, modeSettings: rawSettings, gainDb, sampleRateHz });
  };

  const switchSource = async (nextSource: SourceKind) => {
    if (receiver.lifecycle !== "idle" && (receiver.lifecycle !== "error" || receiver.cleanupRequired)) await controller.disconnect();
    if (controller.getSnapshot().cleanupRequired) return;
    const completed = controller.takeCompletedRecording();
    if (completed) exportCompletedRecording(completed);
    setSource(nextSource);
  };

  const updateVolume = (nextVolume: number) => {
    setVolume(nextVolume);
    saveNumber(VOLUME_KEY, nextVolume);
    controller.setVolume(nextVolume);
  };

  const tune = useCallback((frequencyHz: number) => {
    const nextMhz = frequencyHz / 1_000_000;
    setFrequencyMhz(nextMhz);
    saveNumber(FREQUENCY_KEY, nextMhz);
    void controller.tune(frequencyHz).then(() => {
      const completed = controller.takeCompletedRecording();
      if (completed) exportCompletedRecording(completed);
    });
  }, [controller, exportCompletedRecording]);

  const chooseMode = (nextMode: ReceiverMode) => {
    const next = defaultModeSettings(nextMode);
    setMode(nextMode);
    setBandwidthHz(next.bandwidthHz);
    setSquelch(next.squelch);
    if (!hardwareConnected && (nextMode === "DAB" || nextMode === "ADS-B")) setSampleRateHz(2_400_000);
    if (!hardwareConnected && nextMode === "AIS") setSampleRateHz(1_024_000);
    if (!hardwareConnected && nextMode === "ADS-B") setFrequencyMhz(ADSB_FREQUENCY_HZ / 1_000_000);
    if (!hardwareConnected && nextMode === "AIS") setFrequencyMhz(AIS_CENTER_FREQUENCY_HZ / 1_000_000);
  };

  const applyMode = () => {
    const rawSettings = { mode, bandwidthHz, squelch };
    try {
      const settings = normalizeModeSettings(rawSettings);
      saveText(MODE_KEY, settings.mode);
      saveNumber(BANDWIDTH_KEY, settings.bandwidthHz);
      saveNumber(SQUELCH_KEY, settings.squelch);
      setBandwidthHz(settings.bandwidthHz);
      setSquelch(settings.squelch);
      void controller.configureMode(settings).then(() => {
        const completed = controller.takeCompletedRecording();
        if (completed) exportCompletedRecording(completed);
      });
    } catch {
      void controller.configureMode(rawSettings);
    }
  };

  const applyGain = (nextGain: number | null) => {
    setGainDb(nextGain);
    saveText(GAIN_KEY, nextGain === null ? "auto" : String(nextGain));
    void controller.setGain(nextGain).then(() => {
      const completed = controller.takeCompletedRecording();
      if (completed) exportCompletedRecording(completed);
    });
  };

  const stopReceiver = async () => {
    await controller.stop();
    const completed = controller.takeCompletedRecording();
    if (completed) exportCompletedRecording(completed);
    setRecordingStatus(undefined);
  };

  const disconnectReceiver = async () => {
    await controller.disconnect();
    const completed = controller.takeCompletedRecording();
    if (completed) exportCompletedRecording(completed);
    setRecordingStatus(undefined);
  };

  const startRecording = () => {
    const status = controller.startRecording();
    setRecordingStatus(status);
    if (status) {
      recordingFormatLatch.begin(recordingFormat);
      setFileMessage(recordingFormat === "sigmf"
        ? "Recording CU8 I/Q in bounded memory. Stop to export paired SigMF data and metadata files."
        : "Recording CU8 I/Q in bounded memory. Stop to download the BrowserSDR binary and JSON sidecar.");
    }
  };

  const stopRecording = () => {
    const recording = controller.stopRecording();
    setRecordingStatus(undefined);
    if (recording) {
      controller.takeCompletedRecording();
      exportCompletedRecording(recording);
    }
  };

  const retryRecordingExport = () => settleExport(exportCoordinator.retry());

  const captureSurveyCandidates = useCallback(async (
    candidates: SurveyCandidateRecord[],
    profile: SurveyProfile,
    sessionId: string,
  ): Promise<number[]> => {
    const snapshot = controller.getSnapshot();
    if (snapshot.lifecycle !== "running" || !snapshot.session) throw new Error("Keep RTL-SDR reception running while capturing survey candidates.");
    const captured: number[] = [];
    setExportingRecording(true);
    try {
      for (const candidate of candidates) {
        const band = profile.bands.find((entry) => entry.id === candidate.bandId);
        await controller.tune(candidate.frequencyHz);
        const tuned = controller.getSnapshot();
        if (tuned.lifecycle !== "running" || !tuned.session) throw new Error(`Could not tune ${candidate.frequencyHz} Hz for capture.`);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        const maximumSeconds = Math.max(1, recordingCapacitySeconds(tuned.session.actualSampleRateHz) - 0.5);
        const requestedSeconds = band?.captureSeconds ?? 10;
        const captureSeconds = Math.min(requestedSeconds, maximumSeconds);
        const status = controller.startRecording({
          sessionId,
          profileName: profile.name,
          site: profile.site,
          bandName: candidate.bandName,
          detector: candidate.detector,
          signal: candidate.annotation,
        });
        if (!status) throw new Error(`Could not start the ${candidate.frequencyHz} Hz recording.`);
        setRecordingStatus(status);
        setFileMessage(`Survey capture ${captured.length + 1}/${candidates.length}: ${candidate.frequencyHz.toLocaleString()} Hz for ${captureSeconds.toFixed(1)} s…`);
        await new Promise((resolve) => window.setTimeout(resolve, captureSeconds * 1_000));
        const recording = controller.stopRecording();
        controller.takeCompletedRecording();
        setRecordingStatus(undefined);
        if (!recording) throw new Error(`The ${candidate.frequencyHz} Hz recording did not complete.`);
        const result = await exportCoordinator.export(recording, "sigmf");
        if (result.status === "failure") throw result.error;
        if (result.status === "busy") throw new Error("A previous recording export is still being prepared.");
        captured.push(candidate.frequencyHz);
        setFileMessage(`Downloaded survey SigMF ${result.prepared.basename} (${captured.length}/${candidates.length}).`);
      }
      return captured;
    } finally {
      if (controller.getRecordingStatus()) {
        controller.stopRecording();
        controller.takeCompletedRecording();
      }
      setRecordingStatus(undefined);
      setExportRetryAvailable(exportCoordinator.hasRetry);
      setExportingRecording(false);
    }
  }, [controller, exportCoordinator]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextView: AppView | undefined;
    const views: AppView[] = ["receiver", "explorer", "diagnostics"];
    const currentIndex = views.indexOf(activeView);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      nextView = views[(currentIndex + direction + views.length) % views.length];
    } else if (event.key === "Home") {
      nextView = "receiver";
    } else if (event.key === "End") {
      nextView = "diagnostics";
    }
    if (!nextView) return;
    event.preventDefault();
    setActiveView(nextView);
    window.requestAnimationFrame(() => document.getElementById(`${nextView}-tab`)?.focus());
  };

  const useReplay = (recording: IqRecording, message: string) => {
    replayRef.current = recording;
    setLoadedReplay(recording);
    setFrequencyMhz(recording.metadata.selectedChannelFrequencyHz / 1_000_000);
    setMode(recording.metadata.mode);
    setBandwidthHz(recording.metadata.channelBandwidthHz);
    setSquelch(recording.metadata.squelch);
    setSource("replay");
    setFileMessage(message);
  };

  const loadReplayFiles = async () => {
    if (!replayBinary || !replayMetadata) return;
    try {
      if (replayBinary.size > RECORDING_MAX_BYTES) throw new Error("Replay file exceeds the 32 MiB limit.");
      if (replayMetadata.size > RECORDING_METADATA_MAX_BYTES) throw new Error("Recording metadata exceeds the 1 MiB limit.");
      const recording = parseRecording(await replayMetadata.text(), await replayBinary.arrayBuffer());
      useReplay(recording, `Loaded ${recording.metadata.sampleCount.toLocaleString()} samples (${recording.metadata.durationSeconds.toFixed(3)} s).`);
    } catch (error) {
      setLoadedReplay(undefined);
      replayRef.current = undefined;
      setFileMessage(error instanceof Error ? error.message : "Could not load recording.");
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="brand-mark">◈ BrowserSDR</p>
          <h1>Listen closer.</h1>
          <p className="subtitle">A local software-defined radio workspace, built for the browser.</p>
        </div>
      </header>

      <nav className="view-tabs" aria-label="Application views">
        <div role="tablist" aria-label="BrowserSDR views">
          <button
            type="button"
            role="tab"
            id="receiver-tab"
            aria-selected={activeView === "receiver"}
            aria-controls="receiver-view"
            tabIndex={activeView === "receiver" ? 0 : -1}
            onClick={() => setActiveView("receiver")}
            onKeyDown={handleTabKeyDown}
          >
            <span>Receiver</span>
            <small>Tune, listen & record</small>
          </button>
          <button
            type="button"
            role="tab"
            id="explorer-tab"
            aria-selected={activeView === "explorer"}
            aria-controls="explorer-view"
            tabIndex={activeView === "explorer" ? 0 : -1}
            onClick={() => setActiveView("explorer")}
            onKeyDown={handleTabKeyDown}
          >
            <span>Explorer</span>
            <small>Scan & investigate</small>
          </button>
          <button
            type="button"
            role="tab"
            id="diagnostics-tab"
            aria-selected={activeView === "diagnostics"}
            aria-controls="diagnostics-view"
            tabIndex={activeView === "diagnostics" ? 0 : -1}
            onClick={() => setActiveView("diagnostics")}
            onKeyDown={handleTabKeyDown}
          >
            <span>Diagnostics</span>
            <small>Telemetry & setup</small>
          </button>
        </div>
        <p>{activeView === "receiver" ? "Live radio workspace" : activeView === "explorer" ? "Wideband spectrum survey" : "Session health and browser support"}</p>
      </nav>

      <div
        id="receiver-view"
        role="tabpanel"
        aria-labelledby="receiver-tab"
        hidden={activeView !== "receiver"}
      >

      <section className="control-panel signal-chain-panel" aria-labelledby="receiver-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live signal path</p>
            <h2 id="receiver-heading">Receive & demodulate</h2>
          </div>
          <span className={`status-pill status-${receiver.lifecycle}`}>{receiver.lifecycle.replace("-", " ")}</span>
        </div>

        <div className="signal-map" aria-label="Receiver signal flow">
          <span>Acquire</span><i aria-hidden="true">→</i><span>Tune & demodulate</span><i aria-hidden="true">→</i><span>Listen & decode</span>
          <small>Analysis and capture tap the I/Q stream in parallel.</small>
        </div>

        <div className="signal-stage-grid">
          <section className="signal-stage" aria-labelledby="acquire-heading">
            <div className="stage-heading"><span aria-hidden="true">01</span><div><p>Acquire</p><h3 id="acquire-heading">Signal source</h3></div></div>
            <div className="stage-controls acquire-controls">
              <label>
                Source
                <select value={source} disabled={transitioning || hardwareConnected} onChange={(event) => void switchSource(event.currentTarget.value as SourceKind)} aria-label="Signal source">
                  <option value="rtl-sdr">RTL-SDR device</option>
                  <option value="synthetic">Synthetic spectrum demo</option>
                  <option value="replay">CU8 recording replay</option>
                </select>
              </label>
              {source === "rtl-sdr" && (
                <label>
                  Sample rate
                  <select value={sampleRateHz} disabled={transitioning || hardwareConnected} onChange={(event) => setSampleRateHz(Number(event.currentTarget.value))}>
                    {RTL_SAMPLE_RATE_OPTIONS_HZ.map((rate) => <option key={rate} value={rate}>{(rate / 1_000_000).toFixed(3)} MS/s</option>)}
                  </select>
                  <small>2.4 MS/s captures full DAB bandwidth and resolves ADS-B pulses; recording time is shorter.</small>
                </label>
              )}
              {source === "rtl-sdr" && (
                <div className="gain-control">
                  <label>
                    RF gain
                    <select value={gainDb === null ? "auto" : "manual"} disabled={transitioning} onChange={(event) => applyGain(event.currentTarget.value === "auto" ? null : 25)}>
                      <option value="auto">Automatic</option><option value="manual">Manual</option>
                    </select>
                  </label>
                  {gainDb !== null && <label><span>Requested manual gain <output>{gainDb.toFixed(1)} dB</output></span><input type="range" min="0" max={MANUAL_GAIN_MAX_DB} step="0.1" value={gainDb} disabled={transitioning} onChange={(event) => setGainDb(event.currentTarget.valueAsNumber)} onPointerUp={() => applyGain(gainDb)} onKeyUp={() => applyGain(gainDb)} /></label>}
                </div>
              )}
              {source === "rtl-sdr" ? (
                <div className="connection-stack">
                  <div className="connection-row">
                    <span><i className={`connection-dot ${hardwareConnected ? "is-active" : ""}`} />Hardware</span>
                    <div className="transport">
                      <button type="button" onClick={connectReceiver} disabled={receiver.lifecycle !== "idle" && !(receiver.lifecycle === "error" && !receiver.cleanupRequired)}>Connect</button>
                      <button type="button" className="secondary" onClick={() => void disconnectReceiver()} disabled={receiver.lifecycle !== "connected" && !(receiver.lifecycle === "error" && receiver.cleanupRequired)}>Disconnect</button>
                    </div>
                  </div>
                  <div className="connection-row">
                    <span><i className={`connection-dot ${running ? "is-receiving" : ""}`} />Reception</span>
                    <div className="transport">
                      <button type="button" onClick={start} disabled={receiver.lifecycle !== "connected"}>Start receiving</button>
                      <button type="button" className="secondary" onClick={() => void stopReceiver()} disabled={scanActive || (!running && receiver.lifecycle !== "tuning")}>Stop receiving</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="transport" aria-label="Receiver transport">
                  <button type="button" onClick={start} disabled={busy || (source === "replay" && !loadedReplay)}>{source === "synthetic" ? "Start demo" : "Start replay"}</button>
                  <button type="button" className="secondary" onClick={() => void stopReceiver()} disabled={scanActive || !busy || receiver.lifecycle === "stopping"}>Stop</button>
                </div>
              )}
            </div>
          </section>

          <section className="signal-stage" aria-labelledby="demodulate-heading">
            <div className="stage-heading"><span aria-hidden="true">02</span><div><p>Tune & demodulate</p><h3 id="demodulate-heading">Channel settings</h3></div></div>
            <div className="stage-controls tuning-controls">
              <label>
                Channel frequency
                <span className="unit-input">
                  <input type="number" min="0.000001" step="0.000001" value={Number.isFinite(frequencyMhz) ? frequencyMhz : ""} disabled={transitioning} onChange={(event) => setFrequencyMhz(event.currentTarget.valueAsNumber)} onKeyDown={(event) => { if (event.key === "Enter" && running && frequencyValid) tune(frequencyMhz * 1_000_000); }} aria-describedby="frequency-help" />
                  <span>MHz</span>
                </span>
                <small id="frequency-help">Checked by the connected tuner · stored internally as Hz</small>
              </label>
              <button type="button" className="secondary tune-button" disabled={!running || !frequencyValid} onClick={() => tune(frequencyMhz * 1_000_000)}>Tune</button>
              <label>
                Volume <output>{Math.round(volume * 100)}%</output>
                <input className="volume-slider" type="range" min="0" max="1" step="0.01" value={volume} disabled={source === "synthetic" || ["DAB", "ADS-B", "AIS"].includes(mode)} onChange={(event) => updateVolume(event.currentTarget.valueAsNumber)} />
                <small>{source === "synthetic" ? "Demo has no audio output" : ["DAB", "ADS-B", "AIS"].includes(mode) ? `${mode} is a data receiver` : `${mode} audio`}</small>
              </label>
            </div>
            <div className="stage-controls demodulation-controls" aria-label="Channel demodulation settings">
              <label>
                Mode
                <select value={mode} disabled={transitioning} onChange={(event) => chooseMode(event.currentTarget.value as ReceiverMode)}>
                  {RECEIVER_MODES.map((candidate) => <option
                    key={candidate}
                    value={candidate}
                    disabled={["DAB", "ADS-B", "AIS"].includes(candidate) && (source === "synthetic" || (candidate !== "AIS" && hardwareConnected && (receiver.session?.actualSampleRateHz ?? sampleRateHz) < 2_000_000))}
                  >{candidate === "DAB" ? "DAB / DAB+" : candidate}</option>)}
                </select>
              </label>
              {mode === "DAB" && (
                <label>
                  Band III channel
                  <select value={dabChannelAt(frequencyMhz * 1_000_000)?.label ?? "custom"} disabled={transitioning} onChange={(event) => {
                    const channel = DAB_BAND_III_CHANNELS.find((candidate) => candidate.label === event.currentTarget.value);
                    if (!channel) return;
                    setFrequencyMhz(channel.frequencyHz / 1_000_000);
                    saveNumber(FREQUENCY_KEY, channel.frequencyHz / 1_000_000);
                    if (running) tune(channel.frequencyHz);
                  }}>
                    {!dabChannelAt(frequencyMhz * 1_000_000) && <option value="custom">Custom frequency</option>}
                    {DAB_BAND_III_CHANNELS.map((channel) => <option key={channel.label} value={channel.label}>{channel.label} · {(channel.frequencyHz / 1_000_000).toFixed(3)} MHz</option>)}
                  </select>
                </label>
              )}
              {modeCaps.bandwidthSettable ? (
                <label>
                  Channel bandwidth
                  <span className="unit-input"><input type="number" min={modeCaps.minimumBandwidthHz} max={modeCaps.maximumBandwidthHz} step="10" value={bandwidthHz} disabled={transitioning} onChange={(event) => setBandwidthHz(event.currentTarget.valueAsNumber)} /><span>Hz</span></span>
                  <small>{modeCaps.minimumBandwidthHz.toLocaleString()}–{modeCaps.maximumBandwidthHz.toLocaleString()} Hz</small>
                </label>
              ) : <div className="readout"><span>Channel bandwidth</span><strong>{bandwidthHz.toLocaleString()} Hz fixed</strong></div>}
              {modeCaps.squelchSettable && (
                <label>
                  Squelch <output>{squelch.toFixed(1)}</output>
                  <input type="range" min="0" max="6" step="0.1" value={squelch} disabled={transitioning} onChange={(event) => setSquelch(event.currentTarget.valueAsNumber)} />
                  <small>0 keeps audio open</small>
                </label>
              )}
              <button type="button" className="secondary" disabled={!running} onClick={applyMode}>Apply channel</button>
            </div>
          </section>
        </div>

        <div className={`receiver-status receiver-status-${receiver.lifecycle}`} role={receiver.lifecycle === "error" ? "alert" : "status"}>
          <span className="status-light" />
          <div>
            <strong>{receiver.message}</strong>
            {running && receiver.session ? (
              <p>
                Center {(receiver.session.hardwareCenterFrequencyHz / 1_000_000).toFixed(6)} MHz · selected {(receiver.session.selectedChannelFrequencyHz / 1_000_000).toFixed(6)} MHz · {receiver.session.mode} · {receiver.session.channelBandwidthHz.toLocaleString()} Hz channel · {receiver.session.gainDb === null ? "automatic gain" : `${receiver.session.gainDb.toFixed(1)} dB requested gain`} · actual rate {receiver.session.actualSampleRateHz.toLocaleString()} samples/s
              </p>
            ) : (
              <p>{source === "synthetic" ? "Demo uses deterministic complex RF tones and no audio." : source === "replay" ? "Replay is paced from sample counts and never opens a USB chooser." : receiver.lifecycle === "connected" ? "The USB device remains open while sample transfers and audio are stopped." : "Connect opens the browser device chooser. Reception starts only when you request it."}</p>
            )}
          </div>
        </div>
      </section>

      <WebGpuSpectrum pipeline={analysis} session={receiver.session} onTune={running && !scanActive ? tune : undefined} />

      <section className="control-panel rds-panel decode-panel" aria-labelledby="decode-heading">
        <div className="panel-heading">
          <div><p className="eyebrow">Listen & decode</p><h2 id="decode-heading">Decoded data</h2></div>
          <span className={`status-pill ${(mode === "DAB" ? receiver.dab?.state === "synchronized" : mode === "ADS-B" ? receiver.adsb?.validFrames : mode === "AIS" ? receiver.ais?.validFrames : receiver.rds?.validGroups) ? "status-running" : "status-idle"}`}>
            {mode === "DAB" ? receiver.dab?.state ?? "not started" : mode === "ADS-B" ? `${receiver.adsb?.validFrames ?? 0} valid frames` : mode === "AIS" ? `${receiver.ais?.validFrames ?? 0} valid frames` : receiver.rds?.validGroups ? `${receiver.rds.validGroups} valid groups` : source === "synthetic" ? "no audio" : `${mode} audio`}
          </span>
        </div>
        <div className="decode-layout">
          <div className="audio-summary"><span>{mode === "DAB" ? "Ensemble acquisition" : mode === "ADS-B" || mode === "AIS" ? "Data acquisition" : "Audio output"}</span><strong>{mode === "DAB" ? receiver.dab?.message ?? "Not active" : mode === "ADS-B" ? receiver.adsb?.message ?? "Not active" : mode === "AIS" ? receiver.ais?.message ?? "Not active" : source === "synthetic" ? "Not available in demo" : receiver.audioState ?? "Not active"}</strong><small>{mode === "DAB" ? "Mode I · complete 2.4 MS/s capture required" : mode === "ADS-B" ? "1090ES · CRC-validated Mode S frames" : mode === "AIS" ? "AIS 1 + AIS 2 · dual-channel GMSK" : source === "synthetic" ? "Use RTL-SDR or replay to listen." : `${mode} demodulation · ${Math.round(volume * 100)}% volume`}</small></div>
          <div className="rds-content">
            <h3>{mode === "DAB" ? "Digital Audio Broadcasting" : mode === "ADS-B" ? "Aircraft targets" : mode === "AIS" ? "Vessel targets" : "Radio Data System"}</h3>
            {mode === "DAB" ? (
              <>
                <dl className="rds-grid">
                  <div><dt>Transmission frames</dt><dd>{receiver.dab?.frameCount ?? 0}</dd></div>
                  <div><dt>Null symbols</dt><dd>{receiver.dab?.nullSymbolCount ?? 0}</dd></div>
                  <div><dt>Estimated signal/null</dt><dd>{receiver.dab?.estimatedSnrDb == null ? "—" : `${receiver.dab.estimatedSnrDb.toFixed(1)} dB`}</dd></div>
                  <div><dt>Coarse frequency offset</dt><dd>{receiver.dab?.coarseFrequencyOffsetHz == null ? "—" : `${receiver.dab.coarseFrequencyOffsetHz.toFixed(0)} Hz`}</dd></div>
                </dl>
                <p className="display-note">The built-in permissive front end acquires DAB mode I frames. FIC/MSC service and HE-AAC audio decoding use a replaceable decoder boundary and are not bundled, avoiding a GPL dependency or a fixed codec-license choice.</p>
              </>
            ) : mode === "ADS-B" ? (
              <>
                <dl className="rds-grid"><div><dt>Candidate frames</dt><dd>{receiver.adsb?.frames ?? 0}</dd></div><div><dt>Valid frames</dt><dd>{receiver.adsb?.validFrames ?? 0}</dd></div><div><dt>Rejected</dt><dd>{receiver.adsb?.rejectedFrames ?? 0}</dd></div><div><dt>Targets</dt><dd>{receiver.adsb?.targets.length ?? 0}</dd></div></dl>
                <PositionPlot label="ADS-B target positions" targets={(receiver.adsb?.targets ?? []).map((target) => ({ latitude: target.latitude, longitude: target.longitude, label: target.callsign ?? target.icao }))} />
                <div className="target-table-wrap"><table className="target-table"><thead><tr><th>Aircraft</th><th>Altitude</th><th>Speed / track</th><th>Position</th><th>Messages</th></tr></thead><tbody>{(receiver.adsb?.targets ?? []).slice(0, 50).map((target) => <tr key={target.icao}><td><strong>{target.callsign ?? "—"}</strong><small>{target.icao}</small></td><td>{target.altitudeFt == null ? "—" : `${target.altitudeFt.toLocaleString()} ft`}</td><td>{target.groundSpeedKt == null ? "—" : `${target.groundSpeedKt.toFixed(0)} kt · ${target.trackDegrees?.toFixed(0) ?? "—"}°`}</td><td>{target.latitude == null ? "—" : `${target.latitude.toFixed(4)}, ${target.longitude?.toFixed(4)}`}</td><td>{target.messages}</td></tr>)}</tbody></table></div>
                <button type="button" className="secondary" disabled={!receiver.adsb?.targets.length} onClick={() => downloadDecodedTargets("ADS-B", receiver.adsb?.targets ?? [])}>Export targets JSON</button>
              </>
            ) : mode === "AIS" ? (
              <>
                <dl className="rds-grid"><div><dt>AIS 1 frames</dt><dd>{receiver.ais?.channel1Frames ?? 0}</dd></div><div><dt>AIS 2 frames</dt><dd>{receiver.ais?.channel2Frames ?? 0}</dd></div><div><dt>Rejected</dt><dd>{receiver.ais?.rejectedFrames ?? 0}</dd></div><div><dt>Vessels</dt><dd>{receiver.ais?.targets.length ?? 0}</dd></div></dl>
                <PositionPlot label="AIS vessel positions" targets={(receiver.ais?.targets ?? []).map((target) => ({ latitude: target.latitude, longitude: target.longitude, label: target.name ?? String(target.mmsi) }))} />
                <div className="target-table-wrap"><table className="target-table"><thead><tr><th>Vessel</th><th>Channel</th><th>Speed / course</th><th>Position</th><th>Messages</th></tr></thead><tbody>{(receiver.ais?.targets ?? []).slice(0, 50).map((target) => <tr key={target.mmsi}><td><strong>{target.name ?? "—"}</strong><small>{target.callSign ?? target.mmsi}</small></td><td>{target.channel}</td><td>{target.speedKnots == null ? "—" : `${target.speedKnots.toFixed(1)} kt · ${target.courseDegrees?.toFixed(1) ?? "—"}°`}</td><td>{target.latitude == null ? "—" : `${target.latitude.toFixed(4)}, ${target.longitude?.toFixed(4)}`}</td><td>{target.messages}</td></tr>)}</tbody></table></div>
                <button type="button" className="secondary" disabled={!receiver.ais?.targets.length} onClick={() => downloadDecodedTargets("AIS", receiver.ais?.targets ?? [])}>Export targets JSON</button>
              </>
            ) : mode !== "WBFM" ? (
              <p className="rds-empty">RDS decoding is available only in WBFM. Audio remains available for the selected mode.</p>
            ) : !receiver.rds?.validGroups ? (
              <p className="rds-empty">No validated station data decoded yet.</p>
            ) : (
              <dl className="rds-grid">
                <div><dt>PI identifier</dt><dd>{receiver.rds.pi ?? "—"}</dd></div>
                <div><dt>Programme Service</dt><dd>{receiver.rds.programmeService ?? "Waiting for all PS segments…"}</dd></div>
                <div className="rds-text"><dt>RadioText</dt><dd>{receiver.rds.radioText ?? "Waiting for RadioText…"}</dd></div>
              </dl>
            )}
            {mode === "WBFM" && <p className="display-note">Text appears only after CRC and block-offset validation. Retuning, changing station PI, or leaving WBFM clears prior data.</p>}
          </div>
        </div>
      </section>

      <section className="control-panel capture-panel" aria-labelledby="recording-heading">
        <div className="panel-heading"><div><p className="eyebrow">Capture & replay</p><h2 id="recording-heading">I/Q recordings</h2></div></div>
        <p>CU8 stores exact RTL-SDR transport bytes as interleaved unsigned I,Q. The 32 MiB memory cap is {receiver.session ? recordingCapacitySeconds(receiver.session.actualSampleRateHz).toFixed(1) : recordingCapacitySeconds(1_024_000).toFixed(1)} seconds at the current/default rate; at 2.4 MS/s it is {recordingCapacitySeconds(2_400_000).toFixed(1)} seconds.</p>
        <div className="recording-controls">
          <label className="recording-format">
            Export format
            <select
              aria-label="Recording export format"
              value={recordingFormat}
              disabled={formatControlDisabled(recordingStatus, exportingRecording)}
              onChange={(event) => setRecordingFormat(event.currentTarget.value as RecordingExportFormat)}
            >
              <option value="browsersdr">BrowserSDR replay (.cu8 + .json)</option>
              <option value="sigmf">SigMF (.sigmf-data + .sigmf-meta)</option>
            </select>
          </label>
          <button type="button" disabled={!running || scanActive || Boolean(recordingStatus) || exportingRecording || exportRetryAvailable} onClick={startRecording}>Start I/Q recording</button>
          <button type="button" className="secondary" disabled={!recordingStatus || exportingRecording} onClick={stopRecording}>Stop & export</button>
          {exportRetryAvailable && <button type="button" className="secondary" disabled={exportingRecording} onClick={retryRecordingExport}>Retry export</button>}
          <span>{recordingStatus ? `${(recordingStatus.bytes / (1024 * 1024)).toFixed(2)} / ${(RECORDING_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB · ${recordingStatus.state.replace("-", " ")}` : "Not recording"}</span>
        </div>
        <p className="display-note">The chosen format is locked for each recording segment. SigMF export hashes the completed bytes after recording stops.</p>
        <div className="replay-inputs">
          <label className="file-picker">
            BrowserSDR CU8 binary
            <span className="file-picker-control">
              <input className="file-picker-input" type="file" accept=".cu8,application/octet-stream" onChange={(event) => setReplayBinary(event.currentTarget.files?.[0])} />
              <span className="file-picker-button" aria-hidden="true">Choose file</span>
              <span className="file-picker-name" aria-hidden="true">{replayBinary?.name ?? "No file chosen"}</span>
            </span>
          </label>
          <label className="file-picker">
            BrowserSDR JSON sidecar
            <span className="file-picker-control">
              <input className="file-picker-input" type="file" accept=".json,application/json" onChange={(event) => setReplayMetadata(event.currentTarget.files?.[0])} />
              <span className="file-picker-button" aria-hidden="true">Choose file</span>
              <span className="file-picker-name" aria-hidden="true">{replayMetadata?.name ?? "No file chosen"}</span>
            </span>
          </label>
          <button type="button" className="secondary" disabled={!replayBinary || !replayMetadata || busy} onClick={() => void loadReplayFiles()}>Load files</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => useReplay(createDeterministicRecordingFixture(), "Loaded generated 0.5 s AM fixture: +6 kHz carrier, 1 kHz audio tone, 48 ksample/s.")}>Use deterministic fixture</button>
        </div>
        <p className="file-message" role="status">{fileMessage}</p>
      </section>

      </div>

      <div
        id="explorer-view"
        role="tabpanel"
        aria-labelledby="explorer-tab"
        hidden={activeView !== "explorer"}
      >
        <SpectrumExplorer
          pipeline={analysis}
          controller={controller}
          receiver={receiver}
          initialFrequencyHz={frequencyMhz * 1_000_000}
          volume={volume}
          recordingBlocked={Boolean(recordingStatus) || exportingRecording || exportRetryAvailable}
          startReceptionForScan={startReceptionForScan}
          onScanningChange={setScanActive}
          onCaptureCandidates={captureSurveyCandidates}
          onInvestigate={(frequencyHz) => {
            setActiveView("receiver");
            tune(frequencyHz);
          }}
        />
      </div>

      <div
        id="diagnostics-view"
        role="tabpanel"
        aria-labelledby="diagnostics-tab"
        hidden={activeView !== "diagnostics"}
      >

      <DiagnosticsPanel pipeline={analysis} receiver={receiver} />

      <section className="capabilities-panel" aria-labelledby="capabilities-heading">
        <div className="panel-heading">
          <div><p className="eyebrow">Environment</p><h2 id="capabilities-heading">Capability checks</h2></div>
        </div>
        <ul className="capability-list">
          {detectedCapabilities.map((capability) => (
            <li key={capability.label}>
              <span className={capability.available ? "check yes" : "check no"} aria-hidden="true">{capability.available ? "✓" : "!"}</span>
              <span><strong>{capability.label}</strong><small>{capability.detail}</small></span>
            </li>
          ))}
        </ul>
      </section>

      <section className="help-panel" aria-labelledby="device-help-heading">
        <p className="eyebrow">Device setup</p>
        <h2 id="device-help-heading">If the dongle will not connect</h2>
        <p>Use an RTL2832U device with an R820/R828/R860 tuner. Close other SDR software first. On Windows, WebUSB may require a WinUSB driver; on Linux, the DVB kernel driver may already own the device. Do not change drivers unless the instructions for your hardware and OS require it.</p>
        <div className="system-troubleshooting" aria-label="Operating system troubleshooting hints">
          <article>
            <h3>Windows</h3>
            <p>Close SDR applications, then use Zadig to assign the WinUSB driver to the RTL2832U interface. Reconnect the dongle and restart the browser.</p>
          </article>
          <article>
            <h3>Linux</h3>
            <p>If the DVB driver owns the device, close TV/SDR software and unload the module temporarily:</p>
            <code>sudo rmmod dvb_usb_rtl28xxu</code>
            <small>This can disable DVB use until the module is reloaded or the computer restarts.</small>
          </article>
          <article>
            <h3>macOS</h3>
            <p>Close other SDR applications, reconnect the dongle, and use a current Chromium-based browser. A separate USB driver is normally unnecessary.</p>
          </article>
        </div>
        <div className="help-links">
          <a href="https://developer.chrome.com/docs/capabilities/build-for-webusb" target="_blank" rel="noreferrer">Chrome WebUSB guidance ↗</a>
          <a href="https://github.com/jtarrio/webrtlsdr#compatible-hardware-and-software" target="_blank" rel="noreferrer">Supported hardware ↗</a>
          <a href="https://www.rtl-sdr.com/rtl-sdr-quick-start-guide/" target="_blank" rel="noreferrer">RTL-SDR setup guide ↗</a>
        </div>
      </section>
      </div>
    </main>
  );
}
