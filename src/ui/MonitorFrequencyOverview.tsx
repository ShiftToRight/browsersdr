import { useId, useState, type ReactNode } from "react";
import type { MonitorSession } from "../radio/signalMonitor";
import type { MonitorSpectrumView } from "../radio/monitorSpectrum";

/** Latest measured RF power per tuning window; windows are never connected across gaps. */
export function MonitorFrequencyOverview({
  session,
  spectrum,
  busy,
  now,
  selected,
  tools,
}: {
  session: MonitorSession;
  spectrum?: MonitorSpectrumView;
  busy: boolean;
  now: number;
  selected?: string;
  tools: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const hatch = useId().replaceAll(":", "");
  const view = spectrum?.sessionId === session.id ? spectrum : undefined;
  const lower = Math.min(
    ...session.snapshot.profile.bands.map((b) => b.startFrequencyHz),
  );
  const upper = Math.max(
    ...session.snapshot.profile.bands.map((b) => b.endFrequencyHz),
  );
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
  const last = session.signals.find((s) => s.id === selected);
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
  const measured = traces.filter((t) => t.measurement?.points.length).length;
  return (
    <section
      className="monitor-overview monitor-band-spectrum"
      aria-label="Band spectrum overview"
      data-expanded={expanded}
    >
      <header className="monitor-spectrum-heading">
        <div>
          <h4>Band spectrum</h4>
          <span>
            {format(lower)}–{format(upper)} · {measured}/
            {session.windows.length} windows measured
          </span>
        </div>
        <strong
          className={running ? "monitor-spectrum-live" : ""}
          role="status"
        >
          {phase}
          {activeWindow
            ? ` · window ${windowIndex! + 1}/${session.windows.length}`
            : ""}
        </strong>
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
          <svg
            viewBox="0 0 1200 184"
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
                        (p) => p.frequencyHz >= lower && p.frequencyHz <= upper,
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
                      {Math.max(0, (now - t.measurement!.at) / 1000).toFixed(1)}{" "}
                      s ago
                    </title>
                  </polyline>
                ))}
              {last && last.lowerFrequencyHz !== undefined && (
                <rect
                  x={x(last.lowerFrequencyHz)}
                  y="18"
                  width={Math.max(
                    2,
                    x(last.upperFrequencyHz!) - x(last.lowerFrequencyHz),
                  )}
                  height="132"
                  className="monitor-spectrum-selected"
                >
                  <title>
                    Selected detected span · {format(last.lowerFrequencyHz)}–
                    {format(last.upperFrequencyHz!)}
                  </title>
                </rect>
              )}
              {!points.length && (
                <text
                  x="616"
                  y="91"
                  textAnchor="middle"
                  className="monitor-spectrum-empty"
                >
                  {busy
                    ? "Waiting for the first measured window…"
                    : "Start or Resume to measure this band’s spectrum"}
                </text>
              )}
            </g>
            {[0, 1, 2, 3].map((i) => (
              <text key={i} x="43" y={22 + i * 44} textAnchor="end">
                {Math.round(ceiling - ((ceiling - floor) * i) / 3)}
              </text>
            ))}
            <text x="5" y="10" className="monitor-spectrum-unit">
              dB rel.
            </text>
            {[0, 1, 2, 3, 4].map((i) => (
              <text
                key={i}
                x={52 + i * 282}
                y="174"
                textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              >
                {format(
                  log
                    ? lower * Math.pow(upper / lower, i / 4)
                    : lower + ((upper - lower) * i) / 4,
                )}
              </text>
            ))}
          </svg>
          <div className="monitor-spectrum-legend">
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
          </div>
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
