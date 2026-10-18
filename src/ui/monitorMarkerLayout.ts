import {
  monitorSignalRecent,
  type MonitorSession,
  type MonitorSignal,
} from "../radio/signalMonitor";

export interface MonitorMarkerGroup {
  x: number;
  signals: MonitorSignal[];
}
export const markerWidth = (count: number) => (count === 1 ? 44 : 80);

/** Merge overlapping hit targets, including edge clamps. Frequency order never uses table sorting. */
export function layoutMonitorMarkers(
  signals: readonly MonitorSignal[],
  position: (hz: number) => number,
  left: number,
  right: number,
): MonitorMarkerGroup[] {
  if (right - left < 1) return [];
  const groups: MonitorMarkerGroup[] = [];
  const center = (items: MonitorSignal[]) => {
    const middle =
      items.reduce((sum, s) => sum + position(s.frequencyHz), 0) / items.length;
    const half = Math.min(markerWidth(items.length), right - left) / 2;
    return Math.max(left + half, Math.min(right - half, middle));
  };
  for (const signal of [...signals].sort(
    (a, b) => a.frequencyHz - b.frequencyHz || a.id.localeCompare(b.id),
  )) {
    groups.push({ x: center([signal]), signals: [signal] });
    while (groups.length > 1) {
      const b = groups.at(-1)!,
        a = groups.at(-2)!;
      if (
        b.x - a.x >=
        (markerWidth(a.signals.length) + markerWidth(b.signals.length)) / 2 + 6
      )
        break;
      const members = [...a.signals, ...b.signals];
      groups.splice(-2, 2, { x: center(members), signals: members });
    }
  }
  return groups;
}

export function monitorMarkerState(
  session: MonitorSession,
  signal: MonitorSignal,
  now: number,
) {
  const confirmed = !session.analysis || !!signal.confirmed;
  const older = !monitorSignalRecent(session, signal, now);
  return {
    confirmed,
    older,
    label: `${session.analysis ? (confirmed ? "Confirmed" : "Tentative") : "Legacy detection"} · ${signal.misses ? "Not seen on latest valid visit" : "Seen on latest valid visit"}${older ? " · Older observation" : ""}`,
    className: `${confirmed ? "is-confirmed" : "is-tentative"} ${older || signal.misses ? "is-older" : ""}`,
  };
}
