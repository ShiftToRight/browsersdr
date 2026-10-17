import { MONITOR_PRESETS, type MonitorPreset } from "../radio/monitorDetection";
import type { MonitorTargetMode } from "./CustomMonitorTargets";
import { ExplorerMonitor } from "./ExplorerMonitor";
import {
  snapshotReceiverLocation,
  type ReceiverLocation,
} from "../radio/receiverLocation";
import { ActionButton } from "./ActionButton";
import { RECEIVER_MODES, type ReceiverMode } from "../radio/receiverConfig";
import { MODE_DESCRIPTIONS } from "./modeCatalog";
import { surveyInvestigationMode } from "./surveyInvestigation";
import { sourceModeUnavailableReason } from "../radio/sourcePreferences";
import { sourceCapabilities } from "../radio/sourceCapabilities";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import {
  DEFAULT_SURVEY_PROFILE,
  createSurveySessionId,
  parseSurveyProfile,
  safeSurveySlug,
  createSurveyManifest,
  createSurveyRunSnapshot,
  surveyManifestCsv,
  surveyManifestJson,
  surveyProfileJson,
  validateSurveyProfile,
  type SurveyBand,
  type SurveyCandidateRecord,
  type SurveyConfidence,
  type SurveyDetectorMode,
  type SurveyManifest,
  type SurveyProfile,
  type SurveyRunSnapshot,
  type SurveyRunStatus,
} from "../radio/fieldSurvey";
import {
  analyzeScanWindow,
  canStartSpectrumScan,
  collectSpectrumMeasurement,
  compressSpectrumPoints,
  failedScanWindow,
  mergeSignalCandidates,
  planSpectrumScan,
  type ScanWindowResult,
  type SignalCandidate,
  type SpectrumPoint,
} from "../radio/spectrumScan";
import {
  loadLatestSurveyRun,
  saveLatestSurveyRun,
} from "../radio/surveyStorage";

const SETTLE_TIME_MS = 120;
const MIN_DWELL_MS = 150;
const MAX_DWELL_MS = 10_000;
const PROFILE_STORAGE_KEY = "browsersdr.surveyProfile.v1";
const ENABLED_BANDS_STORAGE_KEY = "browsersdr.surveyEnabledBands.v1";
const MAX_REFINEMENT_REGIONS = 24;
// A bladeRF stream can take longer than the generic measurement watchdog to
// deliver its first block after the USB interface is reset and reconfigured.
// The dwell remains sample-clock bounded once frames begin arriving.
const BLADERF_SCAN_NO_DATA_TIMEOUT_MS = 5_000;

export type ExplorerScanScope = "window" | "band-plan" | "full";

interface ScanJob {
  band: SurveyBand;
  window: ReturnType<typeof planSpectrumScan>[number];
  stage: "primary" | "refinement";
}

interface SurveyResumeState {
  scope: ExplorerScanScope;
  profile: SurveyProfile;
  jobs: ScanJob[];
  cursor: number;
  refinementAdded: boolean;
  windows: ScanWindowResult[];
  bandResults: Map<string, ScanWindowResult[]>;
  records: SurveyCandidateRecord[];
  snapshot: SurveyRunSnapshot;
  sessionId: string;
  startedAt: string;
  originalFrequencyHz: number;
  shouldStopAfterScan: boolean;
  source: NonNullable<ReceiverSnapshot["session"]>["source"];
  sampleRateHz: number;
}

function formatFrequency(frequencyHz: number): string {
  return frequencyHz >= 1_000_000
    ? `${(frequencyHz / 1_000_000).toFixed(6)} MHz`
    : `${(frequencyHz / 1_000).toFixed(3)} kHz`;
}

export function waitForSurveySettle(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Spectrum scan cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function loadProfile(): SurveyProfile {
  try {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
    return stored
      ? parseSurveyProfile(stored)
      : structuredClone(DEFAULT_SURVEY_PROFILE);
  } catch {
    return structuredClone(DEFAULT_SURVEY_PROFILE);
  }
}

function storeProfile(profile: SurveyProfile): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, surveyProfileJson(profile));
  } catch {
    /* Optional local preference. */
  }
}

