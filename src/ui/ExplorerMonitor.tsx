import { InstrumentButton } from "./InstrumentButton";
import { PreferenceStatus, RememberedDetails } from "./ExplorerPreferencesUI";
import {
  readPreference,
  storePreference,
  presentationValue,
  savePresentation,
  PREFERENCE_EVENT,
} from "./explorerPreferences";
import { MonitorGroupDetails } from "./MonitorGroupDetails";
import { AppIcon } from "./AppIcon";
import { SignalAnalysisPanel } from "./SignalAnalysisPanel";
import {
  runContinuousMonitor,
  type MonitorCycleProgress,
} from "../radio/continuousMonitor";
import { MonitorStatusCard } from "./MonitorStatusCard";
import type {
  SignalAnalysisActivity,
  SignalAnalysisRecord,
} from "../radio/signalAnalysis";
import type { ReceiverMode } from "../radio/receiverConfig";
import {
  monitorSweepIndices,
  monitorSweepPhase,
} from "../radio/monitorSchedule";
import "./explorerWorkbench.css";
import type { ReactNode } from "react";
import {
  updateMonitorSpectrum,
  type MonitorSpectrumView,
} from "../radio/monitorSpectrum";
import { MonitorFrequencyOverview } from "./MonitorFrequencyOverview";
import { MONITOR_PRESETS, type MonitorPreset } from "../radio/monitorDetection";
import {
  CustomMonitorTargets,
  type MonitorTargetMode,
  type CustomTargetDraft,
} from "./CustomMonitorTargets";
import {
  customMonitorProfile,
  frequencyTarget,
  type MonitorTarget,
} from "../radio/customMonitor";
import { InputClippingWarning } from "./InputClippingWarning";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SurveyBand, SurveyProfile } from "../radio/fieldSurvey";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import {
  createMonitorSession,
  monitorContext,
  monitorCsv,
  monitorTargetsCsv,
  monitorTargetObservation,
  monitorSignalRecent,
  setMonitorBaseline,
  type MonitorSession,
} from "../radio/signalMonitor";
import {
  loadMonitorSession,
  saveMonitorSession,
} from "../radio/monitorStorage";
import { ActionButton } from "./ActionButton";

