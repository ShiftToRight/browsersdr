import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnalysisPipeline, type AnalysisDiagnostics } from "./dsp/analysisPipeline";
import { WebGpuSpectrum } from "./graphics/WebGpuSpectrum";
import {
  ReceiverController,
  type ReceiverSnapshot,
} from "./radio/receiverController";
import { createRtlSdrBackend } from "./radio/rtlSdrBackend";
import { SyntheticBackend } from "./radio/syntheticBackend";
import { ReplayBackend } from "./radio/replayBackend";
import type { SourceKind } from "./radio/types";
import {
  parseRecording,
  recordingCapacitySeconds,
  recordingMetadataJson,
  RECORDING_MAX_BYTES,
  RECORDING_METADATA_MAX_BYTES,
  type IqRecording,
  type RecordingStatus,
} from "./radio/iqRecording";
import { createDeterministicRecordingFixture } from "./testing/recordingFixture";
import {
  defaultModeSettings,
  MANUAL_GAIN_MAX_DB,
  modeCapabilities,
  normalizeModeSettings,
  RECEIVER_MODES,
  type ReceiverMode,
} from "./radio/receiverConfig";

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
const DEFAULT_FREQUENCY_MHZ = 100;
const DEFAULT_VOLUME = 0.65;
const MAX_SAFE_FREQUENCY_MHZ = Number.MAX_SAFE_INTEGER / 1_000_000;
type AppView = "receiver" | "diagnostics";

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