function loadEnabledBandIds(profile: SurveyProfile): Set<string> {
  try {
    const value = JSON.parse(
      localStorage.getItem(ENABLED_BANDS_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (Array.isArray(value)) {
      const known = new Set(profile.bands.map((band) => band.id));
      const enabled = value.filter(
        (id): id is string => typeof id === "string" && known.has(id),
      );
      if (enabled.length) return new Set(enabled);
    }
  } catch {
    /* Optional local preference. */
  }
  return new Set(profile.bands.map((band) => band.id));
}

function storeEnabledBandIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(ENABLED_BANDS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* Optional local preference. */
  }
}

export function currentWindowSurveyBand(
  session: NonNullable<ReceiverSnapshot["session"]>,
  template: SurveyBand,
  usableFraction = 0.8,
): SurveyBand {
  const halfWidth = (session.actualSampleRateHz * usableFraction) / 2;
  return {
    ...template,
    id: "current-window",
    name: "Current receiver window",
    startFrequencyHz: session.hardwareCenterFrequencyHz - halfWidth,
    endFrequencyHz: session.hardwareCenterFrequencyHz + halfWidth,
  };
}

export function coarseSurveyBands(bands: readonly SurveyBand[]): SurveyBand[] {
  return bands.map((band) => ({
    ...band,
    dwellMs: MIN_DWELL_MS,
    thresholdDb: Math.min(40, band.thresholdDb + 3),
  }));
}

export function refinementSurveyBands(
  bands: readonly SurveyBand[],
  records: readonly SurveyCandidateRecord[],
  sampleRateHz: number,
): SurveyBand[] {
  const byId = new Map(bands.map((band) => [band.id, band]));
  const selected = [...records]
    .sort(
      (left, right) =>
        right.peakDb - right.noiseFloorDb - (left.peakDb - left.noiseFloorDb),
    )
    .slice(0, MAX_REFINEMENT_REGIONS);
  const ranges = selected
    .flatMap((record) => {
      const band = byId.get(record.bandId);
      if (!band) return [];
      const halfWidth = Math.min(
        sampleRateHz * 0.35,
        (band.endFrequencyHz - band.startFrequencyHz) / 2,
      );
      return [
        {
          band,
          lower: Math.max(
            band.startFrequencyHz,
            record.frequencyHz - halfWidth,
          ),
          upper: Math.min(band.endFrequencyHz, record.frequencyHz + halfWidth),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.band.id.localeCompare(right.band.id) || left.lower - right.lower,
    );
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.band.id === range.band.id &&
      range.lower <= previous.upper
    )
      previous.upper = Math.max(previous.upper, range.upper);
    else merged.push({ ...range });
  }
  return merged.map(({ band, lower, upper }) => ({
    ...band,
    startFrequencyHz: lower,
    endFrequencyHz: upper,
  }));
}

function downloadText(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function recordsForCompletedSurveyWindows(
  completedBands: readonly SurveyCandidateRecord[],
  band: SurveyBand,
  results: readonly ScanWindowResult[],
): SurveyCandidateRecord[] {
  const current = mergeSignalCandidates(
    results.flatMap((result) => result.candidates),
  ).map((candidate): SurveyCandidateRecord => ({
    ...candidate,
    detector: candidate.detector ?? band.detector,
    bandId: band.id,
    bandName: band.name,
    selected: false,
    captured: false,
    annotation: { confidence: "unknown" },
  }));
  return [...completedBands, ...current].sort(
    (left, right) => right.peakDb - left.peakDb,
  );
}

export function surveyStatusLabel(
  status: "idle" | "running" | SurveyRunStatus,
  scanning: boolean,
  capturing: boolean,
  paused = false,
): string {
  if (scanning) return "scanning";
  if (capturing) return "capturing";
  if (paused) return "paused";
  return status === "idle" ? "ready" : status;
}

export function applyCapturedFrequencies(
  records: readonly SurveyCandidateRecord[],
  captured: readonly number[],
): SurveyCandidateRecord[] {
  const completed = new Set(captured);
  return records.map((record) =>
    completed.has(record.frequencyHz) ? { ...record, captured: true } : record,
  );
}

function SpectrumOverview({
  points,
  candidates,
  selectedFrequencyHz,
  onSelectCandidate,
}: {
  points: readonly SpectrumPoint[];
  candidates: readonly SignalCandidate[];
  selectedFrequencyHz?: number;
  onSelectCandidate: (frequencyHz: number) => void;
}) {
  const compressed = useMemo(() => compressSpectrumPoints(points), [points]);
  if (compressed.length < 2)
    return (
      <div className="explorer-empty">
        Spectrum results appear here as each tuning window completes.
      </div>
    );
  const lower = compressed[0]!.frequencyHz;
  const upper = compressed.at(-1)!.frequencyHz;
  const floor = Math.min(
    -80,
    Math.floor(Math.min(...compressed.map((point) => point.powerDb)) / 10) * 10,
  );
  const ceiling = Math.max(
    -20,
    Math.ceil(Math.max(...compressed.map((point) => point.powerDb)) / 10) * 10,
  );
  const logarithmic = upper / Math.max(1, lower) >= 2.5;
  const x = (frequencyHz: number) =>
    20 +
    (logarithmic
      ? Math.log(frequencyHz / lower) /
        Math.max(Number.EPSILON, Math.log(upper / lower))
      : (frequencyHz - lower) / Math.max(1, upper - lower)) *
      960;
  const y = (powerDb: number) =>
    240 - ((powerDb - floor) / Math.max(1, ceiling - floor)) * 210;
  const spacings = compressed
    .slice(1)
    .map((point, index) => point.frequencyHz - compressed[index]!.frequencyHz)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const typicalSpacing = spacings[Math.floor(spacings.length / 2)] ?? 1;
  const paths: SpectrumPoint[][] = [];
  for (const point of compressed) {
    const current = paths.at(-1);
    if (
      !current ||
      point.frequencyHz - current.at(-1)!.frequencyHz > typicalSpacing * 12
    )
      paths.push([point]);
    else current.push(point);
  }
  return (
    <div className="explorer-chart-wrap">
      <svg
        className="explorer-chart"
        viewBox="0 0 1000 270"
        role="group"
        aria-label={`Panoramic relative-power spectrum from ${formatFrequency(lower)} to ${formatFrequency(upper)}`}
      >
        <defs>
          <linearGradient id="explorer-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#58ddff" stopOpacity=".4" />
            <stop offset="1" stopColor="#58ddff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((line) => (
          <line
            key={line}
            x1="20"
            x2="980"
            y1={30 + line * 52.5}
            y2={30 + line * 52.5}
            className="explorer-grid-line"
          />
        ))}
        {paths
          .filter((path) => path.length > 1)
          .map((path, index) => {
            const coordinates = path
              .map(
                (point) =>
                  `${x(point.frequencyHz).toFixed(1)},${y(point.powerDb).toFixed(1)}`,
              )
              .join(" ");
            return (
              <g key={`${path[0]!.frequencyHz}-${index}`}>
                <polygon
                  points={`${x(path[0]!.frequencyHz)},240 ${coordinates} ${x(path.at(-1)!.frequencyHz)},240`}
                  fill="url(#explorer-fill)"
                />
                <polyline points={coordinates} className="explorer-trace" />
              </g>
            );
          })}
        {candidates.slice(0, 30).map((candidate) => (
          <g
            key={`${candidate.frequencyHz}-${candidate.peakDb}`}
            className={`candidate-marker ${candidate.frequencyHz === selectedFrequencyHz ? "candidate-marker-selected" : ""}`}
            onClick={() => onSelectCandidate(candidate.frequencyHz)}
            role="button"
            tabIndex={0}
            aria-pressed={candidate.frequencyHz === selectedFrequencyHz}
            aria-label={`Select candidate at ${formatFrequency(candidate.frequencyHz)}`}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectCandidate(candidate.frequencyHz);
              }
            }}
          >
            <line
              x1={x(candidate.frequencyHz)}
              x2={x(candidate.frequencyHz)}
              y1={y(candidate.peakDb)}
              y2="240"
            />
            <circle
              cx={x(candidate.frequencyHz)}
              cy={y(candidate.peakDb)}
              r="5"
            />
          </g>
        ))}
        <text x="20" y="260">
          {formatFrequency(lower)}
        </text>
        <text x="500" y="260" textAnchor="middle">
          {logarithmic ? "log frequency · " : ""}relative dB · uncalibrated
        </text>
        <text x="980" y="260" textAnchor="end">
          {formatFrequency(upper)}
        </text>
      </svg>
    </div>
  );
}

