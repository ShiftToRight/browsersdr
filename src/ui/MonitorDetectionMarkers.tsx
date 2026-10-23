import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { MonitorSession } from "../radio/signalMonitor";
import {
  layoutMonitorMarkers,
  layoutMonitorLabels,
  markerWidth,
  monitorMarkerState,
} from "./monitorMarkerLayout";

const frequency = (hz: number) => `${(hz / 1e6).toFixed(6)} MHz`;

/** Native HTML hit targets stay usable when the SVG scales or letterboxes. No receiver actions. */
export function MonitorDetectionMarkers({
  session,
  now,
  selected,
  lower,
  upper,
  x,
  plot,
  onSelect,
  analysisLabels,
  visibleIds,
}: {
  session: MonitorSession;
  now: number;
  selected?: string;
  lower: number;
  upper: number;
  x: (hz: number) => number;
  plot: RefObject<SVGSVGElement | null>;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
  analysisLabels?: Readonly<Record<string, string>>;
  visibleIds?: ReadonlySet<string>;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const [geometry, setGeometry] = useState({
    width: 0,
    scale: 0,
    scaleY: 0,
    left: 0,
    top: 0,
    targetWidth: 44,
  });
  const [hover, setHover] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const [chooser, setChooser] = useState<{
    sessionId: string;
    ids: string[];
  }>();
  const [query, setQuery] = useState("");
  useLayoutEffect(() => {
    const svg = plot.current,
      element = overlay.current;
    if (!svg || !element) return;
    const measure = () => {
      const box = svg.getBoundingClientRect(),
        parent = element.getBoundingClientRect();
      const scale = box.width / 1200;
      const scaleY = box.height / 184;
      const next = {
        width: parent.width,
        targetWidth:
          box.width >= 600 && window.matchMedia("(pointer: fine)").matches
            ? 24
            : 44,
        scale,
        scaleY,
        left: box.left - parent.left,
        top: box.top - parent.top,
      };
      setGeometry((previous) =>
        Object.keys(next).every(
          (key) =>
            next[key as keyof typeof next] ===
            previous[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    const pointer = window.matchMedia("(pointer: fine)");
    pointer.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      pointer.removeEventListener("change", measure);
    };
  }, [plot]);
  const members =
    chooser?.sessionId === session.id
      ? session.signals.filter((s) => chooser.ids.includes(s.id))
      : [];
  const open = members.length > 0;
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const panel = dialog.current,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.showModal();
    search.current?.focus();
    return () => {
      panel.close();
      document.body.style.overflow = overflow;
      anchor.current?.focus({ preventScroll: true });
    };
  }, [open]);
  const { scale, scaleY, left, top } = geometry;
  const visible = session.signals.filter(
    (s) =>
      Number.isFinite(s.frequencyHz) &&
      (!visibleIds || visibleIds.has(s.id)) &&
      s.frequencyHz >= lower &&
      s.frequencyHz <= upper,
  );
  const groups = layoutMonitorMarkers(
    visible,
    (hz) => left + x(hz) * scale,
    left + 52 * scale,
    left + 1180 * scale,
    geometry.targetWidth,
  );
  const labels = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return [];
    const family = overlay.current
      ? getComputedStyle(overlay.current).fontFamily
      : "sans-serif";
    context.font = `500 12px ${family}`;
    return layoutMonitorLabels(
      groups.flatMap((group) => {
        const signal = group.signals[0]!;
        const text = analysisLabels?.[signal.id];
        return group.signals.length === 1 && text
          ? [
              {
                id: signal.id,
                x: group.x,
                width: Math.min(
                  160,
                  Math.ceil(context.measureText(text).width) + 14,
                ),
                priority:
                  signal.id === selected ? 2 : text.startsWith("RDS") ? 1 : 0,
              },
            ]
          : [];
      }),
      left + 52 * scale,
      left + 1180 * scale,
    );
  }, [groups, analysisLabels, selected, left, scale]);
  const tooltipGroup = groups.find(
    (g) => g.signals[0]!.id === (hover ?? focus),
  );
  const choose = (id: string, trigger: HTMLButtonElement) => {
    setChooser(undefined);
    setHover(undefined);
    setFocus(undefined);
    onSelect(id, trigger);
  };
  return (
    <div
      className="monitor-detection-markers"
      ref={overlay}
      role="group"
      aria-label="Detection markers"
    >
      <svg className="monitor-marker-lines" aria-hidden="true">
        {groups
          .flatMap((group) =>
            group.signals.filter(
              (signal) => group.signals.length === 1 || signal.id === selected,
            ),
          )
          .map((signal) => {
            const state = monitorMarkerState(session, signal, now);
            const sx = (hz: number) => left + x(hz) * scale;
            return (
              <g
                key={signal.id}
                className={`monitor-detection-support ${state.className} ${selected === signal.id ? "is-selected" : ""}`}
                data-testid="monitor-detection-support"
                data-signal-id={signal.id}
              >
                {signal.lowerFrequencyHz !== undefined &&
                  signal.upperFrequencyHz !== undefined && (
                    <rect
                      x={sx(signal.lowerFrequencyHz)}
                      y={top + 18 * scaleY}
                      width={Math.max(
                        1,
                        sx(signal.upperFrequencyHz) -
                          sx(signal.lowerFrequencyHz),
                      )}
                      height={132 * scaleY}
                    />
                  )}
                <line
                  x1={sx(signal.frequencyHz)}
                  x2={sx(signal.frequencyHz)}
                  y1={top + 18 * scaleY}
                  y2={top + 150 * scaleY}
                />
              </g>
            );
          })}
      </svg>
      {groups.map((group) => {
        const first = group.signals[0]!,
          single = group.signals.length === 1;
        const state = monitorMarkerState(session, first, now);
        const selectedGroup = group.signals.some((s) => s.id === selected);
        const key = first.id;
        const label = labels.find((item) => item.id === key);
        const width = markerWidth(group.signals.length, geometry.targetWidth);
        return (
          <button
            key={key}
            type="button"
            className={`monitor-detection-marker ${single ? state.className : `is-cluster ${group.signals.every((signal) => monitorMarkerState(session, signal, now).className.includes("is-older")) ? "is-older" : ""}`} ${selectedGroup ? "is-selected" : ""}`}
            data-testid="monitor-detection-marker"
            data-signal-id={single ? first.id : undefined}
            data-count={group.signals.length}
            aria-label={
              single
                ? `Select detection at ${frequency(first.frequencyHz)}, ${state.label}${analysisLabels?.[first.id] ? `, ${analysisLabels?.[first.id]}` : ""}`
                : `Choose from ${group.signals.length} detected signals near ${frequency(first.frequencyHz)}`
            }
            aria-pressed={selectedGroup}
            title={single ? analysisLabels?.[first.id] : undefined}
            aria-haspopup={single ? undefined : "dialog"}
            style={{
              left: group.x - width / 2,
              top: top + 18 * scaleY,
              width,
              height: Math.max(44, 132 * scaleY),
            }}
            onMouseEnter={() => setHover(key)}
            onMouseLeave={() => setHover(undefined)}
            onFocus={() => setFocus(key)}
            onBlur={() => setFocus(undefined)}
            onClick={(event) => {
              if (single) choose(first.id, event.currentTarget);
              else {
                anchor.current = event.currentTarget;
                setQuery("");
                setChooser({
                  sessionId: session.id,
                  ids: group.signals.map((s) => s.id),
                });
              }
            }}
          >
            <span className="monitor-marker-cap" aria-hidden="true">
              {single ? (
                ""
              ) : (
                <>
                  <b>{group.signals.length}</b>
                  <small>marks</small>
                </>
              )}
            </span>
            {single && label && (
              <span
                className="monitor-marker-intelligence"
                style={{
                  left: label.left - (group.x - width / 2),
                  top: 4 + label.row * 24,
                  width: label.width,
                }}
              >
                {analysisLabels?.[first.id]}
              </span>
            )}
          </button>
        );
      })}
      {tooltipGroup && (
        <div
          className="monitor-marker-tooltip"
          role="tooltip"
          style={{
            left: Math.max(
              0,
              Math.min(geometry.width - 230, tooltipGroup.x - 115),
            ),
            top: top + 150 * scaleY + 4,
          }}
        >
          {tooltipGroup.signals.length === 1 ? (
            <>
              <strong>{frequency(tooltipGroup.signals[0]!.frequencyHz)}</strong>
              {analysisLabels?.[tooltipGroup.signals[0]!.id] && (
                <span>{analysisLabels[tooltipGroup.signals[0]!.id]}</span>
              )}
              <span>
                {
                  monitorMarkerState(session, tooltipGroup.signals[0]!, now)
                    .label
                }
              </span>
              <span>
                {Math.round(
                  tooltipGroup.signals[0]!.bandwidthHz,
                ).toLocaleString()}{" "}
                Hz measured width · +
                {(
                  tooltipGroup.signals[0]!.peakDb -
                  tooltipGroup.signals[0]!.noiseFloorDb
                ).toFixed(1)}{" "}
                dB above noise
              </span>
              <span>
                Last detected{" "}
                {Math.max(
                  0,
                  (now - Date.parse(tooltipGroup.signals[0]!.lastSeen)) / 1000,
                ).toFixed(0)}{" "}
                s ago
              </span>
            </>
          ) : (
            <>
              <strong>{tooltipGroup.signals.length} nearby detections</strong>
              <span>
                {frequency(tooltipGroup.signals[0]!.frequencyHz)}–
                {frequency(tooltipGroup.signals.at(-1)!.frequencyHz)}
              </span>
              <span>Choose a signal to locate its result.</span>
            </>
          )}
        </div>
      )}
      <dialog
        ref={dialog}
        className="monitor-marker-dialog"
        aria-labelledby={labelId}
        onCancel={(event) => {
          event.preventDefault();
          setChooser(undefined);
        }}
      >
        <header>
          <h3 id={labelId}>Nearby detections</h3>
          <button
            type="button"
            className="secondary"
            onClick={() => setChooser(undefined)}
          >
            Close detections
          </button>
        </header>
        <p>Choose a signal to select its result and inspect the evidence.</p>
        <label>
          Filter frequencies
          <input
            type="search"
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="monitor-marker-options">
          {members
            .filter((s) =>
              frequency(s.frequencyHz)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .sort((a, b) => a.frequencyHz - b.frequencyHz)
            .map((signal) => (
              <button
                type="button"
                className="secondary"
                key={signal.id}
                aria-pressed={selected === signal.id}
                onClick={(event) =>
                  choose(signal.id, anchor.current ?? event.currentTarget)
                }
              >
                <strong>{frequency(signal.frequencyHz)}</strong>
                <span>{monitorMarkerState(session, signal, now).label}</span>
                {analysisLabels?.[signal.id] && (
                  <span>{analysisLabels[signal.id]}</span>
                )}
                <small>
                  {Math.round(signal.bandwidthHz).toLocaleString()} Hz measured
                  width
                </small>
              </button>
            ))}
          {members.length > 0 &&
            !members.some((s) =>
              frequency(s.frequencyHz)
                .toLowerCase()
                .includes(query.toLowerCase()),
            ) && <p>No matching detections.</p>}
        </div>
      </dialog>
    </div>
  );
}