function frequency(hz: number) {
  return `${(hz / 1e6).toFixed(6)} MHz`;
}
function age(at: string | undefined, now: number) {
  if (!at) return "Not observed";
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  return seconds < 60
    ? `${seconds.toFixed(0)} s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ago`
      : `${(seconds / 3600).toFixed(1)} h ago`;
}
function download(name: string, value: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function ExplorerMonitor({
  pipeline,
  controller,
  receiver,
  profile,
  volume,
  blocked,
  onBusy,
  startReception,
  onInvestigate,
  active,
  targetMode,
  onTargetMode,
  customTemplate,
  targetControls,
  detectionControls,
  sourceLabel,
  onOpenReceiver,
  onSurvey,
  preset,
  setupRevision,
  savedSetupControls,
  onRestoreSetup,
  onAppliedSession,
}: {
  pipeline: AnalysisPipeline;
  controller: ReceiverController;
  receiver: ReceiverSnapshot;
  profile: SurveyProfile;
  volume: number;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
  startReception: () => Promise<ReceiverSnapshot>;
  onInvestigate: (frequencyHz: number, mode?: ReceiverMode) => void;
  active: boolean;
  targetMode: MonitorTargetMode;
  onTargetMode: (mode: MonitorTargetMode) => void;
  customTemplate: SurveyBand;
  targetControls: ReactNode;
  detectionControls: ReactNode;
  sourceLabel: string;
  onOpenReceiver?: () => void;
  onSurvey: () => void;
  preset: MonitorPreset;
  setupRevision: number;
  savedSetupControls: ReactNode;
  onRestoreSetup: (session: MonitorSession) => void;
  onAppliedSession: (session: MonitorSession | undefined) => void;
}) {
  const workspaceElement = useRef<HTMLElement>(null);
  const [spectrumView, setSpectrumView] = useState<MonitorSpectrumView>();
  const [resultView, setResultView] = useState(() =>
    presentationValue("resultView", "signals", ["signals", "targets"]),
  );
  const [customDraft, setCustomDraft] = useState<CustomTargetDraft>({});
  const [targetSeed, setTargetSeed] = useState<MonitorTarget[]>();
  const onCustomChange = useCallback((draft: CustomTargetDraft) => {
    setCustomDraft(draft);
    setTargetSeed(undefined);
  }, []);
  const analysis = { version: 2 as const, preset };
  const custom = targetMode === "frequencies" || targetMode === "range";
  let effectiveProfile = profile;
  let planError = custom
    ? (customDraft.error ??
      (!customDraft.targets ? "Choose monitor targets." : ""))
    : "";
  let plannedWindows: number | undefined;
  if (custom && customDraft.targets && receiver.session) {
    try {
      effectiveProfile = customMonitorProfile(
        profile,
        customTemplate,
        customDraft.targets,
        receiver.session,
      );
      const planned = createMonitorSession(
        effectiveProfile,
        receiver.session,
        undefined,
        customDraft.targets,
        analysis,
      );
      plannedWindows = monitorSweepIndices(planned).length;
    } catch (e) {
      planError = e instanceof Error ? e.message : "Invalid custom plan.";
    }
  }
  if (!custom && receiver.session) {
    try {
      const planned = createMonitorSession(
        effectiveProfile,
        receiver.session,
        undefined,
        undefined,
        analysis,
      );
      plannedWindows = monitorSweepIndices(planned).length;
    } catch (e) {
      planError = e instanceof Error ? e.message : "Invalid monitor plan.";
    }
  }
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const signalButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingSpectrumRow = useRef<string>(undefined);
  const closeDetails = () => {
    setSelected(undefined);
    const trigger = selectedTrigger.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else if (selected)
      signalButtons.current.get(selected)?.focus({ preventScroll: true });
  };
  const [session, setSession] = useState<MonitorSession>();
  const sessionRef = useRef<MonitorSession>(undefined);
  useEffect(() => {
    onAppliedSession(session);
  }, [session, onAppliedSession]);
  const [busy, setBusy] = useState(false);
  const [manualAnalysisBusy, setAnalysisBusy] = useState(false);
  const [cycle, setCycle] = useState<MonitorCycleProgress>();
  const [pausing, setPausing] = useState(false);
  const analysisBusy =
    manualAnalysisBusy || (busy && cycle?.phase === "analysis");
  const [incomingRecord, setIncomingRecord] = useState<SignalAnalysisRecord>();
  const [analysisSeconds, setAnalysisSeconds] = useState(12);
  const [pendingInvestigation, setPendingInvestigation] = useState<{
    frequencyHz: number;
    mode?: ReceiverMode;
  }>();
  const [analysisActivity, setAnalysisActivity] =
    useState<SignalAnalysisActivity>();
  const [analyzeAfterScan, setAnalyzeAfterScan] = useState(
    () =>
      readPreference("browsersdr.monitorAnalysisPreference.v1").enabled ===
      true,
  );
  useEffect(() => {
    storePreference("browsersdr.monitorAnalysisPreference.v1", {
      enabled: analyzeAfterScan,
    });
  }, [analyzeAfterScan]);
  useEffect(() => {
    const update = () =>
      setAnalyzeAfterScan(
        readPreference("browsersdr.monitorAnalysisPreference.v1").enabled ===
          true,
      );
    window.addEventListener(PREFERENCE_EVENT, update);
    return () => window.removeEventListener(PREFERENCE_EVENT, update);
  }, []);
  const [applyQueued, setApplyQueued] = useState(false);
  const [analysisRecords, setAnalysisRecords] = useState<
    SignalAnalysisRecord[]
  >([]);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [analysisStopToken, setAnalysisStopToken] = useState(0);
  const [ready, setReady] = useState(false);
  const [storage, setStorage] = useState("Checking saved monitoring history…");
  const [issue, setIssue] = useState("");
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState(() =>
    presentationValue("filter", "confirmed", [
      "confirmed",
      "history",
      "all",
      "new",
      "changed",
      "returning",
      "unseen",
    ]),
  );
  useEffect(() => {
    savePresentation("filter", filter);
  }, [filter]);
  useEffect(() => {
    savePresentation("resultView", resultView);
  }, [resultView]);
  const [now, setNow] = useState(Date.now);
  const abortRef = useRef<AbortController>(undefined);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  // Parent callbacks reflect the current receiver guards after a pause settles.
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  const update = (next: MonitorSession) => {
    sessionRef.current = next;
    if (mountedRef.current) setSession(next);
  };
  useEffect(() => {
    mountedRef.current = true;
    let live = true;
    void loadMonitorSession()
      .then((saved) => {
        if (!live) return;
        sessionRef.current = saved;
        setSession(saved);

        setStorage(
          saved
            ? "Recovered local history. Acquisition stays stopped until Resume."
            : "History stays on this device. No monitoring session yet.",
        );
      })
      .catch((error: unknown) => {
        if (live)
          setStorage(
            `Not saved: ${error instanceof Error ? error.message : "Storage unavailable"}. Export history to keep a copy.`,
          );
      })
      .finally(() => {
        if (live) setReady(true);
      });
    const suspend = () => {
      setApplyQueued(false);
      setPendingInvestigation(undefined);
      abortRef.current?.abort();
    };
    document.addEventListener("freeze", suspend);
    window.addEventListener("pagehide", suspend);
    return () => {
      live = false;
      mountedRef.current = false;
      abortRef.current?.abort();
      document.removeEventListener("freeze", suspend);
      window.removeEventListener("pagehide", suspend);
    };
  }, []);
  useEffect(() => {
    if (!ready || !session) return;
    let live = true;
    void saveMonitorSession(session)
      .then(() => {
        if (live) setStorage("Checkpoint saved on this device.");
      })
      .catch((error: unknown) => {
        if (live)
          setStorage(
            `Not saved: ${error instanceof Error ? error.message : "Storage unavailable"}. Export history to keep a copy.`,
          );
      });
    return () => {
      live = false;
    };
  }, [session, ready]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  let compatible = false;
  try {
    compatible = !!(
      session &&
      receiver.session &&
      monitorContext(
        effectiveProfile,
        receiver.session,
        custom ? customDraft.targets : undefined,
        session.analysis
          ? { ...analysis, version: session.analysis.version }
          : undefined,
      ) === session.context
    );
  } catch {
    /* An empty/invalid draft must not prevent reviewing retained history. */
  }
  const canStart =
    ready &&
    !busy &&
    !analysisBusy &&
    !blocked &&
    !planError &&
    !!receiver.session &&
    ["running", "connected"].includes(receiver.lifecycle);
  const start = async (resume: boolean) => {
    if (!canStart || abortRef.current || !receiver.session) return;
    try {
      const next = resume
        ? sessionRef.current
        : createMonitorSession(
            effectiveProfile,
            receiver.session,
            undefined,
            custom ? customDraft.targets : undefined,
            analysis,
          );
      if (!next) return;
      setIssue("");
      if (!resume) {
        setSpectrumView(undefined);
        setIncomingRecord(undefined);
        setAnalysisRecords([]);
      }
      stopRef.current = false;
      setPausing(false);
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      onBusyRef.current(true);
      // startReception is invoked inside runMonitor before its first await, preserving the user gesture.
      const result = await runContinuousMonitor(next, {
        pipeline,
        controller,
        volume,
        startReception,
        onUpdate: update,
        analyze: analyzeAfterScan,
        seconds: analysisSeconds,
        records: resume ? analysisRecords : [],
        onCycle: (progress) => {
          if (mountedRef.current) setCycle(progress);
        },
        onRecord: (record) => {
          if (mountedRef.current) setIncomingRecord(record);
        },
        onActivity: (activity) => {
          if (mountedRef.current) setAnalysisActivity(activity);
        },
        onSpectrum: (event) => {
          if (
            mountedRef.current &&
            (!abort.signal.aborted || event.phase === "idle")
          )
            setSpectrumView((previous) =>
              updateMonitorSpectrum(
                previous,
                event,
                sessionRef.current?.windows.length ?? next.windows.length,
              ),
            );
        },
        signal: abort.signal,
      });
      const final =
        stopRef.current && result.status === "paused"
          ? {
              ...result,
              status: "stopped" as const,
              message:
                "Monitoring stopped. History retained; Resume is available.",
            }
          : result;
      update(final);
      // Also checkpoint final state on pagehide/unmount, without restarting the receiver.
      void saveMonitorSession(final).catch(() => undefined);
    } catch (error) {
      if (mountedRef.current)
        setIssue(
          error instanceof Error
            ? error.message
            : "Monitoring could not start.",
        );
    } finally {
      abortRef.current = undefined;
      if (mountedRef.current) {
        setBusy(false);
        setPausing(false);
      }
      onBusyRef.current(false);
    }
  };
  const pause = () => {
    setApplyQueued(false);
    setPausing(true);
    abortRef.current?.abort();
    if (manualAnalysisBusy) setAnalysisStopToken((value) => value + 1);
  };
  const investigate = (frequencyHz: number, mode?: ReceiverMode) => {
    setPendingInvestigation({ frequencyHz, mode });
    if (busy || manualAnalysisBusy) pause();
  };
  const applyInvestigation = useEffectEvent(() => {
    if (pendingInvestigation)
      onInvestigate(
        pendingInvestigation.frequencyHz,
        pendingInvestigation.mode,
      );
    setPendingInvestigation(undefined);
  });
  useEffect(() => {
    if (!active) {
      setPendingInvestigation(undefined);
      setApplyQueued(false);
      abortRef.current?.abort();
      return;
    }
    if (
      pendingInvestigation &&
      !busy &&
      !manualAnalysisBusy &&
      !blocked &&
      !abortRef.current
    )
      applyInvestigation();
  }, [active, pendingInvestigation, busy, manualAnalysisBusy, blocked]);
  const applySettings = useEffectEvent(() => {
    void start(false);
  });
  useEffect(() => {
    if (!active) {
      setApplyQueued(false);
      return;
    }
    if (!applyQueued || !canStart || abortRef.current) return;
    setApplyQueued(false);
    applySettings();
  }, [applyQueued, canStart, active]);
  const [sort, setSort] = useState(() =>
    presentationValue("sort", "frequency", ["frequency", "level", "recent"]),
  );
  useEffect(() => {
    savePresentation("sort", sort);
  }, [sort]);
  const confirmed =
    session?.signals.filter((s) => !session.analysis || s.confirmed).length ??
    0;
  // Probe evidence is independent of the repeated-detection confirmation count.
  const analyzedIds = new Set(
    analysisRecords
      .filter((r) => r.result?.suggestedMode)
      .map((r) => r.candidate.id),
  );
  const analysisById = new Map(
    analysisRecords.map((record) => [record.candidate.id, record]),
  );
  const signals = [...(session?.signals ?? [])]
    .filter(
      (s) =>
        filter === "all" ||
        (filter === "confirmed"
          ? analyzedIds.has(s.id) ||
            ((!session?.analysis || s.confirmed) &&
              (!session ||
                monitorSignalRecent(
                  session,
                  s,
                  busy ? now : Date.parse(session.updatedAt),
                )))
          : filter === "history"
            ? !session?.analysis || s.confirmed
            : filter === "unseen"
              ? s.misses > 0
              : s.change === filter),
    )
    .sort((a, b) =>
      sort === "level"
        ? b.peakDb - b.noiseFloorDb - (a.peakDb - a.noiseFloorDb)
        : sort === "recent"
          ? Date.parse(b.lastSeen) - Date.parse(a.lastSeen)
          : a.frequencyHz - b.frequencyHz,
    );
  useLayoutEffect(() => {
    const id = pendingSpectrumRow.current;
    if (!id) return;
    const button = signalButtons.current.get(id);
    const row = button?.closest("tr"),
      container = button?.closest(".monitor-results-scroll");
    if (!row || !container) return;
    const bounds = container.getBoundingClientRect(),
      target = row.getBoundingClientRect();
    const header =
      container.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    if (target.top < bounds.top + header || target.bottom > bounds.bottom)
      container.scrollTop += target.top - bounds.top - header - 4;
    pendingSpectrumRow.current = undefined;
  }, [signals, selected, resultView]);
  const draftTargets = custom
    ? (customDraft.targets ?? [])
    : targetMode === "window" && !receiver.session
      ? []
      : profile.bands.map((b) => ({
          id: b.id,
          label: b.name,
          startFrequencyHz: b.startFrequencyHz,
          endFrequencyHz: b.endFrequencyHz,
        }));
  const observationSession =
    session && !session.targets
      ? {
          ...session,
          signals: session.signals.map((signal) => ({
            ...signal,
            targetIds: [signal.bandId],
          })),
        }
      : session;
  const detail = session?.signals.find((s) => s.id === selected);
  const detailAnalysis = selected ? analysisById.get(selected) : undefined;
  const displaySweep =
    spectrumView && spectrumView.sessionId === session?.id
      ? spectrumView.sweep - 1
      : Math.max(0, ...(session?.windows.map((w) => w.lastSweep ?? 0) ?? []));
  const sweepWindows = session
    ? monitorSweepIndices(session, displaySweep).map((i) => session.windows[i]!)
    : [];
  const complete = sweepWindows.filter(
    (w) => w.status === "complete" && w.lastSweep === displaySweep,
  ).length;
  const fixed = session?.windows.length === 1;
  const revisit = session
    ? Math.max(0, ...session.windows.map((w) => w.revisitMs ?? 0))
    : 0;
  const plannedSeconds = session
    ? sweepWindows.reduce(
        (sum, w) =>
          sum +
          (session.snapshot.profile.bands.find((b) => b.id === w.bandId)!
            .dwellMs +
            120) /
            1000,
        0,
      )
    : undefined;
  const targetSummary = session
    ? `${Math.min(...session.snapshot.profile.bands.map((b) => b.startFrequencyHz)) / 1e6}–${Math.max(...session.snapshot.profile.bands.map((b) => b.endFrequencyHz)) / 1e6} MHz`
    : "Choose a range or frequencies in Monitor setup";
  const newSessionAction = session && !busy && (
    <ActionButton
      className="secondary studio-new-session"
      disabled={!canStart}
      disabledReason={
        planError ||
        "Finish the other receiver operation and connect a compatible receiver first."
      }
      onClick={() => void start(false)}
    >
      New monitoring session
    </ActionButton>
  );
  const stopAction = busy && (
    <InstrumentButton
      type="button"
      className="secondary"
      onClick={() => {
        setApplyQueued(false);
        stopRef.current = true;
        setPausing(true);
        abortRef.current?.abort();
      }}
    >
      Stop monitoring
    </InstrumentButton>
  );
  const transport = (
    <div className="monitor-actions monitor-transport">
      {!busy && !session && (
        <ActionButton
          className="studio-primary"
          disabled={!canStart}
          disabledReason={
            planError ||
            (!ready
              ? "Wait for saved history to load."
              : "Connect a compatible receiver and finish other operations first.")
          }
          onClick={() => void start(false)}
        >
          Start monitoring
        </ActionButton>
      )}
      {session && !busy && (
        <ActionButton
          className="studio-primary"
          disabled={!canStart || !compatible}
          disabledReason="Restore the original targets, detection preset, settings and receiver context to Resume, or start a new session."
          onClick={() => void start(true)}
        >
          Resume monitoring
        </ActionButton>
      )}
      {busy && (
        <InstrumentButton
          type="button"
          className="studio-primary"
          onClick={pause}
          title="Pause the entire discovery and analysis cycle"
        >
          Pause monitoring
        </InstrumentButton>
      )}
    </div>
  );
  const intelligentControl = (
    <>
      <label className="intelligent-after-scan explorer-toggle">
        <input
          type="checkbox"
          checked={analyzeAfterScan}
          disabled={busy || analysisBusy}
          onChange={(e) => setAnalyzeAfterScan(e.target.checked)}
        />
        Analyze signals after 3 sweeps
      </label>
      <small className="monitor-cycle-explanation">
        {analyzeAfterScan
          ? "Then repeat one sweep and one candidate analysis until paused."
          : "Discovery only: repeat sweeps without candidate analysis."}
      </small>
    </>
  );
  const historyTools = (
    <RememberedDetails preference="historyTools" className="monitor-tools">
      <summary>History & tools</summary>
      <p className="monitor-storage" role="status">
        {storage}
      </p>
      {session && (
        <>
          <small>
            A new session replaces the latest history. Export first to keep it.
            Resume retains its detector and comparison baseline.
          </small>
          <p>
            Detector:{" "}
            {session.analysis
              ? `${MONITOR_PRESETS[session.analysis.preset].label} · region detector v${session.analysis.version} · linear power averaging${session.analysis.version === 1 ? ". Original grouping retained; start a new session for adaptive groups" : ""}`
              : "Legacy detector · original history semantics retained"}
            . Relative levels; no modulation or transmitter identity
            established.
          </p>
          <p>
            {plannedSeconds?.toFixed(1)} s planned dwell + settle per sweep,
            plus acquisition/processing overhead. Visits are sequential; gaps
            and failed visits are unobserved.
          </p>
          <div className="monitor-actions">
            <InstrumentButton
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => update(setMonitorBaseline(session))}
            >
              Set comparison baseline
            </InstrumentButton>
            <InstrumentButton
              type="button"
              className="secondary"
              onClick={() =>
                download(
                  `${session.id}.monitor.json`,
                  JSON.stringify(session, null, 2),
                  "application/json",
                )
              }
            >
              History JSON
            </InstrumentButton>
            <InstrumentButton
              type="button"
              className="secondary"
              onClick={() =>
                download(
                  `${session.id}.monitor.csv`,
                  monitorCsv(session),
                  "text/csv",
                )
              }
            >
              History CSV
            </InstrumentButton>
            {session.targets && (
              <>
                <InstrumentButton
                  type="button"
                  className="secondary"
                  onClick={() =>
                    download(
                      `${session.id}.targets.csv`,
                      monitorTargetsCsv(session),
                      "text/csv",
                    )
                  }
                >
                  Targets CSV
                </InstrumentButton>
              </>
            )}
          </div>
          <small>
            Baseline: {new Date(session.baselineAt).toLocaleString()}. New
            refers to this baseline; confirmation separately counts valid
            observations. Versioned region changes need three sustained valid
            observations. Activity estimates cover valid observed samples, never
            airtime between visits.
          </small>
        </>
      )}
      <p>
        This browser must remain able to acquire samples. Sleep, suspension and
        receiver faults interrupt coverage; recovery never restarts reception
        automatically.
      </p>
    </RememberedDetails>
  );
  return (
    <section
      className="monitor-shell"
      ref={workspaceElement}
      data-guided="false"
      data-detail={!!detail && resultView === "signals"}
      aria-label="Continuous monitoring"
      hidden={!active}
    >
      <div className="monitor-left-rail">
        <aside
          className="signal-stage explorer-controls monitor-setup monitor-setup-rail"
          aria-label="Monitor setup"
        >
          <div className="monitor-setup-heading">
            <div>
              <p className="eyebrow">MONITOR SETUP</p>
              <strong>{sourceLabel}</strong>
            </div>
            {!receiver.session && onOpenReceiver && (
              <InstrumentButton
                type="button"
                className="secondary"
                onClick={onOpenReceiver}
              >
                Open Receiver
              </InstrumentButton>
            )}
          </div>

          <>
            <div className="monitor-setup-step">
              <h3>
                <span>1</span> What to watch
              </h3>
              {active && targetControls}
              <CustomMonitorTargets
                mode={targetMode}
                disabled={blocked}
                currentFrequencyHz={
                  receiver.session?.selectedChannelFrequencyHz
                }
                key={setupRevision}
                activeTargets={session?.targets}
                seed={targetSeed}
                onChange={onCustomChange}
              />
            </div>
            <div className="monitor-setup-step">
              <h3>
                <span>2</span> How to detect
              </h3>
              {active && detectionControls}
            </div>
            <p className="monitor-plan" role="status">
              {planError ||
                (plannedWindows
                  ? `${custom ? `${customDraft.targets?.length} targets · ` : ""}${plannedWindows} ${plannedWindows === 1 ? "shared measurement window in next plan" : "sequential measurement windows in next plan"}`
                  : "Connect a receiver to validate this plan.")}
            </p>
          </>
          {savedSetupControls}
          <PreferenceStatus />
          <div className="monitor-sidebar-status">
            <InputClippingWarning
              compact
              pipeline={pipeline}
              session={receiver.session}
              running={receiver.lifecycle === "running"}
            />
            {session && !compatible && (
              <div className="monitor-draft-notice" role="status">
                <strong>
                  {receiver.session
                    ? "Draft or receiver context differs"
                    : "Retained setup"}
                </strong>
                <small>
                  Applying starts a new history with these settings. Export the
                  current history first to keep it.
                </small>
                <InstrumentButton
                  type="button"
                  className="secondary"
                  disabled={blocked}
                  onClick={() => {
                    onRestoreSetup(session);
                    if (session.targets) {
                      setTargetSeed(structuredClone(session.targets));
                      onTargetMode(
                        session.targets.every((t) => t.kind === "range")
                          ? "range"
                          : "frequencies",
                      );
                    }
                  }}
                >
                  Restore active settings
                </InstrumentButton>
                <ActionButton
                  className="studio-primary"
                  disabled={
                    !!planError || blocked || applyQueued || !receiver.session
                  }
                  disabledReason={
                    planError || "Finish the other receiver operation first."
                  }
                  onClick={() => {
                    setApplyQueued(true);
                    if (analysisBusy)
                      setAnalysisStopToken((value) => value + 1);
                    abortRef.current?.abort();
                  }}
                >
                  {applyQueued
                    ? "Applying settings…"
                    : "Apply changed settings"}
                </ActionButton>
              </div>
            )}
          </div>
        </aside>
        <section
          className="signal-stage monitor-run-card"
          aria-label="Monitoring & analysis"
        >
          <h3>Monitoring &amp; analysis</h3>
          <div className="monitor-control-state">
            <MonitorStatusCard
              state={
                analysisBusy
                  ? "Analyzing signals"
                  : busy
                    ? cycle?.phase === "cleanup"
                      ? "Restoring receiver"
                      : "Monitoring"
                    : (session?.status ??
                      (receiver.session
                        ? "Ready to monitor"
                        : "Connect receiver"))
              }
              running={busy}
              analyzing={analysisBusy}
              pausing={pausing}
              receiver={receiver}
              complete={complete}
              total={sweepWindows.length}
              sweep={displaySweep + 1}
              activity={analysisActivity}
              pending={cycle?.pending ?? 0}
              analyzed={cycle?.analyzed ?? 0}
            >
              {transport}
              {manualAnalysisBusy && (
                <InstrumentButton
                  type="button"
                  className="secondary monitor-stop-analysis"
                  onClick={pause}
                >
                  Stop signal analysis
                </InstrumentButton>
              )}
            </MonitorStatusCard>
          </div>
          <div className="monitor-run-secondary">
            {active && intelligentControl}
            {active && (
              <label className="studio-activity">
                Activity
                <select
                  aria-label="Explorer activity"
                  value="monitor"
                  disabled={busy || analysisBusy || blocked}
                  onChange={(event) => {
                    if (event.currentTarget.value === "survey") onSurvey();
                  }}
                >
                  <option value="monitor">
                    {analyzeAfterScan
                      ? "Continuous discovery + analysis"
                      : "Discovery only"}
                  </option>
                  <option value="survey">Survey once</option>
                </select>
              </label>
            )}
            {newSessionAction}
            {stopAction}
            {session && !busy && (
              <small>
                New session replaces this history. Export it from History &amp;
                tools first to keep a copy.
              </small>
            )}
            {session && (
              <RememberedDetails
                preference="sessionDetails"
                className="monitor-session-details"
              >
                <summary>Applied settings · {targetSummary}</summary>
                <div
                  className="monitor-session-summary"
                  aria-label="Active session settings"
                >
                  <strong>
                    {busy ? "Running session" : "Retained session"}
                  </strong>
                  <span>
                    {session.analysis
                      ? MONITOR_PRESETS[session.analysis.preset].label
                      : "Legacy detector"}
                  </span>
                  <span>{session.snapshot.receiver.source}</span>
                  <span>
                    {session.snapshot.profile.bands.every(
                      (b) =>
                        b.dwellMs ===
                        session.snapshot.profile.bands[0]!.dwellMs,
                    )
                      ? `${session.snapshot.profile.bands[0]!.dwellMs} ms per window`
                      : "Mixed dwell"}
                  </span>
                  <span>
                    {session.snapshot.profile.bands.every(
                      (b) =>
                        b.thresholdDb ===
                        session.snapshot.profile.bands[0]!.thresholdDb,
                    )
                      ? `+${session.snapshot.profile.bands[0]!.thresholdDb} dB threshold`
                      : "Mixed thresholds"}
                  </span>
                  {!compatible && (
                    <span className="monitor-warning">
                      Setup differs · new session required
                    </span>
                  )}
                </div>
              </RememberedDetails>
            )}
            <p
              className={`monitor-message ${session && ["running", "paused"].includes(session.status) ? "monitor-routine-message" : ""}`}
              role="status"
            >
              {analysisBusy
                ? analysisActivity
                  ? `Analyzing ${analysisActivity.index + 1}/${analysisActivity.total} · ${frequency(analysisActivity.candidate.frequencyHz)} · ${analysisActivity.phase} · ${analysisActivity.acquiredSeconds.toFixed(1)}/${analysisActivity.budgetSeconds} s acquired / budget`
                  : analysisProgress
                : busy && analyzeAfterScan
                  ? `Discovery sweep ${Math.min(cycle?.discoverySweeps ?? 3, (session?.sweeps ?? 0) - (cycle?.discoveryStart ?? 0) + 1)} of ${cycle?.discoverySweeps ?? 3} before the next candidate analysis. ${session?.message ?? ""}`
                  : (session?.message ??
                    "Configure a frequency, range or band plan, then Start monitoring.")}
            </p>
            {issue && <p role="alert">{issue}</p>}
            {!custom && planError && (
              <p className="monitor-warning" role="alert">
                {planError}
              </p>
            )}
            {session && !session.analysis && (
              <p className="monitor-warning">
                This history uses the previous detector. Export it to keep it,
                then start a new monitoring session for improved grouping.
              </p>
            )}
            {session && receiver.session && !busy && !compatible && (
              <p className="monitor-warning">
                Resume requires matching receiver source, rate, gains and mode
                as well as the applied setup.
              </p>
            )}
            {((receiver.session?.source === "rtl-sdr" &&
              receiver.session.gainDb === null) ||
              receiver.session?.source === "usrp-b205" ||
              (receiver.session?.source === "bladerf" &&
                receiver.session.bladerf?.gainMode !== "manual")) && (
              <p className="monitor-warning monitor-gain-note">
                Automatic gain · level changes may reflect gain changes.
              </p>
            )}
            {session && (
              <RememberedDetails
                preference="coverageSummary"
                className="monitor-coverage-summary"
              >
                <summary>Coverage &amp; sweep details</summary>
                <div className="monitor-metrics">
                  {cycle && (
                    <div>
                      <span>Elapsed time this run</span>
                      <strong>
                        {(cycle.discoveryMs / 1000).toFixed(1)} s discovery ·{" "}
                        {(cycle.analysisMs / 1000).toFixed(1)} s analysis
                      </strong>
                      <small>
                        Includes tuning and cleanup. The rest of the band is
                        unobserved during a probe.
                      </small>
                    </div>
                  )}
                  <div>
                    <span>Acquisition</span>
                    <strong>
                      {fixed
                        ? "Fixed window"
                        : `${sweepWindows.length} sequential windows`}
                      {session.sweepPattern && (
                        <small data-testid="monitor-sweep-grid">
                          {" · "}
                          {monitorSweepPhase(session, displaySweep)} ·
                          alternating half-window sweeps
                        </small>
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Sweeps</span>
                    <strong data-testid="monitor-sweeps">
                      {session.sweeps}
                    </strong>
                  </div>
                  <div>
                    <span>Valid windows · displayed sweep</span>
                    <strong>
                      {complete} / {sweepWindows.length}
                    </strong>
                  </div>
                  <div>
                    <span>Seen repeatedly / retained</span>
                    <strong>
                      {confirmed} / {session.signals.length}
                    </strong>
                  </div>
                  {!!analysisRecords.length && (
                    <div>
                      <span>FM / RDS evidence</span>
                      <strong>
                        {analyzedIds.size} signals · separate from repeat
                        confirmation
                      </strong>
                    </div>
                  )}
                  <div>
                    <span>Measured revisit</span>
                    <strong>
                      {revisit
                        ? `${(revisit / 1000).toFixed(1)} s`
                        : "Measuring…"}
                    </strong>
                  </div>
                </div>
              </RememberedDetails>
            )}
            {session && (
              <RememberedDetails
                preference="analysisControls"
                className="monitor-intelligent-tools"
              >
                <summary>Signal analysis</summary>
                <small>
                  Recheck positive evidence after 5 minutes; unknown/error
                  results after 1 minute. Changed measurements are eligible
                  sooner.
                </small>
                <SignalAnalysisPanel
                  compact
                  setupRevision={setupRevision}
                  key={session.id}
                  sessionKey={session.id}
                  candidates={session.signals.map((s) => ({
                    id: s.id,
                    frequencyHz: s.frequencyHz,
                    bandwidthHz: s.bandwidthHz,
                  }))}
                  selectedId={selected}
                  receiver={receiver}
                  controller={controller}
                  pipeline={pipeline}
                  volume={volume}
                  blocked={busy || blocked}
                  startReception={startReception}
                  incomingRecord={incomingRecord}
                  onBudget={setAnalysisSeconds}
                  onRecords={setAnalysisRecords}
                  onApply={investigate}
                  onProgress={setAnalysisProgress}
                  onActivity={setAnalysisActivity}
                  stopToken={analysisStopToken}
                  onBusy={(value) => {
                    setAnalysisBusy(value);
                    if (!value && !busy) setPausing(false);
                    onBusyRef.current(value);
                  }}
                />{" "}
              </RememberedDetails>
            )}
            {historyTools}
          </div>
        </section>
      </div>
      <div className="monitor-workspace">
        {session && (
          <MonitorFrequencyOverview
            session={session}
            spectrum={spectrumView}
            busy={busy}
            receiverSession={
              receiver.lifecycle === "running" ? receiver.session : undefined
            }
            analysisActivity={analysisActivity}
            activity={
              analysisBusy ? "Analyzing signals · band sweep paused" : undefined
            }
            markerIds={
              analysisRecords.length
                ? new Set(
                    session.signals
                      .filter(
                        (s) =>
                          s.confirmed ||
                          analyzedIds.has(s.id) ||
                          s.id === selected,
                      )
                      .map((s) => s.id),
                  )
                : undefined
            }
            now={now}
            selected={selected}
            analysisLabels={Object.fromEntries(
              analysisRecords
                .filter(
                  (r) => r.result?.suggestedMode || r.candidate.id === selected,
                )
                .map((r) => [
                  r.candidate.id,
                  r.result?.label ?? "Analysis incomplete",
                ]),
            )}
            tools={null}
            onSelect={(id, trigger) => {
              selectedTrigger.current = trigger;
              pendingSpectrumRow.current = id;
              if (!signals.some((signal) => signal.id === id)) setFilter("all");
              setResultView("signals");
              setSelected(id);
            }}
          />
        )}
        {!session && (
          <section
            className="signal-stage studio-spectrum-empty"
            aria-label="Band spectrum overview"
          >
            <h4>Band spectrum</h4>
            <div>
              <AppIcon name="radio" />
              <strong>Your measured spectrum will appear here</strong>
              <p>Choose targets on the left, then Start monitoring.</p>
            </div>
          </section>
        )}
        <div className="studio-review-layout">
          <div className="signal-stage studio-results-main">
            <div
              className="monitor-view-tabs"
              role="tablist"
              aria-label="Monitoring results"
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "signals"
                    : event.key === "End"
                      ? "targets"
                      : resultView === "signals"
                        ? "targets"
                        : "signals";
                setResultView(next);
                event.currentTarget
                  .querySelector<HTMLButtonElement>(`#monitor-${next}-tab`)
                  ?.focus();
              }}
            >
              <InstrumentButton
                type="button"
                role="tab"
                id="monitor-signals-tab"
                aria-selected={resultView === "signals"}
                tabIndex={resultView === "signals" ? 0 : -1}
                aria-controls="monitor-signals-panel"
                onClick={() => setResultView("signals")}
              >
                Signals <span>{signals.length}</span>
              </InstrumentButton>
              <InstrumentButton
                type="button"
                role="tab"
                id="monitor-targets-tab"
                aria-selected={resultView === "targets"}
                tabIndex={resultView === "targets" ? 0 : -1}
                aria-controls="monitor-targets-panel"
                onClick={() => setResultView("targets")}
              >
                Targets{" "}
                <span>
                  {session
                    ? (session.targets?.length ??
                      session.snapshot.profile.bands.length)
                    : draftTargets.length}
                </span>
              </InstrumentButton>
            </div>
            <div
              className="monitor-signals-panel"
              id="monitor-signals-panel"
              role="tabpanel"
              aria-labelledby="monitor-signals-tab"
              hidden={resultView !== "signals"}
            >
              <div className="monitor-result-controls">
                <div className="studio-results-title">
                  <h4>Detected signals</h4>
                  <small>Select a signal to inspect its evidence</small>
                </div>
                <label>
                  Show signals
                  <select
                    aria-label="Show signals"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="confirmed">
                      {analyzedIds.size
                        ? "Confirmed / analyzed"
                        : "Confirmed / recent"}
                    </option>
                    <option value="history">Confirmed history</option>
                    <option value="all">All detections</option>
                    <option value="new">New since baseline</option>
                    <option value="changed">Changed</option>
                    <option value="returning">Returning</option>
                    <option value="unseen">Not seen on latest visit</option>
                  </select>
                </label>
                <label>
                  Sort by
                  <select
                    aria-label="Sort signals"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="frequency">Frequency</option>
                    <option value="level">Above noise</option>
                    <option value="recent">Last seen</option>
                  </select>
                </label>
                <span className="monitor-result-count">
                  {signals.length} shown
                  {session?.analysis
                    ? ` · ${session.signals.length - confirmed} tentative`
                    : ""}
                </span>
              </div>
              {session?.omittedSignals ? (
                <p className="monitor-warning">
                  Entry limit reached: {session.omittedSignals} detections
                  omitted. Export and narrow the session.
                </p>
              ) : null}
              {session?.discardedCandidates ? (
                <small>
                  {session.discardedCandidates} stale tentative candidates
                  expired at the entry limit. Confirmed history was retained.
                </small>
              ) : null}
              <div className="monitor-table-wrap monitor-results-scroll">
                <table className="monitor-signal-table">
                  <caption>Signal history</caption>
                  <thead>
                    <tr>
                      <th>Frequency / detected span</th>
                      <th>Confidence / state</th>
                      <th>Above noise</th>
                      <th>Observed activity*</th>
                      <th>Last seen</th>
                      <th>Detections</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((s) => (
                      <tr
                        key={s.id}
                        data-signal-id={s.id}
                        aria-selected={selected === s.id}
                        onClick={(event) => {
                          if (
                            (event.target as HTMLElement).closest(
                              "button,summary,input,select,a",
                            )
                          )
                            return;
                          selectedTrigger.current =
                            signalButtons.current.get(s.id) ?? null;
                          setSelected(s.id);
                        }}
                      >
                        <td
                          className={
                            s.group ? "monitor-adaptive-frequency" : undefined
                          }
                        >
                          {analysisById.get(s.id)?.result?.label && (
                            <strong className="studio-signal-name">
                              {analysisById.get(s.id)!.result!.label}
                            </strong>
                          )}
                          <InstrumentButton
                            type="button"
                            className="monitor-frequency"
                            ref={(element) => {
                              if (element)
                                signalButtons.current.set(s.id, element);
                              else signalButtons.current.delete(s.id);
                            }}
                            onClick={(e) => {
                              selectedTrigger.current = e.currentTarget;
                              setSelected(s.id);
                            }}
                          >
                            {frequency(s.frequencyHz)}
                          </InstrumentButton>
                          <small>
                            {Math.round(s.bandwidthHz).toLocaleString()} Hz
                            {s.lowerEdgeClipped || s.upperEdgeClipped
                              ? " · edge clipped"
                              : ""}
                          </small>
                          <MonitorGroupDetails signal={s} />
                          {analysisById.get(s.id)?.result
                            ?.stableProgrammeService && (
                            <span className="signal-analysis-label">
                              Transmitted RDS name
                            </span>
                          )}
                        </td>
                        <td>
                          <span>
                            {session?.analysis
                              ? s.confirmed
                                ? "Confirmed"
                                : "Tentative"
                              : "Legacy"}
                          </span>
                          <small>
                            {s.change} ·{" "}
                            {s.misses
                              ? "Not seen on latest valid visit"
                              : "Seen on latest valid visit"}
                          </small>
                        </td>
                        <td>
                          +{(s.peakDb - s.noiseFloorDb).toFixed(1)} dB
                          {s.caution && (
                            <small
                              className="monitor-warning"
                              title={s.caution}
                            >
                              Check evidence
                            </small>
                          )}
                        </td>
                        <td>
                          {s.validMs
                            ? `${((100 * s.activeMs) / s.validMs).toFixed(0)}%`
                            : "—"}
                        </td>
                        <td title={new Date(s.lastSeen).toLocaleString()}>
                          {age(s.lastSeen, now)}
                        </td>
                        <td>{s.detections}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!signals.length && (
                  <p className="candidate-empty">
                    {session?.signals.length
                      ? "Candidates are still tentative or outside this view. Choose All detections to inspect them. Confirmation counts valid observations, not transmitter identity."
                      : "No detections yet. Start monitoring to build history."}
                  </p>
                )}
              </div>
              <small className="monitor-table-note">
                *Within valid observed samples only. Latest 24 observations
                retained. Strong spectral peaks can be parts of one emission;
                confirmation is repeat observation, not recognition.
              </small>
            </div>
            {!session && (
              <div
                id="monitor-targets-panel"
                hidden={resultView !== "targets"}
                role="tabpanel"
                aria-labelledby="monitor-targets-tab"
                className="monitor-table-wrap"
              >
                <table className="monitor-target-table">
                  <caption>Configured targets · setup draft</caption>
                  <thead>
                    <tr>
                      <th>Target / watched region</th>
                      <th>Observation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftTargets.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.label || "Custom target"}</strong>
                          <small>
                            {frequency(t.startFrequencyHz)}–
                            {frequency(t.endFrequencyHz)}
                          </small>
                        </td>
                        <td>Not yet observed</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="monitor-table-note">
                  Configured targets stay visible even when no activity is
                  detected. Start monitoring to observe this draft.
                </p>
              </div>
            )}
            {session && (
              <div
                role="tabpanel"
                aria-labelledby="monitor-targets-tab"
                hidden={resultView !== "targets"}
                className="monitor-target-coverage"
                id="monitor-targets-panel"
              >
                {
                  <div className="monitor-table-wrap">
                    <table className="monitor-target-table">
                      <caption>Configured targets</caption>
                      <thead>
                        <tr>
                          <th>Target / watched region</th>
                          <th>Observation</th>
                          <th>Last valid</th>
                          <th>Detected entries</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          session.targets ??
                          session.snapshot.profile.bands.map((b) => ({
                            id: b.id,
                            kind: "range" as const,
                            label: b.name,
                            startFrequencyHz: b.startFrequencyHz,
                            endFrequencyHz: b.endFrequencyHz,
                          }))
                        ).map((t) => {
                          const observation = monitorTargetObservation(
                            observationSession!,
                            t,
                            now,
                          );
                          return (
                            <tr key={t.id}>
                              <td>
                                <strong>
                                  {t.label ||
                                    (t.kind === "frequency"
                                      ? frequency(
                                          (t.startFrequencyHz +
                                            t.endFrequencyHz) /
                                            2,
                                        )
                                      : "Custom range")}
                                </strong>
                                <small>
                                  {frequency(t.startFrequencyHz)}–
                                  {frequency(t.endFrequencyHz)}
                                  {t.kind === "frequency"
                                    ? ` · Watch width ${(t.endFrequencyHz - t.startFrequencyHz).toLocaleString()} Hz`
                                    : ""}
                                </small>
                              </td>
                              <td
                                className="monitor-target-status"
                                data-observation={observation.status}
                              >
                                {observation.status}
                              </td>
                              <td>{age(observation.lastValid, now)}</td>
                              <td>
                                {session.targets
                                  ? observation.signalCount
                                  : session.signals.filter(
                                      (signal) => signal.bandId === t.id,
                                    ).length}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <small>
                      Target labels are your annotations. Overlapping targets
                      share detections; each signal and observed interval is
                      counted once. A valid quiet visit does not establish that
                      a transmitter is off.
                    </small>
                  </div>
                }
                <details className="monitor-coverage">
                  <summary>Coverage & revisit times</summary>
                  <div className="monitor-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Region / grid</th>
                          <th>Last valid</th>
                          <th>Last revisit</th>
                          <th>Observed</th>
                          <th>Latest visit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {session.windows.map((w) => (
                          <tr key={w.id}>
                            <td>
                              {frequency(w.plan.lowerFrequencyHz)}–
                              {frequency(w.plan.upperFrequencyHz)}
                              {w.sweepPhase !== undefined && (
                                <small>
                                  {w.sweepPhase === 0
                                    ? "Original grid"
                                    : "Half-window grid"}
                                </small>
                              )}
                            </td>
                            <td>{age(w.lastValidAt, now)}</td>
                            <td>
                              {w.revisitMs === undefined
                                ? "—"
                                : `${(w.revisitMs / 1000).toFixed(1)} s`}
                            </td>
                            <td>{(w.validMs / 1000).toFixed(1)} s</td>
                            <td title={w.error}>
                              {w.status} · {Math.round(w.coverage * 100)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}
          </div>
          {detail && resultView === "signals" && (
            <aside
              className="signal-stage monitor-inspector"
              aria-label="Selected signal details"
              onKeyDown={(e) => {
                if (e.key === "Escape") closeDetails();
              }}
            >
              <div className="monitor-toolbar">
                <div>
                  <p className="eyebrow">SIGNAL DETAILS</p>
                  <p className="studio-inspector-name">
                    {detailAnalysis?.result?.stableProgrammeService ??
                      detailAnalysis?.result?.label ??
                      "Signal detected"}
                  </p>
                  <h4>{frequency(detail.frequencyHz)}</h4>
                </div>
                <InstrumentButton
                  type="button"
                  className="secondary"
                  autoFocus
                  onClick={closeDetails}
                >
                  Close details
                </InstrumentButton>
              </div>
              {detailAnalysis && (
                <div className="studio-decoded-evidence">
                  <span>Signal evidence</span>
                  <strong>
                    {detailAnalysis.result?.label ?? "Analysis incomplete"}
                  </strong>
                  <small>
                    {new Date(detailAnalysis.at).toLocaleString()} · this
                    analysis visit
                  </small>
                  {detailAnalysis.result?.rds.pi && (
                    <small>Decoded PI {detailAnalysis.result.rds.pi}</small>
                  )}
                  <details>
                    <summary>Why this result?</summary>
                    {detailAnalysis.error ? (
                      <p>{detailAnalysis.error}</p>
                    ) : (
                      <ul>
                        {detailAnalysis.result?.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                    {detailAnalysis.result && (
                      <p>
                        {detailAnalysis.result.sampledSeconds.toFixed(2)} s
                        acquired ·{" "}
                        {detailAnalysis.result.resolutionHz.toFixed(1)} Hz bins
                        · samples {detailAnalysis.result.firstSampleIndex}–
                        {detailAnalysis.result.lastSampleIndex} ·{" "}
                        {detailAnalysis.result.discontinuities} gaps.
                      </p>
                    )}
                    {detailAnalysis.previousEvidence && (
                      <p>
                        Earlier evidence retained separately:{" "}
                        {detailAnalysis.previousEvidence.result.label} ·{" "}
                        {new Date(
                          detailAnalysis.previousEvidence.at,
                        ).toLocaleString()}
                      </p>
                    )}
                    <small>
                      Transmitted data does not authenticate a broadcaster or
                      identify a physical transmitter.
                    </small>
                  </details>
                </div>
              )}
              <div className="monitor-detail-stats">
                <span className="monitor-confirmation">
                  {session?.analysis
                    ? detail.confirmed
                      ? "Confirmed detection"
                      : "Tentative detection"
                    : "Legacy detection"}
                </span>
                <strong>
                  +{(detail.peakDb - detail.noiseFloorDb).toFixed(1)} dB above
                  noise
                </strong>
                <span>
                  {(detail.bandwidthHz / 1000).toLocaleString()} kHz detected
                  width
                </span>
                <span>{detail.change} since baseline</span>
              </div>
              <details className="studio-measurement-details">
                <summary>Measurements &amp; evidence</summary>
                {detail.group && (
                  <p>
                    {detail.centerEvidence?.length
                      ? "Stable middle"
                      : "Provisional middle"}
                    : {frequency(detail.frequencyHz)} ·
                    {detail.centerEvidence?.length ?? 0} complete center
                    observations · observed spread{" "}
                    {Math.round(detail.centerSpreadHz ?? 0).toLocaleString()}{" "}
                    Hz. Open Expand group in the table to inspect supported
                    components and grouping evidence.
                  </p>
                )}
                <p>
                  First seen {new Date(detail.firstSeen).toLocaleString()} ·
                  Last seen {new Date(detail.lastSeen).toLocaleString()} ·{" "}
                  {detail.detections} detections
                </p>
                {detail.lowerFrequencyHz !== undefined && (
                  <p>
                    Detected span: {frequency(detail.lowerFrequencyHz)}–
                    {frequency(detail.upperFrequencyHz!)}. Strongest bin:{" "}
                    {frequency(detail.peakFrequencyHz!)}.
                  </p>
                )}
                <p>
                  {(detail.validMs / 1000).toFixed(2)} s valid observed time.
                  Measurement activity does not establish modulation or
                  identity.
                </p>
                <p>
                  Observed activity:{" "}
                  {detail.validMs
                    ? `${((100 * detail.activeMs) / detail.validMs).toFixed(0)}%`
                    : "Not measured"}{" "}
                  of valid observed samples. Gaps between visits are unknown.
                </p>
              </details>
              {detail.caution && (
                <p className="monitor-warning">{detail.caution}</p>
              )}
              <h5>Recent valid observations</h5>
              <small>
                Latest {detail.history.length} valid visits · gaps are not
                measured activity
              </small>
              <div className="monitor-history" aria-label="Recent observations">
                {detail.history.map((h, i) => (
                  <span
                    key={`${h.at}:${i}`}
                    className={h.seen ? "monitor-seen" : "monitor-missed"}
                    title={`${h.at}: ${h.seen ? `seen +${h.snrDb?.toFixed(1)} dB` : "not seen during valid visit"}`}
                  >
                    {h.seen ? "●" : "○"}
                  </span>
                ))}
              </div>
              <small>
                ● Detected · ○ Not detected during a valid visit. Confirmation
                does not identify a transmitter.
              </small>
              <InstrumentButton
                type="button"
                className="secondary monitor-add-target"
                disabled={busy || analysisBusy || blocked}
                onClick={() => {
                  const existing =
                    customDraft.targets?.filter(
                      (t) => t.kind === "frequency",
                    ) ?? [];
                  const next = frequencyTarget(
                    detail.frequencyHz,
                    Math.max(12500, Math.ceil(detail.bandwidthHz)),
                    "Observed signal",
                  );
                  setTargetSeed([...existing, next]);
                  onTargetMode("frequencies");
                  workspaceElement.current
                    ?.querySelector<HTMLElement>(".monitor-setup-rail")
                    ?.scrollIntoView({ block: "start", behavior: "smooth" });
                }}
              >
                Add signal to Custom monitor
              </InstrumentButton>
              {detailAnalysis?.result?.suggestedMode && (
                <ActionButton
                  className="studio-primary"
                  disabled={
                    blocked || !!pendingInvestigation || !receiver.session
                  }
                  disabledReason="Wait for the receiver operation to finish."
                  onClick={() => investigate(detail.frequencyHz, "WBFM")}
                >
                  <AppIcon name="headphones" /> Use WBFM + RDS
                </ActionButton>
              )}
              <ActionButton
                className="secondary"
                disabled={
                  blocked || !!pendingInvestigation || !receiver.session
                }
                disabledReason="Wait for the receiver operation to finish."
                onClick={() => investigate(detail.frequencyHz)}
              >
                Investigate in Receiver
              </ActionButton>
              <small>
                {busy
                  ? "Investigate pauses the entire cycle, then tunes and starts Receiver."
                  : analysisBusy
                    ? "Stop analysis and wait for receiver cleanup."
                    : !receiver.session
                      ? "Connect a receiver to investigate."
                      : blocked
                        ? "Finish the other receiver operation first."
                        : "Investigation keeps the current receiver mode. Tuning happens only when you choose Investigate."}
              </small>
            </aside>
          )}
        </div>
      </div>
    </section>
  );
}
