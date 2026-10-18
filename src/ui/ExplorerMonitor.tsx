import { MonitorGroupDetails } from "./MonitorGroupDetails";
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
import { runMonitor } from "../radio/monitorRunner";
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
  return `${Math.max(0, (now - Date.parse(at)) / 1000).toFixed(1)} s ago`;
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
}: {
  pipeline: AnalysisPipeline;
  controller: ReceiverController;
  receiver: ReceiverSnapshot;
  profile: SurveyProfile;
  volume: number;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
  startReception: () => Promise<ReceiverSnapshot>;
  onInvestigate: (frequencyHz: number) => void;
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
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const setupDialog = useRef<HTMLDialogElement>(null);
  const workspaceElement = useRef<HTMLElement>(null);
  const setupWasOpen = useRef(false);
  const setupFocus = useRef(".monitor-edit-setup:not(:disabled)");
  const [spectrumView, setSpectrumView] = useState<MonitorSpectrumView>();
  useLayoutEffect(() => {
    const panel = setupDialog.current;
    if (!panel) return;
    if (!setupOpen || !active) {
      if (setupWasOpen.current && active) {
        workspaceElement.current
          ?.querySelector<HTMLElement>(setupFocus.current)
          ?.focus({ preventScroll: true });
      }
      setupWasOpen.current = false;
      return;
    }
    setupWasOpen.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.showModal();
    panel
      .querySelector<HTMLButtonElement>(".monitor-popup-close")
      ?.focus({ preventScroll: true });
    return () => {
      panel.close();
      document.body.style.overflow = overflow;
    };
  }, [setupOpen, active]);
  const [resultView, setResultView] = useState("signals");
  const [customDraft, setCustomDraft] = useState<CustomTargetDraft>({});
  const [targetSeed, setTargetSeed] = useState<MonitorTarget[]>();
  const onCustomChange = useCallback(
    (draft: CustomTargetDraft) => setCustomDraft(draft),
    [],
  );
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
      plannedWindows = createMonitorSession(
        effectiveProfile,
        receiver.session,
        undefined,
        customDraft.targets,
        analysis,
      ).windows.length;
    } catch (e) {
      planError = e instanceof Error ? e.message : "Invalid custom plan.";
    }
  }
  if (!custom && receiver.session) {
    try {
      plannedWindows = createMonitorSession(
        effectiveProfile,
        receiver.session,
        undefined,
        undefined,
        analysis,
      ).windows.length;
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
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [storage, setStorage] = useState("Checking saved monitoring history…");
  const [issue, setIssue] = useState("");
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("confirmed");
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
        if (!saved) setSetupOpen(true);
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
    const suspend = () => abortRef.current?.abort();
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
      setSetupOpen(false);
      if (!resume) setSpectrumView(undefined);
      stopRef.current = false;
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      onBusyRef.current(true);
      // startReception is invoked inside runMonitor before its first await, preserving the user gesture.
      const result = await runMonitor(next, {
        pipeline,
        controller,
        volume,
        startReception,
        onUpdate: update,
        onSpectrum: (event) => {
          if (
            mountedRef.current &&
            (!abort.signal.aborted || event.phase === "idle")
          )
            setSpectrumView((previous) =>
              updateMonitorSpectrum(previous, event, next.windows.length),
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
      if (mountedRef.current) setBusy(false);
      onBusyRef.current(false);
    }
  };
  const [sort, setSort] = useState("frequency");
  const confirmed =
    session?.signals.filter((s) => !session.analysis || s.confirmed).length ??
    0;
  const signals = [...(session?.signals ?? [])]
    .filter(
      (s) =>
        filter === "all" ||
        (filter === "confirmed"
          ? (!session?.analysis || s.confirmed) &&
            (!session ||
              monitorSignalRecent(
                session,
                s,
                busy ? now : Date.parse(session.updatedAt),
              ))
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
  const complete =
    session?.windows.filter((w) => w.status === "complete").length ?? 0;
  const fixed = session?.windows.length === 1;
  const revisit = session
    ? Math.max(0, ...session.windows.map((w) => w.revisitMs ?? 0))
    : 0;
  const plannedSeconds = session
    ? session.windows.reduce(
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
    ? `${frequency(Math.min(...session.snapshot.profile.bands.map((b) => b.startFrequencyHz)))}–${frequency(Math.max(...session.snapshot.profile.bands.map((b) => b.endFrequencyHz)))}`
    : "Choose targets in the settings rail";
  const transport = (
    <div className="monitor-actions monitor-transport">
      {!busy && (
        <ActionButton
          disabled={!canStart}
          disabledReason={
            planError ||
            (!ready
              ? "Wait for saved history to load."
              : blocked
                ? "Finish the other receiver operation first."
                : "Connect a compatible receiver in Acquire.")
          }
          onClick={() => void start(false)}
        >
          {session ? "New monitoring session" : "Start monitoring"}
        </ActionButton>
      )}
      {session && !busy && (
        <ActionButton
          className="secondary"
          disabled={!canStart || !compatible}
          disabledReason="Restore the original targets, detection preset, settings and receiver context to Resume, or start a new session."
          onClick={() => void start(true)}
        >
          Resume monitoring
        </ActionButton>
      )}
      {busy && (
        <>
          <button
            type="button"
            className="secondary"
            onClick={() => abortRef.current?.abort()}
          >
            Pause monitoring
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              stopRef.current = true;
              abortRef.current?.abort();
            }}
          >
            Stop monitoring
          </button>
        </>
      )}
    </div>
  );
  const historyTools = (
    <details className="monitor-tools">
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
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => update(setMonitorBaseline(session))}
            >
              Set comparison baseline
            </button>
            <button
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
            </button>
            <button
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
            </button>
            {session.targets && (
              <>
                <button
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
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setTargetSeed(structuredClone(session.targets!));
                    onTargetMode(
                      session.targets!.every((t) => t.kind === "range")
                        ? "range"
                        : "frequencies",
                    );
                  }}
                >
                  Use saved targets
                </button>
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
    </details>
  );
  return (
    <section
      className="monitor-shell"
      ref={workspaceElement}
      data-guided="false"
      data-setup-open={setupOpen}
      data-detail={!!detail}
      aria-label="Continuous monitoring"
      hidden={!active}
    >
      <aside
        className="explorer-controls monitor-setup monitor-setup-rail"
        aria-label="Monitor setup"
      >
        <div className="monitor-setup-heading">
          <div>
            <p className="eyebrow">MONITOR SETUP</p>
            <strong>{sourceLabel}</strong>
          </div>
          {active && (
            <label>
              Activity
              <select
                aria-label="Explorer activity"
                value="monitor"
                disabled={busy || blocked}
                onChange={onSurvey}
              >
                <option value="monitor">Monitor continuously</option>
                <option value="survey">Survey once</option>
              </select>
            </label>
          )}
          {!receiver.session && onOpenReceiver && (
            <button
              type="button"
              className="secondary"
              onClick={onOpenReceiver}
            >
              Go to Acquire
            </button>
          )}
        </div>

        {!setupOpen && (
          <>
            <div
              className="monitor-setup-step"
              onChange={() => {
                setupFocus.current =
                  '.monitor-setup-rail select[aria-label="Monitor targets"]';
                setSetupOpen(true);
              }}
            >
              <h3>
                <span>1</span> What to watch
              </h3>
              {active && targetControls}
            </div>
            {custom && (
              <ul className="monitor-target-summary">
                {customDraft.targets?.slice(0, 4).map((t) => (
                  <li key={t.id}>
                    <strong>{t.label || "Custom target"}</strong>
                    <span>
                      {frequency((t.startFrequencyHz + t.endFrequencyHz) / 2)} ·{" "}
                      {(
                        (t.endFrequencyHz - t.startFrequencyHz) /
                        1000
                      ).toLocaleString()}{" "}
                      kHz watch
                    </span>
                  </li>
                ))}
                {(customDraft.targets?.length ?? 0) > 4 && (
                  <li>+{customDraft.targets!.length - 4} more targets</li>
                )}
                <li>
                  <button
                    type="button"
                    className="secondary monitor-edit-targets"
                    onClick={() => {
                      setupFocus.current = ".monitor-edit-targets";
                      setSetupOpen(true);
                    }}
                  >
                    Edit targets
                  </button>
                </li>
              </ul>
            )}
            <div className="monitor-setup-step">
              <h3>
                <span>2</span> How to detect
              </h3>
              {active && detectionControls}
            </div>
            <p className="monitor-plan" role="status">
              {planError ||
                (plannedWindows
                  ? `${custom ? `${customDraft.targets?.length} targets · ` : ""}${plannedWindows} ${plannedWindows === 1 ? "shared measurement window" : "sequential measurement windows"}`
                  : "Connect a receiver to validate this plan.")}
            </p>
          </>
        )}
      </aside>
      <dialog
        ref={setupDialog}
        className="monitor-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-popup-heading"
        onCancel={(event) => {
          event.preventDefault();
          setSetupOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
            ),
          ).filter((el) => el.getClientRects().length > 0);
          const first = focusable[0],
            last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="monitor-popup-heading">
          <div>
            <p className="eyebrow">EXPLORER</p>
            <h2 id="monitor-popup-heading">Monitoring setup</h2>
          </div>
          <button
            type="button"
            className="secondary monitor-popup-close"
            onClick={() => setSetupOpen(false)}
          >
            Close setup
          </button>
        </header>
        <div className="monitor-setup monitor-setup-popup">
          <div className="monitor-setup-step">
            <h3>
              <span>1</span> What to watch
            </h3>
            {setupOpen && active && targetControls}
            <CustomMonitorTargets
              mode={targetMode}
              disabled={busy || blocked}
              currentFrequencyHz={receiver.session?.selectedChannelFrequencyHz}
              seed={targetSeed}
              onChange={onCustomChange}
            />
          </div>
          <div className="monitor-setup-step">
            <h3>
              <span>2</span> How to detect
            </h3>
            {setupOpen && active && detectionControls}
          </div>
          {setupOpen && (
            <div className="monitor-setup-step monitor-popup-review">
              <h3>
                <span>3</span> Review and start
              </h3>
              <p className="monitor-plan" role="status">
                {planError ||
                  (plannedWindows
                    ? `${custom ? `${customDraft.targets?.length} targets · ` : ""}${plannedWindows} ${plannedWindows === 1 ? "shared measurement window" : "sequential measurement windows"}`
                    : "Connect a receiver to validate this plan.")}
              </p>
              <small>
                Each region is observed during its visit. Gaps between visits
                remain unknown.
              </small>
              {transport}
              {session && (
                <small>
                  A new session replaces the latest history. Export to keep it;
                  Resume preserves compatible history.
                </small>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => setSetupOpen(false)}
              >
                Back to results
              </button>
            </div>
          )}
        </div>
      </dialog>
      <div className="monitor-workspace">
        <div className="monitor-toolbar">
          <div>
            <h3>{session ? "Signal monitor" : "Explore the spectrum"}</h3>
            <small>{targetSummary}</small>
          </div>
          <span
            className={`status-pill ${busy ? "status-running" : "status-idle"}`}
            role="status"
          >
            {busy ? "Monitoring" : (session?.status ?? "Ready")}
          </span>
          <button
            type="button"
            className="secondary monitor-edit-setup"
            aria-expanded={setupOpen}
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => {
              setupFocus.current = ".monitor-edit-setup:not(:disabled)";
              setSetupOpen(true);
            }}
          >
            Edit setup
          </button>
          {!setupOpen && transport}
        </div>
        {session && (
          <div
            className="monitor-session-summary"
            aria-label="Active session settings"
          >
            <strong>{busy ? "Running session" : "Retained session"}</strong>
            <span>
              {session.analysis
                ? MONITOR_PRESETS[session.analysis.preset].label
                : "Legacy detector"}
            </span>
            <span>{session.snapshot.receiver.source}</span>
            <span>
              {session.snapshot.profile.bands.every(
                (b) => b.dwellMs === session.snapshot.profile.bands[0]!.dwellMs,
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
        )}
        <p
          className={`monitor-message ${session && ["running", "paused"].includes(session.status) ? "monitor-routine-message" : ""}`}
          role="status"
        >
          {session?.message ??
            "Configure a frequency, range or band plan, then Start monitoring."}
        </p>
        {issue && <p role="alert">{issue}</p>}
        {!custom && planError && (
          <p className="monitor-warning" role="alert">
            {planError}
          </p>
        )}
        {session && !session.analysis && (
          <p className="monitor-warning">
            This history uses the previous detector. Export it to keep it, then
            start a new monitoring session for improved grouping.
          </p>
        )}
        {session && receiver.session && !busy && !compatible && (
          <p className="monitor-warning">
            Settings differ from this history. Restore the original
            targets/preset/site/source/rate/gains/mode to Resume, or start a new
            session.
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
        <InputClippingWarning
          pipeline={pipeline}
          session={receiver.session}
          running={busy}
        />
        {session && (
          <div className="monitor-metrics">
            <div>
              <span>Acquisition</span>
              <strong>
                {fixed
                  ? "Fixed window"
                  : `${session.windows.length} sequential windows`}
              </strong>
            </div>
            <div>
              <span>Sweeps</span>
              <strong data-testid="monitor-sweeps">{session.sweeps}</strong>
            </div>
            <div>
              <span>Valid windows</span>
              <strong>
                {complete} / {session.windows.length}
              </strong>
            </div>
            <div>
              <span>Confirmed / retained</span>
              <strong>
                {confirmed} / {session.signals.length}
              </strong>
            </div>
            <div>
              <span>Measured revisit</span>
              <strong>
                {revisit ? `${(revisit / 1000).toFixed(1)} s` : "Measuring…"}
              </strong>
            </div>
          </div>
        )}
        {session && (
          <MonitorFrequencyOverview
            session={session}
            spectrum={spectrumView}
            busy={busy}
            now={now}
            selected={selected}
            tools={historyTools}
            onSelect={(id, trigger) => {
              selectedTrigger.current = trigger;
              pendingSpectrumRow.current = id;
              if (!signals.some((signal) => signal.id === id)) setFilter("all");
              setResultView("signals");
              setSelected(id);
            }}
          />
        )}
        {!session && historyTools}
        <div
          className="monitor-view-tabs"
          role="tablist"
          aria-label="Monitoring results"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
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
          <button
            type="button"
            role="tab"
            id="monitor-signals-tab"
            aria-selected={resultView === "signals"}
            tabIndex={resultView === "signals" ? 0 : -1}
            aria-controls="monitor-signals-panel"
            onClick={() => setResultView("signals")}
          >
            Signals <span>{signals.length}</span>
          </button>
          <button
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
          </button>
        </div>
        <div
          className="monitor-signals-panel"
          id="monitor-signals-panel"
          role="tabpanel"
          aria-labelledby="monitor-signals-tab"
          hidden={resultView !== "signals"}
        >
          <div className="monitor-result-controls">
            <div
              className="monitor-filter-chips"
              aria-label="Quick signal filters"
            >
              {[
                ["confirmed", "Confirmed / recent"],
                ["all", "All detections"],
                ["new", "New"],
                ["changed", "Changed"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  className="secondary"
                  aria-pressed={filter === value}
                  key={value}
                  onClick={() => setFilter(value!)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              Show signals
              <select
                aria-label="Show signals"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="confirmed">Confirmed / recent</option>
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
              Entry limit reached: {session.omittedSignals} detections omitted.
              Export and narrow the session.
            </p>
          ) : null}
          {session?.discardedCandidates ? (
            <small>
              {session.discardedCandidates} stale tentative candidates expired
              at the entry limit. Confirmed history was retained.
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
                  >
                    <td
                      className={
                        s.group ? "monitor-adaptive-frequency" : undefined
                      }
                    >
                      <button
                        type="button"
                        className="monitor-frequency"
                        ref={(element) => {
                          if (element) signalButtons.current.set(s.id, element);
                          else signalButtons.current.delete(s.id);
                        }}
                        onClick={(e) => {
                          selectedTrigger.current = e.currentTarget;
                          setSelected(s.id);
                        }}
                      >
                        {frequency(s.frequencyHz)}
                      </button>
                      <small>
                        {Math.round(s.bandwidthHz).toLocaleString()} Hz
                        {s.lowerEdgeClipped || s.upperEdgeClipped
                          ? " · edge clipped"
                          : ""}
                      </small>
                      <MonitorGroupDetails signal={s} />
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
                        <small className="monitor-warning" title={s.caution}>
                          Check evidence
                        </small>
                      )}
                    </td>
                    <td>
                      {s.validMs
                        ? `${((100 * s.activeMs) / s.validMs).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td>{age(s.lastSeen, now)}</td>
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
              Configured targets stay visible even when no activity is detected.
              Start monitoring to observe this draft.
            </p>
          </div>
        )}
        {session && (
          <details
            className="monitor-target-coverage"
            id="monitor-targets-panel"
            open={resultView === "targets"}
            onToggle={(e) => {
              if (e.currentTarget.open) setResultView("targets");
              else setResultView("signals");
            }}
          >
            <summary>Targets & observation coverage</summary>
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
                                      (t.startFrequencyHz + t.endFrequencyHz) /
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
                  Target labels are your annotations. Overlapping targets share
                  detections; each signal and observed interval is counted once.
                  A valid quiet visit does not establish that a transmitter is
                  off.
                </small>
              </div>
            }
            <details className="monitor-coverage">
              <summary>Coverage & revisit times</summary>
              <div className="monitor-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Region</th>
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
          </details>
        )}
      </div>
      {detail && (
        <aside
          className="monitor-inspector"
          aria-label="Selected signal details"
          onKeyDown={(e) => {
            if (e.key === "Escape") closeDetails();
          }}
        >
          <div className="monitor-toolbar">
            <div>
              <p className="eyebrow">SIGNAL DETAILS</p>
              <h4>{frequency(detail.frequencyHz)}</h4>
            </div>
            <button
              type="button"
              className="secondary"
              autoFocus
              onClick={closeDetails}
            >
              Close details
            </button>
          </div>
          <div className="monitor-detail-stats">
            <span className="monitor-confirmation">
              {session?.analysis
                ? detail.confirmed
                  ? "Confirmed detection"
                  : "Tentative detection"
                : "Legacy detection"}
            </span>
            <strong>
              +{(detail.peakDb - detail.noiseFloorDb).toFixed(1)} dB above noise
            </strong>
            <span>
              {(detail.bandwidthHz / 1000).toLocaleString()} kHz detected width
            </span>
            <span>{detail.change} since baseline</span>
          </div>
          {detail.group && (
            <p>
              {detail.centerEvidence?.length
                ? "Stable middle"
                : "Provisional middle"}
              : {frequency(detail.frequencyHz)} ·
              {detail.centerEvidence?.length ?? 0} complete center observations
              · observed spread{" "}
              {Math.round(detail.centerSpreadHz ?? 0).toLocaleString()} Hz. Open
              Expand group in the table to inspect supported components and
              grouping evidence.
            </p>
          )}
          <p>
            First seen {new Date(detail.firstSeen).toLocaleString()} · Last seen{" "}
            {new Date(detail.lastSeen).toLocaleString()} · {detail.detections}{" "}
            detections
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
            Measurement activity does not establish modulation or identity.
          </p>
          {detail.caution && (
            <p className="monitor-warning">{detail.caution}</p>
          )}
          <h5>Recent valid observations</h5>
          <small>
            Latest {detail.history.length} valid visits · gaps are not measured
            activity
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
            ● Detected · ○ Not detected during a valid visit. Confirmation does
            not identify a transmitter.
          </small>
          <button
            type="button"
            className="secondary monitor-add-target"
            disabled={busy || blocked}
            onClick={() => {
              setupFocus.current = ".monitor-add-target";
              const existing =
                customDraft.targets?.filter((t) => t.kind === "frequency") ??
                [];
              const next = frequencyTarget(
                detail.frequencyHz,
                Math.max(12500, Math.ceil(detail.bandwidthHz)),
                "Observed signal",
              );
              setTargetSeed([...existing, next]);
              onTargetMode("frequencies");
              setSetupOpen(true);
            }}
          >
            Add signal to Custom monitor
          </button>
          <ActionButton
            className="secondary"
            disabled={busy || blocked || !receiver.session}
            disabledReason="Pause monitoring and wait for receiver cleanup before investigating."
            onClick={() => onInvestigate(detail.frequencyHz)}
          >
            Investigate in Receiver
          </ActionButton>
          <small>
            Pause first to release the receiver. Investigation retains the
            receiver mode; choose a different mode deliberately. Return here and
            Resume when the monitoring settings match.
          </small>
        </aside>
      )}
    </section>
  );
}
