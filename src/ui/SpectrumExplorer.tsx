import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { ReceiverController, ReceiverSnapshot } from "../radio/receiverController";
import {
  DEFAULT_SURVEY_PROFILE, createSurveySessionId, parseSurveyProfile, safeSurveySlug,
  surveyManifestCsv, surveyManifestJson, surveyProfileJson, validateSurveyProfile,
  type SurveyBand, type SurveyCandidateRecord, type SurveyConfidence,
  type SurveyDetectorMode, type SurveyManifest, type SurveyProfile,
} from "../radio/fieldSurvey";
import {
  analyzeScanWindow, canStartSpectrumScan, compressSpectrumPoints,
  mergeSignalCandidates, planSpectrumScan,
  type ScanWindowResult, type SignalCandidate, type SpectrumPoint,
} from "../radio/spectrumScan";
import type { SpectrumFrame } from "../radio/types";

const SETTLE_TIME_MS = 120;
const FRAME_START_TIMEOUT_MS = 1_500;
const MIN_DWELL_MS = 150;
const MAX_DWELL_MS = 10_000;
const PROFILE_STORAGE_KEY = "browsersdr.surveyProfile.v1";

function formatFrequency(frequencyHz: number): string {
  return frequencyHz >= 1_000_000 ? `${(frequencyHz / 1_000_000).toFixed(6)} MHz` : `${(frequencyHz / 1_000).toFixed(3)} kHz`;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Spectrum scan cancelled", "AbortError")); }, { once: true });
  });
}

