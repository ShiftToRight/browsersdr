import { InstrumentRange } from "./InstrumentRange";
import { RememberedDetails } from "./ExplorerPreferencesUI";
import { presentationValue, savePresentation } from "./explorerPreferences";
import "./spectrumActivity.css";
import type { SourceSessionMetadata } from "../radio/types";
import type { SignalAnalysisActivity } from "../radio/signalAnalysis";
import { MonitorDetectionMarkers } from "./MonitorDetectionMarkers";
import {
  monitorSweepIndices,
  monitorSweepPhase,
} from "../radio/monitorSchedule";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import type { MonitorSession } from "../radio/signalMonitor";
import type { MonitorSpectrumView } from "../radio/monitorSpectrum";
import { monitorSpectrumCoverage } from "../radio/monitorSpectrum";

/** Latest measured RF power per tuning window; windows are never connected across gaps. */
export function MonitorFrequencyOverview({
  session,
  spectrum,
  busy,
  now,
  selected,
  tools,
  onSelect,
  analysisLabels,
  activity,
  markerIds,
  receiverSession,
  analysisActivity,
}: {
  session: MonitorSession;
  spectrum?: MonitorSpectrumView;
  busy: boolean;
  now: number;
  selected?: string;
  tools: ReactNode;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
  analysisLabels?: Readonly<Record<string, string>>;
  activity?: string;
  markerIds?: ReadonlySet<string>;
  receiverSession?: SourceSessionMetadata;
  analysisActivity?: SignalAnalysisActivity;
}) {
  const plot = useRef<SVGSVGElement>(null);
  const panel = useRef<HTMLElement>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState(() =>
    presentationValue<boolean>("spectrumVisible", true),
  );
  const [height, setHeight] = useState(() => {
    const saved = presentationValue<number>("spectrumHeight", 240);
    return Number.isFinite(saved) ? Math.max(160, Math.min(440, saved)) : 240;
  });
  const [zoomSelected, setZoomSelected] = useState(false);
  const [hover, setHover] = useState<{
    frequency: number;
    power?: number;
    at?: number;
    left: number;
    top: number;
  }>();
  useEffect(() => {
    savePresentation("spectrumHeight", height);
  }, [height]);
  useEffect(() => {
    savePresentation("spectrumVisible", expanded);
  }, [expanded]);
  useEffect(() => {
    if (!full) return;
    const element = panel.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children).filter(
      (el) => el !== element && !el.contains(element),
    ) as HTMLElement[];
    const prior = siblings.map((el) => el.inert);
    siblings.forEach((el) => {
      el.inert = true;
    });
    document.body.style.overflow = "hidden";
    fullButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFull(false);
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = overflow;
      siblings.forEach((el, i) => {
        el.inert = prior[i]!;
      });
      document.removeEventListener("keydown", escape);
      previous?.focus({ preventScroll: true });
    };
  }, [full]);
  const [plotScale, setPlotScale] = useState(1);
  const [plotYScale, setPlotYScale] = useState(1);
  useEffect(() => {
    const svg = plot.current;
    if (!svg) return;
    const resize = () => {
      const bounds = svg.getBoundingClientRect();
      setPlotScale(Math.max(0.1, bounds.width / 1200));
      setPlotYScale(Math.max(0.1, bounds.height / 184));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [expanded]);
  const frequencyTicks = plotScale < 0.45 ? 2 : 4;
  // Keep each text baseline anchored while compensating for a nonuniform plot transform.
  const textTransform = (baseline: number) =>
    `translate(0 ${baseline}) scale(1 ${plotScale / plotYScale}) translate(0 ${-baseline})`;
  const [allMarkers, setAllMarkers] = useState(false);
  const hatch = useId().replaceAll(":", "");
  const view = spectrum?.sessionId === session.id ? spectrum : undefined;
  const bandLower = Math.min(
    ...session.snapshot.profile.bands.map((b) => b.startFrequencyHz),
  );
  const bandUpper = Math.max(
    ...session.snapshot.profile.bands.map((b) => b.endFrequencyHz),
  );
  const chosen = session.signals.find((signal) => signal.id === selected);
  const zoomWidth = chosen
    ? Math.max(chosen.bandwidthHz * 4, (bandUpper - bandLower) / 1000)
    : bandUpper - bandLower;
  const lower =
    zoomSelected && chosen
      ? Math.max(bandLower, chosen.frequencyHz - zoomWidth / 2)
      : bandLower;
  const upper =
    zoomSelected && chosen
      ? Math.min(bandUpper, chosen.frequencyHz + zoomWidth / 2)
      : bandUpper;
  const log = lower > 0 && upper / lower >= 10;
  const x = (hz: number) =>
    52 +
    Math.max(
      0,
      Math.min(
        1,
        log
          ? Math.log(Math.max(lower, hz) / lower) / Math.log(upper / lower)
          : (hz - lower) / Math.max(1, upper - lower),
      ),
    ) *
      1128;
  // Accepted live capture metadata, independent of the retained broad sweep.
  const capture =
    receiverSession &&
    Number.isFinite(receiverSession.hardwareCenterFrequencyHz) &&
    receiverSession.actualSampleRateHz > 0
      ? receiverSession
      : undefined;
  const captureLower = capture
    ? capture.hardwareCenterFrequencyHz - capture.actualSampleRateHz / 2
    : 0;
  const captureUpper = capture
    ? capture.hardwareCenterFrequencyHz + capture.actualSampleRateHz / 2
    : 0;
  const captureVisible =
    !!capture && captureUpper >= lower && captureLower <= upper;
  const probe =
    analysisActivity &&
    capture &&
    (!analysisActivity.acquisition ||
      analysisActivity.acquisition.sessionGeneration ===
        capture.sessionGeneration)
      ? analysisActivity
      : undefined;
  const sweep = view ? view.sweep - 1 : session.sweeps;
  const sweepIndices = monitorSweepIndices(session, sweep);
  const traces = session.windows.map((w, i) => ({
    window: w,
    index: i,
    measurement: view?.windows[i],
  }));
  const points = traces.flatMap((t) => t.measurement?.points ?? []);
  const floor =
    Math.floor(Math.min(-80, ...points.map((p) => p.powerDb)) / 10) * 10;
  const ceiling =
    Math.ceil(Math.max(-20, ...points.map((p) => p.powerDb)) / 10) * 10;
  const y = (db: number) =>
    18 + ((ceiling - db) / Math.max(10, ceiling - floor)) * 132;
  const running =
    busy && !!view && ["tuning", "measuring"].includes(view.phase);
  const windowIndex = view?.windowIndex;
  const activeWindow =
    windowIndex === undefined ? undefined : session.windows[windowIndex];
  const format = (hz: number) =>
    `${(hz / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} MHz`;
  const phase = running
    ? view!.phase === "tuning"
      ? "Tuning"
      : "Acquiring"
    : busy
      ? "Preparing"
      : session.status === "running"
        ? "Preparing"
        : session.status[0]!.toUpperCase() + session.status.slice(1);
  const measured = traces.filter(
    (t) =>
      sweepIndices.includes(t.index) &&
      t.measurement?.sweep === view?.sweep &&
      t.measurement?.points.length,
  ).length;
  const coverage = monitorSpectrumCoverage(session, view);
  return (
    <section
      ref={panel}
      className="signal-stage monitor-overview monitor-band-spectrum"
      data-full-view={full}
      role={full ? "dialog" : "region"}
      aria-modal={full || undefined}
      onKeyDown={(event) => {
        if (!full || event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,summary,[tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      aria-label="Band spectrum overview"
      data-expanded={expanded}
    >
      <header className="monitor-spectrum-heading">
        <div>
          <h4>Band spectrum</h4>
          <span>
            {(lower / 1e6).toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}
            –
            {(upper / 1e6).toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}{" "}
            MHz · {Math.floor(coverage * 100 + 1e-6)}% retained range measured ·{" "}
            {measured}/{sweepIndices.length} windows this sweep
            {session.sweepPattern
              ? ` · ${monitorSweepPhase(session, sweep)}`
              : ""}
          </span>
        </div>
        <strong
          className={running ? "monitor-spectrum-live" : ""}
          role="status"
        >
          {activity ?? phase}
          {activeWindow && !activity
            ? ` · window ${sweepIndices.indexOf(windowIndex!) + 1}/${sweepIndices.length}`
            : ""}
        </strong>
        {markerIds && (
          <label className="intelligent-after-scan explorer-toggle">
            <input
              type="checkbox"
              checked={allMarkers}
              onChange={(event) => setAllMarkers(event.target.checked)}
            />
            Show all detection markers ({session.signals.length})
          </label>
        )}
        <div className="monitor-plot-tools">
          <button
            type="button"
            className="secondary"
            disabled={!chosen && !zoomSelected}
            aria-pressed={zoomSelected}
            onClick={() => setZoomSelected((value) => !value)}
          >
            {zoomSelected ? "Show full band" : "Zoom selected"}
          </button>
          <RememberedDetails
            preference="spectrumDisplay"
            className="monitor-display-options"
          >
            <summary>Display</summary>
            <label>
              Spectrum height
              <InstrumentRange
                aria-label="Spectrum height"

                min="160"
                max="440"
                step="20"
                value={height}
                onChange={(event) => setHeight(event.target.valueAsNumber)}
              />
            </label>
            <small>
              Visual zoom uses retained bins; FFT resolution is unchanged.
            </small>
          </RememberedDetails>
          <button
            ref={fullButton}
            type="button"
            className="secondary"
            aria-pressed={full}
            onClick={() => setFull((value) => !value)}
          >
            {full ? "Exit full view" : "Full spectrum view"}
          </button>
        </div>
        {tools}
        <button
          type="button"
          className="secondary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide spectrum" : "Show spectrum"}
        </button>
      </header>
      {expanded && (
        <>
          <div className="monitor-receiver-readout" role="status">
            {capture ? (
              <>
                <strong>
                  Receiver now: {format(capture.hardwareCenterFrequencyHz)}
                </strong>
                {" · Shaded: current I/Q capture span"}
                {!captureVisible ? " · outside displayed band" : ""}
                {probe && (
                  <>
                    {" "}
                    ·{" "}
                    {probe.phase === "tuning"
                      ? "Tuning"
                      : probe.phase === "settling"
                        ? "Settling"
                        : "Analyzing"}{" "}
                    {probe.index + 1}/{probe.total}:{" "}
                    {format(probe.candidate.frequencyHz)} ·{" "}
                    {probe.acquiredSeconds.toFixed(1)}/
                    {probe.budgetSeconds.toFixed(0)} s acquired · dashed:
                    candidate
                  </>
                )}
                {!busy && " · Broad spectrum retained from sweep"}
              </>
            ) : (
              "Retained spectrum · receiver is not acquiring"
            )}
          </div>
          <div
            className="monitor-spectrum-plot"
            style={{ "--spectrum-height": `${height}px` } as CSSProperties}
            onPointerLeave={() => setHover(undefined)}
            onPointerMove={(event) => {
              const svg = plot.current;
              if (!svg) return;
              const box = svg.getBoundingClientRect();
              const fraction =
                (((event.clientX - box.left) / box.width) * 1200 - 52) / 1128;
              if (fraction < 0 || fraction > 1) {
                setHover(undefined);
                return;
              }
              const frequency = log
                ? lower * Math.pow(upper / lower, fraction)
                : lower + fraction * (upper - lower);
              const trace = traces.find(
                (t) =>
                  t.measurement?.points.length &&
                  frequency >= t.window.plan.lowerFrequencyHz &&
                  frequency <= t.window.plan.upperFrequencyHz,
              );
              const point = trace?.measurement?.points.reduce((best, p) =>
                Math.abs(p.frequencyHz - frequency) <
                Math.abs(best.frequencyHz - frequency)
                  ? p
                  : best,
              );
              setHover({
                frequency,
                power: point?.powerDb,
                at: trace?.measurement?.at,
                left: Math.min(
                  box.width - 180,
                  Math.max(0, event.clientX - box.left + 12),
                ),
                top: Math.max(
                  48,
                  Math.min(box.height - 54, event.clientY - box.top + 12),
                ),
              });
            }}
          >
            {hover && (
              <output
                className="monitor-plot-hover"
                style={{ left: hover.left, top: hover.top }}
              >
                {format(hover.frequency)}
                <br />
                {hover.power === undefined
                  ? "Unmeasured · no level"
                  : `${hover.power.toFixed(1)} dB rel. · retained`}{" "}
                {hover.at && (
                  <small>{new Date(hover.at).toLocaleTimeString()}</small>
                )}
              </output>
            )}
            <svg
              ref={plot}
              style={
                {
                  "--monitor-axis-font": `${12 / plotScale}px`,
                } as CSSProperties
              }
              viewBox="0 0 1200 184"
              preserveAspectRatio="none"
              role="img"
              aria-label="Latest measured band power spectrum in relative dB"
            >
              <defs>
                <pattern
                  id={hatch}
                  patternUnits="userSpaceOnUse"
                  width="8"
                  height="8"
                >
                  <path d="M0 8L8 0" className="monitor-overview-hatch" />
                </pattern>
                <clipPath id={`${hatch}-clip`}>
                  <rect x="52" y="18" width="1128" height="132" />
                </clipPath>
              </defs>
              <rect
                x="52"
                y="18"
                width="1128"
                height="132"
                fill={`url(#${hatch})`}
                opacity=".35"
              />
              <g clipPath={`url(#${hatch}-clip)`}>
                {traces
                  .filter((t) => t.measurement?.points.length)
                  .map((t) => (
                    <rect
                      key={t.window.id}
                      x={x(t.window.plan.lowerFrequencyHz)}
                      y="18"
                      width={Math.max(
                        0,
                        x(t.window.plan.upperFrequencyHz) -
                          x(t.window.plan.lowerFrequencyHz),
                      )}
                      height="132"
                      className="monitor-spectrum-measured"
                    />
                  ))}
                {[0, 1, 2, 3].map((i) => (
                  <line
                    key={i}
                    x1="52"
                    x2="1180"
                    y1={18 + i * 44}
                    y2={18 + i * 44}
                    className="monitor-spectrum-grid"
                  />
                ))}
                {activeWindow && (
                  <rect
                    data-testid={
                      running ? "monitor-active-window" : "monitor-last-window"
                    }
                    data-window-index={windowIndex}
                    x={x(activeWindow.plan.lowerFrequencyHz)}
                    y="18"
                    width={Math.max(
                      2,
                      x(activeWindow.plan.upperFrequencyHz) -
                        x(activeWindow.plan.lowerFrequencyHz),
                    )}
                    height="132"
                    className={`monitor-spectrum-active ${running ? view!.phase : "paused"}`}
                  >
                    <title>
                      {running ? phase : "Last active window"}:{" "}
                      {format(activeWindow.plan.lowerFrequencyHz)}–
                      {format(activeWindow.plan.upperFrequencyHz)}
                    </title>
                  </rect>
                )}
                {traces
                  .filter((t) => t.measurement?.points.length)
                  .map((t) => (
                    <polyline
                      key={t.window.id}
                      data-testid="monitor-spectrum-trace"
                      data-window-index={t.index}
                      className={`monitor-spectrum-trace ${t.measurement!.sweep === view?.sweep ? "current-sweep" : "previous-sweep"}`}
                      points={t
                        .measurement!.points.filter(
                          (p) =>
                            p.frequencyHz >= lower && p.frequencyHz <= upper,
                        )
                        .map(
                          (p) =>
                            `${x(p.frequencyHz).toFixed(2)},${y(p.powerDb).toFixed(2)}`,
                        )
                        .join(" ")}
                    >
                      <title>
                        Window {t.index + 1} · sweep {t.measurement!.sweep} ·
                        measured{" "}
                        {Math.max(0, (now - t.measurement!.at) / 1000).toFixed(
                          1,
                        )}{" "}
                        s ago
                      </title>
                    </polyline>
                  ))}
                {captureVisible && (
                  <g
                    data-testid="monitor-current-receiver"
                    data-center-hz={capture!.hardwareCenterFrequencyHz}
                  >
                    <rect
                      data-testid="monitor-receiver-footprint"
                      className="monitor-receiver-footprint"
                      x={x(captureLower)}
                      y="18"
                      width={Math.max(1, x(captureUpper) - x(captureLower))}
                      height="132"
                    >
                      <title>
                        Current I/Q capture: {format(captureLower)}–
                        {format(captureUpper)}. Usable edges depend on the
                        source filter.
                      </title>
                    </rect>
                    {capture!.hardwareCenterFrequencyHz >= lower &&
                      capture!.hardwareCenterFrequencyHz <= upper && (
                        <>
                          <line
                            className="monitor-receiver-cursor"
                            x1={x(capture!.hardwareCenterFrequencyHz)}
                            x2={x(capture!.hardwareCenterFrequencyHz)}
                            y1="18"
                            y2="150"
                          />
                          <path
                            fill="var(--cyan)"
                            d={`M${x(capture!.hardwareCenterFrequencyHz) - 7} 18h14l-7 10z`}
                          />
                        </>
                      )}
                  </g>
                )}
                {probe &&
                  probe.candidate.frequencyHz >= lower &&
                  probe.candidate.frequencyHz <= upper && (
                    <g
                      data-testid="monitor-current-probe"
                      data-frequency-hz={probe.candidate.frequencyHz}
                      data-phase={probe.phase}
                    >
                      <line
                        className="monitor-probe-cursor"
                        x1={x(probe.candidate.frequencyHz)}
                        x2={x(probe.candidate.frequencyHz)}
                        y1="18"
                        y2="150"
                      />
                      <title>
                        {probe.phase}: candidate{" "}
                        {format(probe.candidate.frequencyHz)}
                      </title>
                    </g>
                  )}
              </g>
              {[0, 1, 2, 3].map((i) => (
                <text
                  transform={textTransform(22 + i * 44)}
                  key={i}
                  x="43"
                  y={22 + i * 44}
                  textAnchor="end"
                >
                  {Math.round(ceiling - ((ceiling - floor) * i) / 3)}
                </text>
              ))}
              <text
                transform={textTransform(10)}
                x="5"
                y="10"
                className="monitor-spectrum-unit"
              >
                dB rel.
              </text>
              {Array.from({ length: frequencyTicks + 1 }, (_, i) => (
                <text
                  key={i}
                  x={52 + i * (1128 / frequencyTicks)}
                  y="174"
                  transform={textTransform(174)}
                  textAnchor={
                    i === 0 ? "start" : i === frequencyTicks ? "end" : "middle"
                  }
                >
                  {format(
                    log
                      ? lower * Math.pow(upper / lower, i / frequencyTicks)
                      : lower + ((upper - lower) * i) / frequencyTicks,
                  )}
                </text>
              ))}
            </svg>
            {!points.length && (
              <p className="monitor-spectrum-empty-message" role="status">
                {busy
                  ? "Waiting for the first measured window…"
                  : "Start or Resume to measure this band’s spectrum"}
              </p>
            )}
            <MonitorDetectionMarkers
              session={session}
              selected={selected}
              now={now}
              lower={lower}
              upper={upper}
              x={x}
              plot={plot}
              onSelect={onSelect}
              analysisLabels={analysisLabels}
              visibleIds={allMarkers ? undefined : markerIds}
            />
          </div>
          <RememberedDetails
            preference="spectrumLegend"
            className="monitor-spectrum-legend"
          >
            <summary>
              Spectrum legend &amp; measurement limits
              {zoomSelected ? " · zoomed display" : ""}
            </summary>
            <span>
              Lines: detected centers · shaded: measured widths · dashed:
              tentative · faded: older / not seen on latest valid visit
              {markerIds && !allMarkers
                ? " · Showing repeat-confirmed / analyzed signals; other detections retained in All detections"
                : ""}
            </span>
            <span>
              Latest window traces · sampled at different times
              {log ? " · logarithmic frequency axis" : ""}
            </span>
            <span>
              Hatched: not measured / failed
              {activeWindow
                ? ` · ${running ? phase : "Last active window"}: ${format(activeWindow.plan.lowerFrequencyHz)}–${format(activeWindow.plan.upperFrequencyHz)}`
                : ""}
            </span>
          </RememberedDetails>
          {!points.length && (
            <small>
              Spectrum traces are refreshed by new visits; recovered signal
              history contains no saved spectrum samples.
            </small>
          )}
        </>
      )}
    </section>
  );
}