function downloadRecording(recording: IqRecording): void {
  const stem = `browsersdr-${recording.metadata.captureStartedAt.replace(/[:.]/g, "-")}`;
  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  download(new Blob([recording.data.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }), `${stem}.cu8`);
  download(new Blob([recordingMetadataJson(recording)], { type: "application/json" }), `${stem}.json`);
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
  const [loadedReplay, setLoadedReplay] = useState<IqRecording>();
  const [replayBinary, setReplayBinary] = useState<File>();
  const [replayMetadata, setReplayMetadata] = useState<File>();
  const [fileMessage, setFileMessage] = useState("Load a .cu8 binary and its .json sidecar, or use the deterministic fixture.");
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>();
  const [activeView, setActiveView] = useState<AppView>("receiver");
  const detectedCapabilities = capabilities();
  const busy = Boolean(receiver.cleanupRequired) || ["requesting-permission", "starting", "running", "tuning", "stopping"].includes(receiver.lifecycle);
  const running = receiver.lifecycle === "running";
  const transitioning = ["requesting-permission", "starting", "tuning", "stopping"].includes(receiver.lifecycle);
  const frequencyValid = Number.isFinite(frequencyMhz) && frequencyMhz > 0;
  const modeCaps = modeCapabilities(mode);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setReceiver);
    return () => {
      unsubscribe();
      void controller.stop().finally(() => analysis.dispose());
    };
  }, [analysis, controller]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRecordingStatus(controller.getRecordingStatus());
      const completed = controller.takeCompletedRecording();
      if (completed) {
        downloadRecording(completed);
        setFileMessage(`Recording stopped (${completed.metadata.stopReason}); downloaded ${completed.metadata.sampleCount.toLocaleString()} samples.`);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [controller]);

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
    void controller.start({ source, channelFrequencyHz: frequencyMhz * 1_000_000, volume, modeSettings: rawSettings, gainDb });
  };

  const switchSource = async (nextSource: SourceKind) => {
    if (receiver.lifecycle !== "idle" && (receiver.lifecycle !== "error" || receiver.cleanupRequired)) await controller.stop();
    if (controller.getSnapshot().cleanupRequired) return;
    const completed = controller.takeCompletedRecording();
    if (completed) downloadRecording(completed);
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
      if (completed) downloadRecording(completed);
    });
  }, [controller]);

  const chooseMode = (nextMode: ReceiverMode) => {
    const next = defaultModeSettings(nextMode);
    setMode(nextMode);
    setBandwidthHz(next.bandwidthHz);
    setSquelch(next.squelch);
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
        if (completed) downloadRecording(completed);
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
      if (completed) downloadRecording(completed);
    });
  };

  const stopReceiver = async () => {
    await controller.stop();
    const completed = controller.takeCompletedRecording();
    if (completed) downloadRecording(completed);
    setRecordingStatus(undefined);
  };

  const startRecording = () => {
    const status = controller.startRecording();
    setRecordingStatus(status);
    if (status) setFileMessage("Recording CU8 I/Q in bounded memory. Stop to download the binary and JSON sidecar.");
  };

  const stopRecording = () => {
    const recording = controller.stopRecording();
    setRecordingStatus(undefined);
    if (recording) {
      downloadRecording(recording);
      controller.takeCompletedRecording();
      setFileMessage(`Downloaded ${recording.metadata.sampleCount.toLocaleString()} samples and metadata.`);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextView: AppView | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextView = activeView === "receiver" ? "diagnostics" : "receiver";
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
        <div className="build-badge">Validated FM RDS · 09</div>
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
        <p>{activeView === "receiver" ? "Live radio workspace" : "Session health and browser support"}</p>
      </nav>

      <div
        id="receiver-view"
        role="tabpanel"
        aria-labelledby="receiver-tab"
        hidden={activeView !== "receiver"}
      >

      <section className="control-panel" aria-labelledby="receiver-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Receiver</p>
            <h2 id="receiver-heading">Channel receiver</h2>
          </div>
          <span className={`status-pill status-${receiver.lifecycle}`}>{receiver.lifecycle.replace("-", " ")}</span>
        </div>

        <div className="controls-grid receiver-controls">
          <label>
            Source
            <select value={source} disabled={transitioning} onChange={(event) => void switchSource(event.currentTarget.value as SourceKind)} aria-label="Signal source">
              <option value="rtl-sdr">RTL-SDR device</option>
              <option value="synthetic">Synthetic spectrum demo</option>
              <option value="replay">CU8 recording replay</option>
            </select>
          </label>
          <label>
            Channel frequency
            <span className="unit-input">
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={Number.isFinite(frequencyMhz) ? frequencyMhz : ""}
                disabled={transitioning}
                onChange={(event) => setFrequencyMhz(event.currentTarget.valueAsNumber)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && running && frequencyValid) tune(frequencyMhz * 1_000_000);
                }}
                aria-describedby="frequency-help"
              />
              <span>MHz</span>
            </span>
            <small id="frequency-help">Tuner support is checked by the connected device · stored internally as Hz</small>
          </label>
          <button type="button" className="secondary tune-button" disabled={!running || !frequencyValid} onClick={() => tune(frequencyMhz * 1_000_000)}>Tune</button>
          <label>
            Volume <output>{Math.round(volume * 100)}%</output>
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              disabled={source === "synthetic"}
              onChange={(event) => updateVolume(event.currentTarget.valueAsNumber)}
            />
            <small>{source === "synthetic" ? "Demo has no audio output" : `${mode} audio`}</small>
          </label>
          <div className="transport" aria-label="Receiver transport">
            <button type="button" onClick={start} disabled={busy || (source === "replay" && !loadedReplay)}>{source === "synthetic" ? "Start demo" : source === "replay" ? "Start replay" : "Connect & start"}</button>
            <button type="button" className="secondary" onClick={() => void stopReceiver()} disabled={!busy || receiver.lifecycle === "stopping"}>Stop</button>
          </div>
        </div>

        <div className="channel-controls" aria-label="Channel demodulation settings">
          <label>
            Mode
            <select value={mode} disabled={transitioning} onChange={(event) => chooseMode(event.currentTarget.value as ReceiverMode)}>
              {RECEIVER_MODES.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </label>
          {modeCaps.bandwidthSettable ? (
            <label>
              Channel bandwidth
              <span className="unit-input"><input type="number" min={modeCaps.minimumBandwidthHz} max={modeCaps.maximumBandwidthHz} step="10" value={bandwidthHz} disabled={transitioning} onChange={(event) => setBandwidthHz(event.currentTarget.valueAsNumber)} /><span>Hz</span></span>
              <small>{modeCaps.minimumBandwidthHz.toLocaleString()}–{modeCaps.maximumBandwidthHz.toLocaleString()} Hz (upstream filter)</small>
            </label>
          ) : <div className="readout"><span>Channel bandwidth</span><strong>{bandwidthHz.toLocaleString()} Hz fixed</strong></div>}
          {modeCaps.squelchSettable && (
            <label>
              Squelch <output>{squelch.toFixed(1)}</output>
              <input type="range" min="0" max="6" step="0.1" value={squelch} disabled={transitioning} onChange={(event) => setSquelch(event.currentTarget.valueAsNumber)} />
              <small>Upstream SNR ratio · 0 keeps audio open</small>
            </label>
          )}
          <button type="button" className="secondary" disabled={!running} onClick={applyMode}>Apply channel</button>
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
              <p>{source === "synthetic" ? "Demo uses deterministic complex RF tones and no audio." : source === "replay" ? "Replay is paced from sample counts and never opens a USB chooser." : "Start opens the browser device chooser. BrowserSDR never reconnects or starts audio on page load."}</p>
            )}
          </div>
        </div>
      </section>

      <section className="control-panel rds-panel" aria-labelledby="rds-heading">
        <div className="panel-heading">
          <div><p className="eyebrow">FM data</p><h2 id="rds-heading">Radio Data System</h2></div>
          <span className={`status-pill ${receiver.rds?.validGroups ? "status-running" : "status-idle"}`}>
            {receiver.rds?.validGroups ? `${receiver.rds.validGroups} valid groups` : "waiting"}
          </span>
        </div>
        {receiver.session && receiver.session.mode !== "WBFM" ? (
          <p className="rds-empty">RDS is available only while receiving WBFM.</p>
        ) : !receiver.rds?.validGroups ? (
          <p className="rds-empty">No RDS decoded</p>
        ) : (
          <dl className="rds-grid">
            <div><dt>PI identifier</dt><dd>{receiver.rds.pi ?? "—"}</dd></div>
            <div><dt>Programme Service</dt><dd>{receiver.rds.programmeService ?? "Waiting for all PS segments…"}</dd></div>
            <div className="rds-text"><dt>RadioText</dt><dd>{receiver.rds.radioText ?? "Waiting for RadioText…"}</dd></div>
          </dl>
        )}
        <p className="display-note">Text appears only after CRC and block-offset validation. Retuning, changing station PI, or leaving WBFM clears prior data.</p>
      </section>

      <section className="control-panel" aria-labelledby="recording-heading">
        <div className="panel-heading"><div><p className="eyebrow">Portable capture</p><h2 id="recording-heading">I/Q record & replay</h2></div></div>
        <p>CU8 stores exact RTL-SDR transport bytes as interleaved unsigned I,Q. The 32 MiB memory cap is {receiver.session ? recordingCapacitySeconds(receiver.session.actualSampleRateHz).toFixed(1) : recordingCapacitySeconds(1_024_000).toFixed(1)} seconds at the current/default rate; at 2.4 MS/s it is {recordingCapacitySeconds(2_400_000).toFixed(1)} seconds.</p>
        <div className="recording-controls">
          <button type="button" disabled={!running || Boolean(recordingStatus)} onClick={startRecording}>Start I/Q recording</button>
          <button type="button" className="secondary" disabled={!recordingStatus} onClick={stopRecording}>Stop & download</button>
          <span>{recordingStatus ? `${(recordingStatus.bytes / (1024 * 1024)).toFixed(2)} / ${(RECORDING_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB · ${recordingStatus.state.replace("-", " ")}` : "Not recording"}</span>
        </div>
        <div className="replay-inputs">
          <label className="file-picker">
            CU8 binary
            <span className="file-picker-control">
              <input className="file-picker-input" type="file" accept=".cu8,application/octet-stream" onChange={(event) => setReplayBinary(event.currentTarget.files?.[0])} />
              <span className="file-picker-button" aria-hidden="true">Choose file</span>
              <span className="file-picker-name" aria-hidden="true">{replayBinary?.name ?? "No file chosen"}</span>
            </span>
          </label>
          <label className="file-picker">
            JSON sidecar
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

      <WebGpuSpectrum pipeline={analysis} session={receiver.session} onTune={running ? tune : undefined} />

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