function collectFrames(pipeline: AnalysisPipeline, generation: number, centerHz: number, dwellMs: number, signal: AbortSignal): Promise<SpectrumFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SpectrumFrame[] = [];
    let dwellTimer: number | undefined;
    const startupTimer = window.setTimeout(() => finish(), FRAME_START_TIMEOUT_MS);
    const unsubscribe = pipeline.subscribe((frame) => {
      if (frame.sessionGeneration !== generation) return;
      if (Math.abs(frame.centerFrequencyHz - centerHz) > frame.sampleRateHz * 0.02) return;
      frames.push({ ...frame, bins: new Float32Array(frame.bins) });
      if (dwellTimer === undefined) {
        window.clearTimeout(startupTimer);
        dwellTimer = window.setTimeout(finish, dwellMs);
      }
    });
    function finish() {
      window.clearTimeout(startupTimer);
      if (dwellTimer !== undefined) window.clearTimeout(dwellTimer);
      unsubscribe(); signal.removeEventListener("abort", abort); resolve(frames);
    }
    function abort() {
      window.clearTimeout(startupTimer);
      if (dwellTimer !== undefined) window.clearTimeout(dwellTimer);
      unsubscribe(); reject(new DOMException("Spectrum scan cancelled", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function loadProfile(): SurveyProfile {
  try { const stored = localStorage.getItem(PROFILE_STORAGE_KEY); return stored ? parseSurveyProfile(stored) : structuredClone(DEFAULT_SURVEY_PROFILE); }
  catch { return structuredClone(DEFAULT_SURVEY_PROFILE); }
}

function storeProfile(profile: SurveyProfile): void {
  try { localStorage.setItem(PROFILE_STORAGE_KEY, surveyProfileJson(profile)); } catch { /* Optional local preference. */ }
}

function downloadText(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function SpectrumOverview({ points, candidates, onInvestigate }: { points: readonly SpectrumPoint[]; candidates: readonly SignalCandidate[]; onInvestigate: (frequencyHz: number) => void }) {
  const compressed = useMemo(() => compressSpectrumPoints(points), [points]);
  if (compressed.length < 2) return <div className="explorer-empty">Spectrum results appear here as each tuning window completes.</div>;
  const lower = compressed[0]!.frequencyHz;
  const upper = compressed.at(-1)!.frequencyHz;
  const floor = Math.min(-80, Math.floor(Math.min(...compressed.map((point) => point.powerDb)) / 10) * 10);
  const ceiling = Math.max(-20, Math.ceil(Math.max(...compressed.map((point) => point.powerDb)) / 10) * 10);
  const x = (frequencyHz: number) => 20 + (frequencyHz - lower) / Math.max(1, upper - lower) * 960;
  const y = (powerDb: number) => 240 - (powerDb - floor) / Math.max(1, ceiling - floor) * 210;
  const path = compressed.map((point) => `${x(point.frequencyHz).toFixed(1)},${y(point.powerDb).toFixed(1)}`).join(" ");
  return <div className="explorer-chart-wrap"><svg className="explorer-chart" viewBox="0 0 1000 270" role="img" aria-label={`Panoramic relative-power spectrum from ${formatFrequency(lower)} to ${formatFrequency(upper)}`}>
    <defs><linearGradient id="explorer-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#58ddff" stopOpacity=".4" /><stop offset="1" stopColor="#58ddff" stopOpacity="0" /></linearGradient></defs>
    {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="20" x2="980" y1={30 + line * 52.5} y2={30 + line * 52.5} className="explorer-grid-line" />)}
    <polygon points={`20,240 ${path} 980,240`} fill="url(#explorer-fill)" /><polyline points={path} className="explorer-trace" />
    {candidates.slice(0, 30).map((candidate) => <g key={`${candidate.frequencyHz}-${candidate.peakDb}`} className="candidate-marker" onClick={() => onInvestigate(candidate.frequencyHz)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onInvestigate(candidate.frequencyHz); }}><line x1={x(candidate.frequencyHz)} x2={x(candidate.frequencyHz)} y1={y(candidate.peakDb)} y2="240" /><circle cx={x(candidate.frequencyHz)} cy={y(candidate.peakDb)} r="5" /></g>)}
    <text x="20" y="260">{formatFrequency(lower)}</text><text x="500" y="260" textAnchor="middle">relative dB · uncalibrated</text><text x="980" y="260" textAnchor="end">{formatFrequency(upper)}</text>
  </svg></div>;
}

export function SpectrumExplorer({ pipeline, controller, receiver, initialFrequencyHz: _initialFrequencyHz, volume, recordingBlocked, startReceptionForScan, onInvestigate, onScanningChange, onCaptureCandidates }: {
  pipeline: AnalysisPipeline; controller: ReceiverController; receiver: ReceiverSnapshot; initialFrequencyHz: number; volume: number;
  recordingBlocked: boolean; startReceptionForScan: () => Promise<ReceiverSnapshot>; onInvestigate: (frequencyHz: number) => void;
  onScanningChange: (active: boolean) => void;
  onCaptureCandidates: (candidates: SurveyCandidateRecord[], profile: SurveyProfile, sessionId: string) => Promise<number[]>;
}) {
  const [profile, setProfile] = useState<SurveyProfile>(loadProfile);
  const [selectedBandId, setSelectedBandId] = useState(profile.bands[0]!.id);
  const selectedBand = profile.bands.find((band) => band.id === selectedBandId) ?? profile.bands[0]!;
  const [startMhz, setStartMhz] = useState(selectedBand.startFrequencyHz / 1_000_000);
  const [endMhz, setEndMhz] = useState(selectedBand.endFrequencyHz / 1_000_000);
  const [dwellMs, setDwellMs] = useState(selectedBand.dwellMs);
  const [thresholdDb, setThresholdDb] = useState(selectedBand.thresholdDb);
  const [detector, setDetector] = useState<SurveyDetectorMode>(selectedBand.detector);
  const [scanning, setScanning] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [windows, setWindows] = useState<ScanWindowResult[]>([]);
  const [records, setRecords] = useState<SurveyCandidateRecord[]>([]);
  const [message, setMessage] = useState("Choose a survey band or run the complete portable profile.");
  const [sessionId, setSessionId] = useState(() => createSurveySessionId());
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date().toISOString());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const profileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  const points = useMemo(() => windows.flatMap((window) => window.points).sort((a, b) => a.frequencyHz - b.frequencyHz), [windows]);
  const displayCandidates = useMemo(() => mergeSignalCandidates(windows.flatMap((window) => window.candidates)), [windows]);
  const canScan = canStartSpectrumScan(receiver.lifecycle, receiver.session?.source, recordingBlocked || capturing);
  const estimatedSeconds = receiver.session && endMhz > startMhz ? planEstimate(startMhz * 1_000_000, endMhz * 1_000_000, receiver.session.actualSampleRateHz, dwellMs) : null;

  const updateProfile = (next: SurveyProfile) => { const valid = validateSurveyProfile(next); setProfile(valid); storeProfile(valid); };
  const loadBand = (band: SurveyBand) => {
    setSelectedBandId(band.id); setStartMhz(band.startFrequencyHz / 1_000_000); setEndMhz(band.endFrequencyHz / 1_000_000);
    setDwellMs(band.dwellMs); setThresholdDb(band.thresholdDb); setDetector(band.detector);
  };
  const chooseBand = (id: string) => { const band = profile.bands.find((entry) => entry.id === id); if (band) loadBand(band); };
  const currentBand = (): SurveyBand => ({ ...selectedBand, startFrequencyHz: startMhz * 1_000_000, endFrequencyHz: endMhz * 1_000_000, dwellMs, thresholdDb, detector });

  const runBands = async (bands: SurveyBand[]) => {
    const initialSession = receiver.session;
    if (!initialSession || !canScan || scanning) return;
    let plans: Array<{ band: SurveyBand; windows: ReturnType<typeof planSpectrumScan> }>;
    try { plans = bands.map((band) => ({ band, windows: planSpectrumScan(band.startFrequencyHz, band.endFrequencyHz, initialSession.actualSampleRateHz) })); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not plan the survey."); return; }
    const total = plans.reduce((sum, item) => sum + item.windows.length, 0);
    const abort = new AbortController(); abortRef.current = abort;
    const shouldStopAfterScan = receiver.lifecycle === "connected";
    let receptionStartedForScan = false;
    let originalFrequencyHz = initialSession.selectedChannelFrequencyHz;
    let completed = 0;
    const nextSessionId = createSurveySessionId();
    setScanning(true); onScanningChange(true); setWindows([]); setRecords([]); setProgress({ completed: 0, total });
    setSessionId(nextSessionId); setSessionStartedAt(new Date().toISOString());
    try {
      let active = controller.getSnapshot();
      if (active.lifecycle === "connected") { active = await startReceptionForScan(); receptionStartedForScan = active.lifecycle === "running"; }
      if (active.lifecycle !== "running" || !active.session) throw new Error(active.message || "Reception could not be started for the survey.");
      originalFrequencyHz = active.session.selectedChannelFrequencyHz; controller.setVolume(0);
      const allRecords: SurveyCandidateRecord[] = [];
      const allWindows: ScanWindowResult[] = [];
      for (const item of plans) {
        const results: ScanWindowResult[] = [];
        setMessage(`Scanning ${item.band.name} with the ${item.band.detector} detector…`);
        for (const windowPlan of item.windows) {
          if (abort.signal.aborted) throw new DOMException("Spectrum scan cancelled", "AbortError");
          const tuned = await controller.scanTune(windowPlan.centerFrequencyHz);
          if (!tuned) throw new Error("The receiver could not tune the next scan window.");
          await wait(SETTLE_TIME_MS, abort.signal);
          const frames = await collectFrames(pipeline, tuned.sessionGeneration, tuned.hardwareCenterFrequencyHz, item.band.dwellMs, abort.signal);
          const result = analyzeScanWindow(windowPlan, frames, item.band.thresholdDb, item.band.detector);
          results.push(result); allWindows.push(result);
          completed += 1; setWindows([...allWindows]); setProgress({ completed, total });
        }
        const bandRecords = mergeSignalCandidates(results.flatMap((result) => result.candidates)).map((candidate): SurveyCandidateRecord => ({
          ...candidate, detector: candidate.detector ?? item.band.detector, bandId: item.band.id, bandName: item.band.name,
          selected: false, captured: false, annotation: { confidence: "unknown" },
        }));
        allRecords.push(...bandRecords); setRecords([...allRecords].sort((a, b) => b.peakDb - a.peakDb));
      }
      setMessage(`Survey complete: ${allRecords.length} candidates across ${bands.length} band${bands.length === 1 ? "" : "s"}. Review classifications before capture or manifest export.`);
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === "AbortError" ? "Survey cancelled; completed candidates are retained." : error instanceof Error ? error.message : "The survey failed.");
    } finally {
      if (["running", "tuning"].includes(controller.getSnapshot().lifecycle)) await controller.tune(originalFrequencyHz);
      controller.setVolume(volume);
      if (shouldStopAfterScan && receptionStartedForScan && ["running", "tuning"].includes(controller.getSnapshot().lifecycle)) await controller.stop();
      abortRef.current = undefined; setScanning(false); onScanningChange(false);
    }
  };

  const setRecord = (index: number, patch: Partial<SurveyCandidateRecord>) => setRecords((current) => current.map((record, cursor) => cursor === index ? { ...record, ...patch } : record));
  const setAnnotation = (index: number, patch: Partial<SurveyCandidateRecord["annotation"]>) => setRecords((current) => current.map((record, cursor) => cursor === index ? { ...record, annotation: { ...record.annotation, ...patch } } : record));
  const captureSelected = async () => {
    const selected = records.filter((record) => record.selected);
    if (!selected.length) { setMessage("Select at least one candidate to capture."); return; }
    setCapturing(true); onScanningChange(true);
    try {
      const captured = await onCaptureCandidates(selected, profile, sessionId);
      setRecords((current) => current.map((record) => captured.includes(record.frequencyHz) ? { ...record, captured: true } : record));
      setMessage(`Captured ${captured.length} selected candidate${captured.length === 1 ? "" : "s"} as annotated SigMF pairs.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Candidate capture failed."); }
    finally { setCapturing(false); onScanningChange(false); }
  };
  const manifest = (): SurveyManifest => ({
    version: 1, sessionId, startedAt: sessionStartedAt, completedAt: new Date().toISOString(), profile,
    receiver: { sampleRateHz: receiver.session?.actualSampleRateHz ?? 0, source: receiver.session?.source ?? "unknown", levels: "relative-dB-uncalibrated" }, candidates: records,
  });
  const importProfile = async (file: File | undefined) => {
    if (!file) return;
    try { const next = parseSurveyProfile(await file.text()); updateProfile(next); loadBand(next.bands[0]!); setMessage(`Imported survey profile “${next.name}”.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not import the profile."); }
  };

  return <section className="explorer-workspace" aria-labelledby="explorer-heading">
    <div className="panel-heading explorer-heading"><div><p className="eyebrow">Portable field survey</p><h2 id="explorer-heading">Spectrum Explorer</h2></div><span className={`status-pill ${scanning || capturing ? "status-tuning" : records.length ? "status-running" : "status-idle"}`}>{scanning ? "scanning" : capturing ? "capturing" : records.length ? `${records.length} candidates` : "ready"}</span></div>
    <section className="survey-profile-panel" aria-label="Survey profile and site">
      <div className="survey-profile-grid">
        <label>Profile name<input value={profile.name} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, name: e.currentTarget.value || "Unnamed survey" })} /></label>
        <label>Site label<input value={profile.site.label} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, site: { ...profile.site, label: e.currentTarget.value || "Unnamed site" } })} /></label>
        <label>Latitude (optional)<input type="number" min="-90" max="90" step="0.000001" value={profile.site.latitude ?? ""} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, site: { ...profile.site, latitude: e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber } })} /></label>
        <label>Longitude (optional)<input type="number" min="-180" max="180" step="0.000001" value={profile.site.longitude ?? ""} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, site: { ...profile.site, longitude: e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber } })} /></label>
        <label>Antenna<input value={profile.site.antenna ?? ""} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, site: { ...profile.site, antenna: e.currentTarget.value } })} /></label>
        <label>Site notes<input value={profile.site.notes ?? ""} disabled={scanning || capturing} onChange={(e) => updateProfile({ ...profile, site: { ...profile.site, notes: e.currentTarget.value } })} /></label>
      </div>
      <div className="survey-actions"><button type="button" className="secondary" disabled={scanning || capturing} onClick={() => downloadText(`${safeSurveySlug(profile.name)}.browsersdr-survey.json`, surveyProfileJson(profile), "application/json")}>Export profile</button><button type="button" className="secondary" disabled={scanning || capturing} onClick={() => profileInputRef.current?.click()}>Import profile</button><input ref={profileInputRef} hidden type="file" accept=".json,application/json" onChange={(e) => void importProfile(e.currentTarget.files?.[0])} /><button type="button" disabled={!canScan || scanning || capturing} onClick={() => void runBands(profile.bands)}>Run complete profile</button><button type="button" className="secondary" disabled={!scanning} onClick={() => abortRef.current?.abort()}>Cancel</button></div>
      <p className="display-note">Coordinates are optional and are written to SigMF only when both are supplied. Profiles remain in this browser until exported.</p>
    </section>
    <div className="explorer-layout"><aside className="explorer-controls" aria-label="Spectrum scan controls">
      <label>Profile band<select value={selectedBandId} disabled={scanning || capturing} onChange={(e) => chooseBand(e.currentTarget.value)}>{profile.bands.map((band) => <option key={band.id} value={band.id}>{band.name}</option>)}</select></label>
      <div className="explorer-range-grid"><label>Start frequency<span className="unit-input"><input type="number" min="0.000001" step="0.001" value={startMhz} disabled={scanning || capturing} onChange={(e) => setStartMhz(e.currentTarget.valueAsNumber)} /><span>MHz</span></span></label><label>End frequency<span className="unit-input"><input type="number" min="0.000001" step="0.001" value={endMhz} disabled={scanning || capturing} onChange={(e) => setEndMhz(e.currentTarget.valueAsNumber)} /><span>MHz</span></span></label></div>
      <label>Detector<select value={detector} disabled={scanning || capturing} onChange={(e) => setDetector(e.currentTarget.value as SurveyDetectorMode)}><option value="average">Average power</option><option value="max-hold">Max hold / bursts</option><option value="occupancy">Occupancy</option><option value="wideband">Wideband plateau</option></select></label>
      <label>Dwell per window <output>{dwellMs} ms</output><input type="range" min={MIN_DWELL_MS} max={MAX_DWELL_MS} step="50" value={dwellMs} disabled={scanning || capturing} onChange={(e) => setDwellMs(e.currentTarget.valueAsNumber)} /></label>
      <label>Detection threshold <output>{thresholdDb} dB</output><input type="range" min="1" max="40" step="1" value={thresholdDb} disabled={scanning || capturing} onChange={(e) => setThresholdDb(e.currentTarget.valueAsNumber)} /><small>Above the detector's local floor</small></label>
      <div className="explorer-actions"><button type="button" disabled={!canScan || scanning || capturing} onClick={() => void runBands([currentBand()])}>Run selected band</button><button type="button" className="secondary" disabled={!records.some((record) => record.selected) || scanning || capturing || receiver.lifecycle !== "running"} onClick={() => void captureSelected()}>Capture selected</button></div>
      <div className="scan-summary"><span>Source</span><strong>{receiver.session?.source ?? "Start receiver"}</strong><span>Estimated time</span><strong>{estimatedSeconds === null ? "—" : `about ${estimatedSeconds.toFixed(1)} s`}</strong><span>Coverage</span><strong>{progress.total ? `${progress.completed} / ${progress.total} windows` : "Not started"}</strong><span>Session</span><strong>{sessionId}</strong></div>
      {progress.total > 0 && <progress value={progress.completed} max={progress.total} aria-label="Spectrum scan progress" />}
      <p className="explorer-note">Average favors continuous transmitters; max-hold and occupancy retain intermittent activity; wideband compares the scan window with guarded spectrum edges. Results remain relative and uncalibrated.</p>
    </aside>
    <div className="explorer-results"><SpectrumOverview points={points} candidates={displayCandidates} onInvestigate={onInvestigate} /><p className="diagnostic-message" role="status">{message}</p>
      <div className="candidate-list-wrap"><div className="candidate-list-heading"><h3>Candidate review</h3><div className="survey-actions"><button type="button" className="secondary" disabled={!records.length} onClick={() => downloadText(`${sessionId}.manifest.json`, surveyManifestJson(manifest()), "application/json")}>Manifest JSON</button><button type="button" className="secondary" disabled={!records.length} onClick={() => downloadText(`${sessionId}.manifest.csv`, surveyManifestCsv(manifest()), "text/csv")}>Manifest CSV</button></div></div>
        {records.length ? <div className="candidate-review-list">{records.slice(0, 200).map((record, index) => <article key={`${record.bandId}-${record.frequencyHz}`} className="candidate-review-card">
          <label className="candidate-select"><input type="checkbox" checked={record.selected} disabled={scanning || capturing} onChange={(e) => setRecord(index, { selected: e.currentTarget.checked })} /><strong>{formatFrequency(record.frequencyHz)}</strong></label>
          <span>{record.bandName} · +{(record.peakDb - record.noiseFloorDb).toFixed(1)} dB · {Math.round(record.bandwidthHz).toLocaleString()} Hz · {record.detector}{record.occupancy === undefined ? "" : ` · ${Math.round(record.occupancy * 100)}% occupancy`}{record.captured ? " · captured" : ""}</span>
          <div className="candidate-annotation-grid"><label>Label<input value={record.annotation.label ?? ""} onChange={(e) => setAnnotation(index, { label: e.currentTarget.value })} placeholder="Unknown signal" /></label><label>Modulation<input value={record.annotation.modulation ?? ""} onChange={(e) => setAnnotation(index, { modulation: e.currentTarget.value })} placeholder="e.g. WBFM, PPM" /></label><label>Encoding<input value={record.annotation.encoding ?? ""} onChange={(e) => setAnnotation(index, { encoding: e.currentTarget.value })} placeholder="e.g. RDS, Mode S" /></label><label>Confidence<select value={record.annotation.confidence} onChange={(e) => setAnnotation(index, { confidence: e.currentTarget.value as SurveyConfidence })}><option value="unknown">Unknown</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
          <button type="button" className="secondary candidate-action" disabled={scanning || capturing} onClick={() => onInvestigate(record.frequencyHz)}>Investigate</button>
        </article>)}</div> : <div className="candidate-empty">Run a survey to populate reviewable candidates.</div>}
      </div>
    </div></div>
  </section>;
}

function planEstimate(lowerHz: number, upperHz: number, sampleRateHz: number, dwellMs: number): number | null {
  try { return planSpectrumScan(lowerHz, upperHz, sampleRateHz).length * (SETTLE_TIME_MS + Math.max(MIN_DWELL_MS, Math.min(MAX_DWELL_MS, dwellMs))) / 1000; }
  catch { return null; }
}