export function SpectrumExplorer({
  pipeline,
  controller,
  receiver,
  initialFrequencyHz: _initialFrequencyHz,
  volume,
  receiverLocation,
  recordingBlocked,
  startReceptionForScan,
  onOpenReceiver,
  onInvestigate,
  investigationBlockedReason,
  onScanningChange,
  onCaptureCandidates,
}: {
  pipeline: AnalysisPipeline;
  controller: ReceiverController;
  receiver: ReceiverSnapshot;
  initialFrequencyHz: number;
  volume: number;
  receiverLocation?: ReceiverLocation;
  recordingBlocked: boolean;
  startReceptionForScan: () => Promise<ReceiverSnapshot>;
  onOpenReceiver?: () => void;
  onInvestigate: (frequencyHz: number, mode: ReceiverMode) => void;
  investigationBlockedReason?: string;
  onScanningChange: (active: boolean) => void;
  onCaptureCandidates: (
    candidates: SurveyCandidateRecord[],
    profile: SurveyProfile,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<{ captured: number[]; cancelled: boolean }>;
}) {
  const [profile, setProfile] = useState<SurveyProfile>(loadProfile);
  const [monitorPreset, setMonitorPreset] = useState<MonitorPreset>("general");
  const [monitorTargetMode, setMonitorTargetMode] =
    useState<MonitorTargetMode>("window");
  const [scope, setScope] = useState<ExplorerScanScope>("window");
  const [activity, setActivity] = useState<"survey" | "monitor">("survey");
  const [enabledBandIds, setEnabledBandIds] = useState(() =>
    loadEnabledBandIds(profile),
  );
  const [selectedBandId, setSelectedBandId] = useState(profile.bands[0]!.id);
  const selectedBand =
    profile.bands.find((band) => band.id === selectedBandId) ??
    profile.bands[0]!;
  const [bandName, setBandName] = useState(selectedBand.name);
  const [startMhz, setStartMhz] = useState(
    selectedBand.startFrequencyHz / 1_000_000,
  );
  const [endMhz, setEndMhz] = useState(selectedBand.endFrequencyHz / 1_000_000);
  const [dwellMs, setDwellMs] = useState(selectedBand.dwellMs);
  const [thresholdDb, setThresholdDb] = useState(selectedBand.thresholdDb);
  const [detector, setDetector] = useState<SurveyDetectorMode>(
    selectedBand.detector,
  );
  const [scanning, setScanning] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [windows, setWindows] = useState<ScanWindowResult[]>([]);
  const [records, setRecords] = useState<SurveyCandidateRecord[]>([]);
  const [message, setMessage] = useState(
    "Choose the current window, selected band-plan regions, or a full coarse-to-fine survey.",
  );
  const [sessionId, setSessionId] = useState(() => createSurveySessionId());
  const [runSnapshot, setRunSnapshot] = useState<SurveyRunSnapshot>();
  const [runManifest, setRunManifest] = useState<SurveyManifest>();
  const [runStatus, setRunStatus] = useState<
    "idle" | "running" | SurveyRunStatus
  >("idle");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const captureAbortRef = useRef<AbortController | undefined>(undefined);
  const resumeRef = useRef<SurveyResumeState | undefined>(undefined);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageMessage, setStorageMessage] = useState(
    "Checking saved survey…",
  );
  const [highlightedRecordKey, setHighlightedRecordKey] = useState<string>();
  const [investigationModes, setInvestigationModes] = useState<
    Record<string, ReceiverMode>
  >({});
  const investigationMode = (record: SurveyCandidateRecord) =>
    investigationModes[recordKey(record)] ??
    surveyInvestigationMode(record, runSnapshot?.profile);
  const investigationIssue = (record: SurveyCandidateRecord) =>
    investigationBlockedReason ??
    (receiver.session
      ? sourceModeUnavailableReason(
          receiver.session.source,
          investigationMode(record),
          receiver.session.actualSampleRateHz,
          receiver.lifecycle === "running",
        )
      : undefined);
  const recordElements = useRef(new Map<string, HTMLElement>());
  const profileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void loadLatestSurveyRun()
      .then((saved) => {
        if (!active) return;
        setStorageMessage(
          saved ? "Saved on this device." : "No saved survey yet.",
        );
        if (!saved) return;
        const restoredStatus =
          saved.status === "running" ? "cancelled" : saved.status;
        setScope(saved.scope);
        setProfile(saved.snapshot.profile);
        setEnabledBandIds(
          new Set(saved.snapshot.profile.bands.map((band) => band.id)),
        );
        loadBand(saved.snapshot.profile.bands[0]!);
        setWindows(saved.windows);
        setRecords(saved.records);
        setProgress(saved.progress);
        setSessionId(saved.snapshot.sessionId);
        setRunSnapshot(saved.snapshot);
        setRunManifest(saved.manifest);
        setRunStatus(restoredStatus);
        setMessage(
          saved.status === "running"
            ? "Recovered partial results from an interrupted survey. Start a new scan to continue acquiring data."
            : `Restored ${saved.records.length} candidate${saved.records.length === 1 ? "" : "s"} from the last survey.`,
        );
      })
      .catch((error: unknown) => {
        if (active)
          setStorageMessage(
            `Not saved: ${error instanceof Error ? error.message : "Storage unavailable."} Export results to keep a copy.`,
          );
      })
      .finally(() => {
        if (active) setStorageReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !runSnapshot || runStatus === "idle") return;
    let active = true;
    setStorageMessage("Saving survey…");
    void saveLatestSurveyRun({
      scope,
      status: runStatus,
      snapshot: runSnapshot,
      ...(runManifest ? { manifest: runManifest } : {}),
      windows,
      records,
      progress,
    })
      .then(() => {
        if (active) setStorageMessage("Saved on this device.");
      })
      .catch((error: unknown) => {
        if (active)
          setStorageMessage(
            `Not saved: ${error instanceof Error ? error.message : "Storage unavailable."} Export results to keep a copy.`,
          );
      });
    return () => {
      active = false;
    };
  }, [
    storageReady,
    scope,
    runStatus,
    runSnapshot,
    runManifest,
    windows,
    records,
    progress,
  ]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      captureAbortRef.current?.abort();
    },
    [],
  );
  const points = useMemo(
    () =>
      windows
        .flatMap((window) => window.points)
        .sort((a, b) => a.frequencyHz - b.frequencyHz),
    [windows],
  );
  const displayCandidates = useMemo(
    () => mergeSignalCandidates(windows.flatMap((window) => window.candidates)),
    [windows],
  );
  const canScan = canStartSpectrumScan(
    receiver.lifecycle,
    receiver.session?.source,
    recordingBlocked || capturing,
  );
  const enabledBands = profile.bands.filter((band) =>
    enabledBandIds.has(band.id),
  );
  const activeWindowBand = receiver.session
    ? currentWindowSurveyBand(
        receiver.session,
        {
          ...selectedBand,
          name: bandName || "Custom band",
          startFrequencyHz: startMhz * 1_000_000,
          endFrequencyHz: endMhz * 1_000_000,
          dwellMs,
          thresholdDb,
          detector,
        },
        activity === "monitor" ? 0.75 : 0.8,
      )
    : undefined;
  const estimatedSeconds = receiver.session
    ? estimateScopeSeconds(
        scope,
        scope === "window" ? [activeWindowBand!] : enabledBands,
        receiver.session.actualSampleRateHz,
        receiver.session.source,
      )
    : null;

  const updateProfile = (next: SurveyProfile) => {
    const valid = validateSurveyProfile(next);
    setProfile(valid);
    storeProfile(valid);
  };
  const loadBand = (band: SurveyBand) => {
    setSelectedBandId(band.id);
    setBandName(band.name);
    setStartMhz(band.startFrequencyHz / 1_000_000);
    setEndMhz(band.endFrequencyHz / 1_000_000);
    setDwellMs(band.dwellMs);
    setThresholdDb(band.thresholdDb);
    setDetector(band.detector);
  };
  const chooseBand = (id: string) => {
    const band = profile.bands.find((entry) => entry.id === id);
    if (band) loadBand(band);
  };
  const currentBand = (): SurveyBand => ({
    ...selectedBand,
    name: bandName || "Custom band",
    startFrequencyHz: startMhz * 1_000_000,
    endFrequencyHz: endMhz * 1_000_000,
    dwellMs,
    thresholdDb,
    detector,
  });

  const setBandEnabled = (id: string, enabled: boolean) => {
    const next = new Set(enabledBandIds);
    if (enabled) next.add(id);
    else next.delete(id);
    setEnabledBandIds(next);
    storeEnabledBandIds(next);
  };
  const saveBand = () => {
    try {
      const next = {
        ...profile,
        bands: profile.bands.map((band) =>
          band.id === selectedBand.id ? currentBand() : band,
        ),
      };
      updateProfile(next);
      setMessage(`Saved band “${bandName}” in the survey profile.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save the band.",
      );
    }
  };
  const addBand = () => {
    try {
      const id = `custom-${Date.now()}`;
      const nextBand = { ...currentBand(), id, name: "Custom band" };
      const next = validateSurveyProfile({
        ...profile,
        bands: [...profile.bands, nextBand],
      });
      updateProfile(next);
      const enabled = new Set(enabledBandIds).add(id);
      setEnabledBandIds(enabled);
      storeEnabledBandIds(enabled);
      loadBand(nextBand);
      setMessage(
        "Added a custom survey band. Edit and save its range and detector.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not add the band.",
      );
    }
  };
  const removeBand = () => {
    if (profile.bands.length <= 1) {
      setMessage("A survey profile must retain at least one band.");
      return;
    }
    const bands = profile.bands.filter((band) => band.id !== selectedBand.id);
    updateProfile({ ...profile, bands });
    const enabled = new Set(enabledBandIds);
    enabled.delete(selectedBand.id);
    setEnabledBandIds(enabled);
    storeEnabledBandIds(enabled);
    loadBand(bands[0]!);
    setMessage(`Removed band “${selectedBand.name}”.`);
  };

  const runSurvey = async (
    requestedScope: ExplorerScanScope,
    bands: SurveyBand[],
    resume = false,
  ) => {
    const initialSession = receiver.session;
    if (!initialSession || !canScan || scanning) return;
    let state: SurveyResumeState;
    try {
      if (initialSession.mode === "ADS-B")
        throw new Error(
          "ADS-B requires a fixed 1090 MHz center. Select another mode before scanning bands.",
        );
      if (resume) {
        const saved = resumeRef.current;
        if (!saved) throw new Error("There is no paused survey to resume.");
        if (
          saved.source !== initialSession.source ||
          saved.sampleRateHz !== initialSession.actualSampleRateHz
        )
          throw new Error(
            "Reconnect the same source and sample rate before resuming this survey.",
          );
        state = saved;
      } else {
        if (!bands.length) throw new Error("Enable at least one survey band.");
        const effectiveProfile = validateSurveyProfile({
          ...profile,
          site: { ...profile.site },
          bands: bands.map((band) => ({ ...band })),
        });
        const primaryBands =
          requestedScope === "full"
            ? coarseSurveyBands(effectiveProfile.bands)
            : effectiveProfile.bands;
        const jobs = primaryBands.flatMap((band) =>
          planSpectrumScan(
            band.startFrequencyHz,
            band.endFrequencyHz,
            initialSession.actualSampleRateHz,
            initialSession.source,
          ).map((window): ScanJob => ({ band, window, stage: "primary" })),
        );
        const nextSessionId = createSurveySessionId();
        const startedAt = new Date().toISOString();
        state = {
          scope: requestedScope,
          profile: effectiveProfile,
          jobs,
          cursor: 0,
          refinementAdded: requestedScope !== "full",
          windows: [],
          bandResults: new Map(),
          records: [],
          snapshot: createSurveyRunSnapshot(
            effectiveProfile,
            effectiveProfile.bands,
            initialSession,
            startedAt,
            nextSessionId,
          ),
          sessionId: nextSessionId,
          startedAt,
          originalFrequencyHz: initialSession.selectedChannelFrequencyHz,
          shouldStopAfterScan: receiver.lifecycle === "connected",
          source: initialSession.source,
          sampleRateHz: initialSession.actualSampleRateHz,
        };
        resumeRef.current = state;
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not plan the survey.",
      );
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    let snapshot = state.snapshot;
    let finalStatus: SurveyRunStatus = "failed";
    setScanning(true);
    onScanningChange(true);
    setWindows([...state.windows]);
    setRecords([...state.records]);
    setProgress({ completed: state.cursor, total: state.jobs.length });
    setSessionId(state.sessionId);
    setRunSnapshot(snapshot);
    setRunManifest(undefined);
    setRunStatus("running");
    setResumeAvailable(false);
    try {
      let active = controller.getSnapshot();
      if (active.lifecycle === "connected")
        active = await startReceptionForScan();
      if (abort.signal.aborted)
        throw new DOMException("Spectrum scan cancelled", "AbortError");
      if (active.lifecycle !== "running" || !active.session)
        throw new Error(
          active.message || "Reception could not be started for the survey.",
        );
      if (!resume) {
        snapshot = createSurveyRunSnapshot(
          state.profile,
          state.profile.bands,
          active.session,
          state.startedAt,
          state.sessionId,
        );
        state.snapshot = snapshot;
        state.originalFrequencyHz = active.session.selectedChannelFrequencyHz;
      }
      setRunSnapshot(snapshot);
      controller.setVolume(0);
      while (true) {
        while (state.cursor < state.jobs.length) {
          const job = state.jobs[state.cursor]!;
          setMessage(
            `${job.stage === "refinement" ? "Refining" : "Scanning"} ${job.band.name} with the ${job.band.detector} detector…`,
          );
          if (abort.signal.aborted)
            throw new DOMException("Spectrum scan cancelled", "AbortError");
          let result: ScanWindowResult;
          try {
            const tuned = await controller.scanTune(
              job.window.centerFrequencyHz,
            );
            if (!tuned)
              throw new Error("The receiver could not tune this scan window.");
            if (abort.signal.aborted)
              throw new DOMException("Spectrum scan cancelled", "AbortError");
            await waitForSurveySettle(SETTLE_TIME_MS, abort.signal);
            const measurement = await collectSpectrumMeasurement(pipeline, {
              generation: tuned.sessionGeneration,
              centerFrequencyHz: tuned.hardwareCenterFrequencyHz,
              sampleRateHz: tuned.actualSampleRateHz,
              dwellMs: job.band.dwellMs,
              signal: abort.signal,
              ...(tuned.source === "bladerf"
                ? { noDataTimeoutMs: BLADERF_SCAN_NO_DATA_TIMEOUT_MS }
                : {}),
            });
            result = analyzeScanWindow(
              job.window,
              measurement.frames,
              job.band.thresholdDb,
              job.band.detector,
              measurement,
            );
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError")
              throw error;
            result = failedScanWindow(job.window, error);
          }
          state.windows.push(result);
          const bandResults = state.bandResults.get(job.band.id) ?? [];
          bandResults.push(result);
          state.bandResults.set(job.band.id, bandResults);
          let rebuilt: SurveyCandidateRecord[] = [];
          for (const [bandId, results] of state.bandResults) {
            const band = state.jobs.find(
              (item) => item.band.id === bandId,
            )!.band;
            rebuilt = recordsForCompletedSurveyWindows(rebuilt, band, results);
          }
          state.records = rebuilt;
          state.cursor += 1;
          resumeRef.current = state;
          setWindows([...state.windows]);
          setRecords([...state.records]);
          setProgress({ completed: state.cursor, total: state.jobs.length });
        }
        if (state.scope !== "full" || state.refinementAdded) break;
        state.refinementAdded = true;
        const detailBands = refinementSurveyBands(
          state.profile.bands,
          state.records,
          state.sampleRateHz,
        );
        const detailJobs = detailBands.flatMap((band) =>
          planSpectrumScan(
            band.startFrequencyHz,
            band.endFrequencyHz,
            state.sampleRateHz,
            state.source,
          ).map((window): ScanJob => ({ band, window, stage: "refinement" })),
        );
        state.jobs.push(...detailJobs);
        resumeRef.current = state;
        setProgress({ completed: state.cursor, total: state.jobs.length });
        if (!detailJobs.length) break;
        setMessage(
          `Coarse pass complete. Refining ${detailBands.length} active region${detailBands.length === 1 ? "" : "s"}…`,
        );
      }
      const failedCount = state.windows.filter(
        (window) => window.status === "failed",
      ).length;
      const insufficientCount = state.windows.filter(
        (window) => window.status === "insufficient",
      ).length;
      const successfulCount =
        state.windows.length - failedCount - insufficientCount;
      finalStatus =
        failedCount > 0 && successfulCount === 0
          ? "failed"
          : failedCount > 0 || insufficientCount > 0
            ? "insufficient"
            : "completed";
      resumeRef.current = undefined;
      setResumeAvailable(false);
      setMessage(
        failedCount > 0 || insufficientCount > 0
          ? `Survey finished and retained all usable results. ${failedCount} window(s) failed and ${insufficientCount} had insufficient sample coverage; later windows continued normally.`
          : `${state.scope === "full" ? "Full coarse-to-fine survey" : "Survey"} complete: ${state.records.length} candidates across ${state.profile.bands.length} band${state.profile.bands.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      finalStatus =
        error instanceof DOMException && error.name === "AbortError"
          ? "cancelled"
          : "failed";
      if (finalStatus === "cancelled") {
        resumeRef.current = state;
        setResumeAvailable(
          state.cursor < state.jobs.length || !state.refinementAdded,
        );
      } else resumeRef.current = undefined;
      setMessage(
        finalStatus === "cancelled"
          ? "Survey paused; completed windows are retained and the remaining plan can be resumed."
          : error instanceof Error
            ? error.message
            : "The survey failed.",
      );
    } finally {
      let cleanupError: unknown;
      try {
        if (["running", "tuning"].includes(controller.getSnapshot().lifecycle))
          await controller.tune(state.originalFrequencyHz);
      } catch (error) {
        cleanupError = error;
      }
      try {
        controller.setVolume(volume);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (
          state.shouldStopAfterScan &&
          ["running", "tuning"].includes(controller.getSnapshot().lifecycle)
        )
          await controller.stop();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        finalStatus = "failed";
        resumeRef.current = undefined;
        setResumeAvailable(false);
        setMessage(
          cleanupError instanceof Error
            ? `Survey cleanup failed: ${cleanupError.message}`
            : "Survey cleanup failed.",
        );
      }
      const completedAt = new Date().toISOString();
      setRunManifest(
        createSurveyManifest(snapshot, finalStatus, state.records, completedAt),
      );
      setRunStatus(finalStatus);
      abortRef.current = undefined;
      setScanning(false);
      onScanningChange(false);
    }
  };

  const updateRecords = (
    update: (records: SurveyCandidateRecord[]) => SurveyCandidateRecord[],
  ) =>
    setRecords((current) => {
      const next = update(current);
      if (resumeRef.current) resumeRef.current.records = next;
      return next;
    });
  const setRecord = (index: number, patch: Partial<SurveyCandidateRecord>) =>
    updateRecords((current) =>
      current.map((record, cursor) =>
        cursor === index ? { ...record, ...patch } : record,
      ),
    );
  const setAnnotation = (
    index: number,
    patch: Partial<SurveyCandidateRecord["annotation"]>,
  ) =>
    updateRecords((current) =>
      current.map((record, cursor) =>
        cursor === index
          ? { ...record, annotation: { ...record.annotation, ...patch } }
          : record,
      ),
    );
  const captureSelected = async () => {
    const selected = records.filter((record) => record.selected);
    if (!selected.length) {
      setMessage("Select at least one candidate to capture.");
      return;
    }
    if (!runSnapshot) {
      setMessage("Run a survey before capturing candidates.");
      return;
    }
    const abort = new AbortController();
    captureAbortRef.current = abort;
    setCapturing(true);
    onScanningChange(true);
    try {
      const result = await onCaptureCandidates(
        selected,
        runSnapshot.profile,
        sessionId,
        abort.signal,
      );
      setRecords((current) =>
        applyCapturedFrequencies(current, result.captured),
      );
      setMessage(
        result.cancelled
          ? `Candidate capture cancelled; ${result.captured.length} completed acquisition${result.captured.length === 1 ? " is" : "s are"} retained in progress.`
          : `Completed ${result.captured.length} selected candidate acquisition${result.captured.length === 1 ? "" : "s"}; SigMF archive downloads were requested, not confirmed stored.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Candidate capture failed.",
      );
    } finally {
      captureAbortRef.current = undefined;
      setCapturing(false);
      onScanningChange(false);
    }
  };
  const manifest = (): SurveyManifest | undefined =>
    runSnapshot && runManifest
      ? createSurveyManifest(
          runSnapshot,
          runManifest.status,
          records,
          runManifest.completedAt,
        )
      : undefined;
  const recordKey = (record: SurveyCandidateRecord) =>
    `${record.bandId}-${record.frequencyHz}`;
  const selectChartCandidate = (frequencyHz: number) => {
    const record = records.reduce<SurveyCandidateRecord | undefined>(
      (closest, candidate) =>
        !closest ||
        Math.abs(candidate.frequencyHz - frequencyHz) <
          Math.abs(closest.frequencyHz - frequencyHz)
          ? candidate
          : closest,
      undefined,
    );
    if (!record) return;
    const key = recordKey(record);
    setHighlightedRecordKey(key);
    recordElements.current.get(key)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };
  const importProfile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = parseSurveyProfile(await file.text());
      updateProfile(next);
      loadBand(next.bands[0]!);
      const enabled = new Set(next.bands.map((band) => band.id));
      setEnabledBandIds(enabled);
      storeEnabledBandIds(enabled);
      setMessage(`Imported survey profile “${next.name}”.`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not import the profile.",
      );
    }
  };

  const advancedControls = (
    <>
      {" "}
      <details
        className="explorer-settings"
        hidden={activity === "monitor" && monitorTargetMode !== "band-plan"}
      >
        <summary>Edit profile bands</summary>
        <label>
          Profile band
          <select
            value={selectedBandId}
            disabled={scanning || capturing}
            onChange={(e) => chooseBand(e.currentTarget.value)}
          >
            {profile.bands.map((band) => (
              <option key={band.id} value={band.id}>
                {band.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Band name
          <input
            value={bandName}
            disabled={scanning || capturing}
            onChange={(e) => setBandName(e.currentTarget.value)}
          />
        </label>
        <div className="explorer-range-grid">
          <label>
            Start frequency
            <span className="unit-input">
              <input
                type="number"
                min="0.000001"
                step="0.001"
                value={startMhz}
                disabled={scanning || capturing}
                onChange={(e) => setStartMhz(e.currentTarget.valueAsNumber)}
              />
              <span>MHz</span>
            </span>
          </label>
          <label>
            End frequency
            <span className="unit-input">
              <input
                type="number"
                min="0.000001"
                step="0.001"
                value={endMhz}
                disabled={scanning || capturing}
                onChange={(e) => setEndMhz(e.currentTarget.valueAsNumber)}
              />
              <span>MHz</span>
            </span>
          </label>
        </div>
        <div className="band-editor-actions">
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing}
            onClick={saveBand}
          >
            Save band
          </button>
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing || profile.bands.length >= 64}
            onClick={addBand}
          >
            Add custom
          </button>
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing || profile.bands.length <= 1}
            onClick={removeBand}
          >
            Remove
          </button>
        </div>
        <p className="display-note">
          Save band to apply edits to band-plan and full-survey scans.
        </p>
      </details>
      <details
        className="survey-profile-panel"
        aria-label="Survey profile and site"
      >
        <summary>Site &amp; profile</summary>
        <div className="survey-profile-grid">
          <label>
            Profile name
            <input
              value={profile.name}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  name: e.currentTarget.value || "Unnamed survey",
                })
              }
            />
          </label>
          <label>
            Site label
            <input
              value={profile.site.label}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  site: {
                    ...profile.site,
                    label: e.currentTarget.value || "Unnamed site",
                  },
                })
              }
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing || !receiverLocation}
            onClick={() => {
              if (!receiverLocation) return;
              const location = snapshotReceiverLocation(receiverLocation)!;
              updateProfile({
                ...profile,
                site: {
                  ...profile.site,
                  label: location.label || profile.site.label,
                  latitude: location.latitude,
                  longitude: location.longitude,
                  location,
                },
              });
            }}
          >
            Use receiver site
          </button>
          <small>
            Copy the chosen antenna site explicitly. Profile and result exports
            include these coordinates.
          </small>
          {profile.site.location && (
            <small>
              Site source: {profile.site.location.source} · fix/entry time{" "}
              {profile.site.location.observedAt ?? "unknown"} · accuracy{" "}
              {profile.site.location.accuracyMeters === undefined
                ? "unknown"
                : `${profile.site.location.accuracyMeters} m`}
            </small>
          )}
          <label>
            Latitude (optional)
            <input
              type="number"
              min="-90"
              max="90"
              step="0.000001"
              value={profile.site.latitude ?? ""}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  site: {
                    ...profile.site,
                    location: undefined,
                    latitude:
                      e.currentTarget.value === ""
                        ? undefined
                        : e.currentTarget.valueAsNumber,
                  },
                })
              }
            />
          </label>
          <label>
            Longitude (optional)
            <input
              type="number"
              min="-180"
              max="180"
              step="0.000001"
              value={profile.site.longitude ?? ""}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  site: {
                    ...profile.site,
                    location: undefined,
                    longitude:
                      e.currentTarget.value === ""
                        ? undefined
                        : e.currentTarget.valueAsNumber,
                  },
                })
              }
            />
          </label>
          <label>
            Antenna
            <input
              value={profile.site.antenna ?? ""}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  site: { ...profile.site, antenna: e.currentTarget.value },
                })
              }
            />
          </label>
          <label>
            Site notes
            <input
              value={profile.site.notes ?? ""}
              disabled={scanning || capturing}
              onChange={(e) =>
                updateProfile({
                  ...profile,
                  site: { ...profile.site, notes: e.currentTarget.value },
                })
              }
            />
          </label>
        </div>
        <div className="survey-actions">
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing}
            onClick={() =>
              downloadText(
                `${safeSurveySlug(profile.name)}.browsersdr-survey.json`,
                surveyProfileJson(profile),
                "application/json",
              )
            }
          >
            Export profile
          </button>
          <button
            type="button"
            className="secondary"
            disabled={scanning || capturing}
            onClick={() => profileInputRef.current?.click()}
          >
            Import profile
          </button>
          <input
            ref={profileInputRef}
            hidden
            type="file"
            accept=".json,application/json"
            onChange={(e) => void importProfile(e.currentTarget.files?.[0])}
          />
        </div>
        <p className="display-note">
          Coordinates are optional and are written to SigMF only when both are
          supplied. Profiles and the latest survey results remain in this
          browser until its site data is cleared.
        </p>
      </details>
    </>
  );
  const monitorTargetControls = (
    <>
      <label>
        Monitor targets
        <select
          aria-label="Monitor targets"
          value={monitorTargetMode}
          disabled={scanning || capturing}
          onChange={(e) => {
            const mode = e.currentTarget.value as MonitorTargetMode;
            setMonitorTargetMode(mode);
            if (mode === "window" || mode === "band-plan") setScope(mode);
          }}
        >
          <option value="window">Current window</option>
          <option value="range">Custom range</option>
          <option value="frequencies">Custom frequencies</option>
          <option value="band-plan">Band plan</option>
        </select>
      </label>
      {monitorTargetMode === "window" && (
        <div className="scan-range-summary">
          <span>Usable receiver window</span>
          <strong>
            {activeWindowBand
              ? `${formatFrequency(activeWindowBand.startFrequencyHz)}–${formatFrequency(activeWindowBand.endFrequencyHz)}`
              : "Connect a receiver first"}
          </strong>
        </div>
      )}
      {monitorTargetMode === "band-plan" && (
        <fieldset className="survey-band-picker">
          <legend>Included frequency regions</legend>
          {profile.bands.map((band) => (
            <label key={band.id}>
              <input
                type="checkbox"
                checked={enabledBandIds.has(band.id)}
                disabled={scanning || capturing}
                onChange={(e) =>
                  setBandEnabled(band.id, e.currentTarget.checked)
                }
              />
              <span>{band.name}</span>
              <small>
                {formatFrequency(band.startFrequencyHz)}–
                {formatFrequency(band.endFrequencyHz)}
              </small>
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
  const monitorDetectionControls = (
    <>
      <label>
        Detection preset
        <select
          aria-label="Detection preset"
          value={monitorPreset}
          disabled={scanning || capturing}
          onChange={(e) => {
            const key = e.currentTarget.value as MonitorPreset;
            const next = MONITOR_PRESETS[key];
            setMonitorPreset(key);
            setDwellMs(next.dwellMs);
            setThresholdDb(next.thresholdDb);
            setDetector(next.detector);
          }}
        >
          <optgroup label="Across the spectrum">
            {(["general", "narrow", "wide", "bursts"] as const).map((key) => (
              <option key={key} value={key}>
                {MONITOR_PRESETS[key].label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Broadcast FM · optional">
            {(["fm-balanced", "fm-weak", "fm-strong"] as const).map((key) => (
              <option key={key} value={key}>
                {MONITOR_PRESETS[key].label}
              </option>
            ))}
          </optgroup>
        </select>
        <small>{MONITOR_PRESETS[monitorPreset].description}</small>
      </label>
      <div className="monitor-number-fields">
        <label>
          Dwell per window (ms)
          <input
            aria-label="Dwell milliseconds"
            type="number"
            min={MIN_DWELL_MS}
            max={MAX_DWELL_MS}
            step="50"
            value={Number.isFinite(dwellMs) ? dwellMs : ""}
            disabled={scanning || capturing}
            onChange={(e) => setDwellMs(e.currentTarget.valueAsNumber)}
          />
        </label>
        <label>
          Threshold (dB)
          <input
            aria-label="Threshold decibels"
            type="number"
            min="1"
            max="40"
            value={Number.isFinite(thresholdDb) ? thresholdDb : ""}
            disabled={scanning || capturing}
            onChange={(e) => setThresholdDb(e.currentTarget.valueAsNumber)}
          />
        </label>
      </div>
      <small>
        Threshold is above the estimated noise floor. Longer dwell measures each
        window for longer, but slows revisits.
      </small>
      <details className="explorer-settings">
        <summary>Detector settings</summary>
        <label>
          Detector
          <select
            value={detector}
            disabled={scanning || capturing}
            onChange={(e) =>
              setDetector(e.currentTarget.value as SurveyDetectorMode)
            }
          >
            <option value="average">Average power</option>
            <option value="max-hold">Max hold / bursts</option>
            <option value="occupancy">Occupancy</option>
            <option value="wideband">Wideband plateau</option>
          </select>
        </label>
        <label>
          Dwell per window <output>{dwellMs} ms</output>
          <input
            type="range"
            aria-label="Dwell per window"
            min={MIN_DWELL_MS}
            max={MAX_DWELL_MS}
            step="50"
            value={Number.isFinite(dwellMs) ? dwellMs : MIN_DWELL_MS}
            disabled={scanning || capturing}
            onChange={(e) => setDwellMs(e.currentTarget.valueAsNumber)}
          />
        </label>
        <label>
          Detection threshold <output>{thresholdDb} dB</output>
          <input
            type="range"
            aria-label="Detection threshold"
            min="1"
            max="40"
            value={Number.isFinite(thresholdDb) ? thresholdDb : 1}
            disabled={scanning || capturing}
            onChange={(e) => setThresholdDb(e.currentTarget.valueAsNumber)}
          />
        </label>
      </details>
      <details className="monitor-advanced">
        <summary>Site &amp; profile settings</summary>
        {activity === "monitor" && advancedControls}
      </details>
    </>
  );
  return (
    <section
      data-activity={activity}
      className="explorer-workspace"
      aria-labelledby="explorer-heading"
    >
      <div className="panel-heading explorer-heading">
        <div>
          <p className="eyebrow">Spectrum discovery</p>
          <h2 id="explorer-heading">Spectrum Explorer</h2>
        </div>
        <span
          className={`status-pill ${scanning || capturing ? "status-tuning" : runStatus === "completed" ? "status-running" : "status-idle"}`}
        >
          {runStatus === "idle" && !canScan
            ? receiver.session
              ? "Scan unavailable"
              : "Connect receiver"
            : activity === "monitor" && scanning
              ? "monitoring"
              : surveyStatusLabel(
                  runStatus,
                  scanning,
                  capturing,
                  resumeAvailable,
                )}
        </span>
      </div>
      <div className="explorer-layout">
        {activity === "survey" && (
          <aside
            className="explorer-controls"
            hidden={activity !== "survey"}
            aria-label="Spectrum scan controls"
          >
            <div className="explorer-source">
              <span>Source</span>
              <strong>
                {receiver.session
                  ? sourceCapabilities(receiver.session.source).label
                  : "No receiver connected"}
              </strong>
              <small>
                {receiver.lifecycle === "running"
                  ? "● Receiving"
                  : receiver.lifecycle === "connected"
                    ? "✓ Connected · scan will start reception"
                    : scanning
                      ? "● Sweeping · receiver is tuning"
                      : "Connect a receiver in Acquire to scan."}
              </small>
              {!receiver.session && onOpenReceiver && (
                <button type="button" onClick={onOpenReceiver}>
                  Go to Acquire
                </button>
              )}
            </div>
            <label>
              Activity
              <select
                aria-label="Explorer activity"
                value={activity}
                disabled={scanning || capturing}
                onChange={(event) => {
                  const next = event.target.value as "survey" | "monitor";
                  setActivity(next);
                  if (next === "monitor" && scope === "full")
                    setScope("band-plan");
                }}
              >
                <option value="survey">Survey once</option>
                <option value="monitor">Monitor continuously</option>
              </select>
            </label>
            <label>
              Scan scope
              <select
                aria-label="Scan scope"
                value={scope}
                disabled={scanning || capturing}
                onChange={(e) =>
                  setScope(e.currentTarget.value as ExplorerScanScope)
                }
              >
                <option value="window">Current window</option>
                <option value="band-plan">Band plan</option>
                <option value="full">Full survey · coarse + detail</option>
              </select>
            </label>
            {(activity === "survey"
              ? scope === "window"
              : monitorTargetMode === "window") && (
              <div className="scan-range-summary">
                <span>Frequency range</span>
                <strong>
                  {receiver.session
                    ? (() => {
                        const band = activeWindowBand!;
                        return `${formatFrequency(band.startFrequencyHz)}–${formatFrequency(band.endFrequencyHz)}`;
                      })()
                    : "Current receiver window"}
                </strong>
              </div>
            )}
            {(activity === "survey"
              ? scope !== "window"
              : monitorTargetMode === "band-plan") && (
              <fieldset className="survey-band-picker">
                <legend>Included frequency regions</legend>
                {profile.bands.map((band) => (
                  <label key={band.id}>
                    <input
                      type="checkbox"
                      checked={enabledBandIds.has(band.id)}
                      disabled={scanning || capturing}
                      onChange={(e) =>
                        setBandEnabled(band.id, e.currentTarget.checked)
                      }
                    />
                    <span>{band.name}</span>
                    <small>
                      {formatFrequency(band.startFrequencyHz)}–
                      {formatFrequency(band.endFrequencyHz)}
                    </small>
                  </label>
                ))}
              </fieldset>
            )}
            {(activity === "survey" ||
              ["window", "band-plan"].includes(monitorTargetMode)) && (
              <p className="scan-estimate">
                Estimated time:{" "}
                {estimatedSeconds === null
                  ? "connect a receiver first"
                  : `about ${estimatedSeconds.toFixed(1)} s`}
              </p>
            )}
            {activity === "survey" && (
              <div className="explorer-actions">
                <ActionButton
                  type="button"
                  disabledReason={
                    !receiver.session
                      ? "Connect a receiver in Acquire first."
                      : scanning || capturing
                        ? "Wait for the current scan or capture to finish."
                        : recordingBlocked
                          ? "Stop recording or finish preparing the capture first."
                          : !canScan
                            ? "This receiver is unavailable for scanning. Check its connection and source."
                            : "Include at least one frequency region."
                  }
                  disabled={
                    !canScan ||
                    scanning ||
                    capturing ||
                    (scope !== "window" && !enabledBands.length)
                  }
                  onClick={() => {
                    if (!receiver.session) return;
                    const bands =
                      scope === "window"
                        ? [
                            currentWindowSurveyBand(
                              receiver.session,
                              currentBand(),
                            ),
                          ]
                        : enabledBands;
                    void runSurvey(scope, bands);
                  }}
                >
                  {scope === "window"
                    ? "Scan current window"
                    : scope === "full"
                      ? "Run full survey"
                      : "Run band plan"}
                </ActionButton>
                <ActionButton
                  type="button"
                  disabledReason={
                    scanning || capturing
                      ? "Wait for the current scan or capture to finish."
                      : "Pause a scan before resuming it."
                  }
                  className="secondary"
                  disabled={!resumeAvailable || scanning || capturing}
                  onClick={() =>
                    void runSurvey(
                      resumeRef.current?.scope ?? scope,
                      resumeRef.current?.profile.bands ?? [],
                      true,
                    )
                  }
                >
                  Resume
                </ActionButton>

                {(scanning || capturing) && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={!scanning && !capturing}
                      onClick={() => {
                        abortRef.current?.abort();
                        captureAbortRef.current?.abort();
                      }}
                    >
                      {scanning ? "Pause scan" : "Cancel capture"}
                    </button>{" "}
                  </>
                )}
              </div>
            )}
            {activity === "survey" && progress.total > 0 && (
              <progress
                value={progress.completed}
                max={progress.total}
                aria-label="Spectrum scan progress"
              />
            )}
            <details className="explorer-settings">
              <summary>Detector settings</summary>
              <label>
                Detector
                <select
                  value={detector}
                  disabled={scanning || capturing}
                  onChange={(e) =>
                    setDetector(e.currentTarget.value as SurveyDetectorMode)
                  }
                >
                  <option value="average">Average power</option>
                  <option value="max-hold">Max hold / bursts</option>
                  <option value="occupancy">Occupancy</option>
                  <option value="wideband">Wideband plateau</option>
                </select>
              </label>
              <label>
                Dwell per window <output>{dwellMs} ms</output>
                <input
                  type="range"
                  aria-label="Dwell per window"
                  aria-valuetext={`${dwellMs} milliseconds`}
                  min={MIN_DWELL_MS}
                  max={MAX_DWELL_MS}
                  step="50"
                  value={dwellMs}
                  disabled={scanning || capturing}
                  onChange={(e) => setDwellMs(e.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                Detection threshold <output>{thresholdDb} dB</output>
                <input
                  type="range"
                  aria-label="Detection threshold"
                  aria-valuetext={`${thresholdDb} decibels`}
                  min="1"
                  max="40"
                  step="1"
                  value={thresholdDb}
                  disabled={scanning || capturing}
                  onChange={(e) =>
                    setThresholdDb(e.currentTarget.valueAsNumber)
                  }
                />
                <small>
                  Above the detector's estimated noise floor. Monitoring applies
                  these settings to all included regions; surveys use saved band
                  settings.
                </small>
              </label>
            </details>
            {activity === "survey" && advancedControls}
            <details className="explorer-settings">
              <summary>Survey details</summary>
              <div className="scan-summary">
                <span>Source</span>
                <strong>{receiver.session?.source ?? "Start receiver"}</strong>
                <span>Estimated time</span>
                <strong>
                  {estimatedSeconds === null
                    ? "—"
                    : `about ${estimatedSeconds.toFixed(1)} s`}
                </strong>
                <span>Coverage</span>
                <strong>
                  {progress.total
                    ? `${progress.completed} / ${progress.total} windows`
                    : "Not started"}
                </strong>
                <span>Session</span>
                <strong>{sessionId}</strong>
              </div>
              <p className="explorer-note">
                Current window is fastest. Band plan scans enabled regions at
                their saved settings. Full survey uses a 150 ms coarse pass,
                then revisits the strongest active regions with each band’s
                detailed dwell and detector. Widely separated results use a
                logarithmic frequency axis. Results remain relative and
                uncalibrated.
              </p>
            </details>
          </aside>
        )}
        <div className="explorer-results">
          <ExplorerMonitor
            targetControls={monitorTargetControls}
            detectionControls={monitorDetectionControls}
            sourceLabel={
              receiver.session
                ? sourceCapabilities(receiver.session.source).label
                : "No receiver connected"
            }
            onOpenReceiver={onOpenReceiver}
            onSurvey={() => setActivity("survey")}
            preset={monitorPreset}
            targetMode={monitorTargetMode}
            onTargetMode={setMonitorTargetMode}
            customTemplate={currentBand()}
            active={activity === "monitor"}
            pipeline={pipeline}
            controller={controller}
            receiver={receiver}
            profile={{
              ...profile,
              bands:
                monitorTargetMode === "window" && activeWindowBand
                  ? [activeWindowBand]
                  : enabledBands.map((b) => ({
                      ...b,
                      dwellMs,
                      thresholdDb,
                      detector,
                    })),
            }}
            volume={volume}
            blocked={recordingBlocked || capturing}
            startReception={startReceptionForScan}
            onBusy={(active) => {
              setScanning(active);
              onScanningChange(active);
            }}
            onInvestigate={(frequencyHz) =>
              onInvestigate(frequencyHz, receiver.session?.mode ?? "OFF")
            }
          />
          {activity === "survey" && (
            <>
              <SpectrumOverview
                points={points}
                candidates={displayCandidates}
                selectedFrequencyHz={
                  records.find(
                    (record) => recordKey(record) === highlightedRecordKey,
                  )?.frequencyHz
                }
                onSelectCandidate={selectChartCandidate}
              />
              <p className="diagnostic-message" role="status">
                {message}
              </p>
              <p className="survey-storage-status" role="status">
                {storageMessage}
              </p>
              <ActionButton
                type="button"
                className="secondary"
                disabled={!runSnapshot}
                disabledReason="Run a survey or restore saved results before exporting recovery JSON."
                aria-describedby={
                  !runSnapshot ? "survey-recovery-help" : undefined
                }
                onClick={() => {
                  if (runSnapshot)
                    downloadText(
                      `${sessionId}.recovery.json`,
                      JSON.stringify({
                        version: 1,
                        key: "latest",
                        savedAt: new Date().toISOString(),
                        scope,
                        status: runStatus,
                        snapshot: runSnapshot,
                        manifest: runManifest,
                        windows,
                        records,
                        progress,
                      }),
                      "application/json",
                    );
                }}
              >
                Export recovery JSON
              </ActionButton>
              {!runSnapshot && (
                <small id="survey-recovery-help">
                  No survey results to export yet. Run a survey or restore saved
                  results first.
                </small>
              )}
              <div className="candidate-list-wrap">
                <div className="candidate-list-heading">
                  <h3>Candidate review</h3>{" "}
                  <div className="candidate-selection-actions">
                    {records.length > 0 && (
                      <label>
                        <input
                          type="checkbox"
                          aria-label="Select all candidates"
                          checked={records.every((record) => record.selected)}
                          disabled={scanning || capturing}
                          onChange={(event) => {
                            const selected = event.currentTarget.checked;
                            updateRecords((current) =>
                              current.map((record) => ({
                                ...record,
                                selected,
                              })),
                            );
                          }}
                        />{" "}
                        Select all
                      </label>
                    )}
                    <ActionButton
                      type="button"
                      disabledReason={
                        scanning || capturing
                          ? "Wait for the current scan or capture to finish."
                          : receiver.lifecycle !== "running"
                            ? "Start reception before capturing signals."
                            : "Select at least one detected signal."
                      }
                      className="secondary"
                      disabled={
                        !records.some((record) => record.selected) ||
                        scanning ||
                        capturing ||
                        receiver.lifecycle !== "running"
                      }
                      disabledLabel="Capture selected signals"
                      onClick={() => void captureSelected()}
                    >
                      Capture selected (
                      {records.filter((record) => record.selected).length})
                    </ActionButton>{" "}
                  </div>
                  <div className="survey-actions">
                    <ActionButton
                      type="button"
                      disabledReason={
                        "Run or pause a survey before exporting its results."
                      }
                      className="secondary"
                      disabled={!runManifest}
                      onClick={() => {
                        const value = manifest();
                        if (value)
                          downloadText(
                            `${sessionId}.manifest.json`,
                            surveyManifestJson(value),
                            "application/json",
                          );
                      }}
                    >
                      Manifest JSON
                    </ActionButton>
                    <ActionButton
                      type="button"
                      disabledReason={
                        "Run or pause a survey before exporting its results."
                      }
                      className="secondary"
                      disabled={!runManifest}
                      onClick={() => {
                        const value = manifest();
                        if (value)
                          downloadText(
                            `${sessionId}.manifest.csv`,
                            surveyManifestCsv(value),
                            "text/csv",
                          );
                      }}
                    >
                      Manifest CSV
                    </ActionButton>
                  </div>
                </div>
                {records.length ? (
                  <div className="candidate-review-list">
                    {records.slice(0, 200).map((record, index) => (
                      <article
                        key={`${record.bandId}-${record.frequencyHz}`}
                        ref={(element) => {
                          const key = recordKey(record);
                          if (element) recordElements.current.set(key, element);
                          else recordElements.current.delete(key);
                        }}
                        className={`candidate-review-card ${recordKey(record) === highlightedRecordKey ? "candidate-review-card-highlighted" : ""}`}
                        aria-current={
                          recordKey(record) === highlightedRecordKey
                            ? "true"
                            : undefined
                        }
                      >
                        <label className="candidate-select">
                          <input
                            type="checkbox"
                            checked={record.selected}
                            disabled={scanning || capturing}
                            onChange={(e) => {
                              const selected = e.currentTarget.checked;
                              setRecord(index, { selected });
                              if (selected)
                                setHighlightedRecordKey(recordKey(record));
                            }}
                          />
                          <strong>{formatFrequency(record.frequencyHz)}</strong>
                        </label>
                        <span>
                          {record.bandName} · +
                          {(record.peakDb - record.noiseFloorDb).toFixed(1)} dB
                          · {Math.round(record.bandwidthHz).toLocaleString()} Hz
                          · {record.detector}
                          {record.occupancy === undefined
                            ? ""
                            : ` · ${Math.round(record.occupancy * 100)}% occupancy`}
                          {record.captured ? " · ✓ Captured" : ""}
                        </span>
                        <details
                          className="candidate-annotations"
                          open={highlightedRecordKey === recordKey(record)}
                          onToggle={(event) => {
                            const open = event.currentTarget.open;
                            const key = recordKey(record);
                            setHighlightedRecordKey((current) =>
                              open
                                ? key
                                : current === key
                                  ? undefined
                                  : current,
                            );
                          }}
                        >
                          <summary>Annotations</summary>
                          <div className="candidate-annotation-grid">
                            <label>
                              Label
                              <input
                                value={record.annotation.label ?? ""}
                                onChange={(e) =>
                                  setAnnotation(index, {
                                    label: e.currentTarget.value,
                                  })
                                }
                                placeholder="Unknown signal"
                              />
                            </label>
                            <label>
                              Modulation
                              <input
                                value={record.annotation.modulation ?? ""}
                                onChange={(e) =>
                                  setAnnotation(index, {
                                    modulation: e.currentTarget.value,
                                  })
                                }
                                placeholder="e.g. WBFM, PPM"
                              />
                            </label>
                            <label>
                              Encoding
                              <input
                                value={record.annotation.encoding ?? ""}
                                onChange={(e) =>
                                  setAnnotation(index, {
                                    encoding: e.currentTarget.value,
                                  })
                                }
                                placeholder="e.g. RDS, Mode S"
                              />
                            </label>
                            <label>
                              Confidence
                              <select
                                value={record.annotation.confidence}
                                onChange={(e) =>
                                  setAnnotation(index, {
                                    confidence: e.currentTarget
                                      .value as SurveyConfidence,
                                  })
                                }
                              >
                                <option value="unknown">Unknown</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </label>
                          </div>
                        </details>
                        <label>
                          Investigation mode
                          <select
                            aria-label={`Investigation mode at ${record.frequencyHz / 1e6} MHz`}
                            disabled={scanning || capturing}
                            value={investigationMode(record)}
                            onChange={(event) =>
                              setInvestigationModes((current) => ({
                                ...current,
                                [recordKey(record)]: event.target
                                  .value as ReceiverMode,
                              }))
                            }
                          >
                            {RECEIVER_MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {MODE_DESCRIPTIONS[mode].label}
                              </option>
                            ))}
                          </select>
                          <small>
                            Suggested from the saved survey band; signal type is
                            unverified. Choose a mode for custom bands.
                          </small>
                        </label>
                        <ActionButton
                          type="button"
                          className="secondary candidate-action"
                          disabled={
                            scanning ||
                            capturing ||
                            Boolean(investigationIssue(record))
                          }
                          disabledReason={
                            investigationIssue(record) ??
                            "Finish the scan or capture before investigating a candidate."
                          }
                          onClick={() =>
                            onInvestigate(
                              record.frequencyHz,
                              investigationMode(record),
                            )
                          }
                        >
                          Investigate
                        </ActionButton>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="candidate-empty">
                    Run a survey to populate reviewable candidates.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function estimateScopeSeconds(
  scope: ExplorerScanScope,
  bands: readonly SurveyBand[],
  sampleRateHz: number,
  source: NonNullable<ReceiverSnapshot["session"]>["source"],
): number | null {
  try {
    const primary = bands.reduce(
      (sum, band) =>
        sum +
        planSpectrumScan(
          band.startFrequencyHz,
          band.endFrequencyHz,
          sampleRateHz,
          source,
        ).length *
          (SETTLE_TIME_MS + (scope === "full" ? MIN_DWELL_MS : band.dwellMs)),
      0,
    );
    if (scope !== "full") return primary / 1_000;
    const averageDetailedDwell =
      bands.reduce((sum, band) => sum + band.dwellMs, 0) /
      Math.max(1, bands.length);
    return (
      (primary +
        Math.min(MAX_REFINEMENT_REGIONS, bands.length * 4) *
          (SETTLE_TIME_MS + averageDetailedDwell)) /
      1_000
    );
  } catch {
    return null;
  }
}
