import {
  monitorSignalRecent,
  type MonitorSession,
  type MonitorSignal,
} from "../radio/signalMonitor";

export interface MonitorMarkerGroup {
  x: number;
  signals: MonitorSignal[];
}
export const markerWidth = (count: number, targetWidth = 44) =>
  count === 1 ? targetWidth : 44;

/** Merge overlapping hit targets, including edge clamps. Frequency order never uses table sorting. */
export function layoutMonitorMarkers(
  signals: readonly MonitorSignal[],
  position: (hz: number) => number,
  left: number,
  right: number,
  targetWidth = 44,
): MonitorMarkerGroup[] {
  if (right - left < 1) return [];
  const groups: MonitorMarkerGroup[] = [];
  const center = (items: MonitorSignal[]) => {
    const middle =
      items.reduce((sum, s) => sum + position(s.frequencyHz), 0) / items.length;
    const half =
      Math.min(markerWidth(items.length, targetWidth), right - left) / 2;
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
        (markerWidth(a.signals.length, targetWidth) +
          markerWidth(b.signals.length, targetWidth)) /
          2 +
          6
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

export interface MonitorLabelPlacement {
  id: string;
  left: number;
  width: number;
  row: number;
}

/** Labels use independent lanes; text collisions never merge received detections. */
export function layoutMonitorLabels(
  labels: readonly { id: string; x: number; width: number; priority: number }[],
  left: number,
  right: number,
  rows = 2,
): MonitorLabelPlacement[] {
  if (right <= left) return [];
  const placed: MonitorLabelPlacement[] = [];
  for (const label of [...labels].sort(
    (a, b) => b.priority - a.priority || a.x - b.x || a.id.localeCompare(b.id),
  )) {
    const width = Math.min(label.width, right - left);
    const start = Math.max(left, Math.min(right - width, label.x - width / 2));
    for (let row = 0; row < rows; row++) {
      if (
        placed.some(
          (p) =>
            p.row === row &&
            start < p.left + p.width + 6 &&
            start + width + 6 > p.left,
        )
      )
        continue;
      placed.push({ id: label.id, left: start, width, row });
      break;
    }
  }
  return placed;
}
