import { compressSpectrumPoints, type SpectrumPoint } from "./spectrumScan";
import type { MonitorSession } from "./signalMonitor";

export const MONITOR_SPECTRUM_POINT_BUDGET = 4096;
export type MonitorSpectrumPhase =
  "tuning" | "measuring" | "complete" | "failed" | "idle";
export interface MonitorSpectrumUpdate {
  sessionId: string;
  windowIndex: number;
  sweep: number;
  at: number;
  phase: MonitorSpectrumPhase;
  points?: readonly SpectrumPoint[];
}
export interface MonitorSpectrumView {
  sessionId: string;
  windowIndex: number;
  sweep: number;
  phase: MonitorSpectrumPhase;
  windows: Record<
    number,
    { points: SpectrumPoint[]; at: number; sweep: number }
  >;
}

/** Union of retained measured regions, not the number of slots across alternate grids. */
export function monitorSpectrumCoverage(
  session: Pick<MonitorSession, "id" | "windows" | "snapshot">,
  view?: MonitorSpectrumView,
): number {
  const unionWidth = (intervals: number[][]) => {
    let width = 0,
      end = -Infinity;
    for (const [lo, hi] of intervals.sort((a, b) => a[0]! - b[0]!)) {
      width += Math.max(0, hi! - Math.max(lo!, end));
      end = Math.max(end, hi!);
    }
    return width;
  };
  const bands = session.snapshot.profile.bands.map((b) => [
    b.startFrequencyHz,
    b.endFrequencyHz,
  ]);
  const total = unionWidth(bands);
  if (view?.sessionId !== session.id || !total) return 0;
  const measured = session.windows.flatMap((w, i) =>
    !view.windows[i]?.points.length
      ? []
      : bands.flatMap(([lo, hi]) => {
          const start = Math.max(lo!, w.plan.lowerFrequencyHz),
            end = Math.min(hi!, w.plan.upperFrequencyHz);
          return end > start ? [[start, end]] : [];
        }),
  );
  return unionWidth(measured) / total;
}

/** Display-only scalar points. No FFT frames, raw samples, storage or acquisition ownership. */
export function updateMonitorSpectrum(
  previous: MonitorSpectrumView | undefined,
  update: MonitorSpectrumUpdate,
  windowCount: number,
): MonitorSpectrumView {
  const windows =
    previous?.sessionId === update.sessionId ? previous.windows : {};
  const next: MonitorSpectrumView = {
    sessionId: update.sessionId,
    windowIndex: update.windowIndex,
    sweep: update.sweep,
    phase: update.phase,
    windows,
  };
  if (update.phase !== "complete" && update.phase !== "failed") return next;
  const limit = Math.min(
    1024,
    Math.floor(MONITOR_SPECTRUM_POINT_BUDGET / Math.max(1, windowCount)),
  );
  const points =
    update.phase === "complete"
      ? compressSpectrumPoints(
          (update.points ?? []).filter(
            (p) => Number.isFinite(p.frequencyHz) && Number.isFinite(p.powerDb),
          ),
          limit,
        ).map((p) => ({ ...p }))
      : [];
  return {
    ...next,
    windows: {
      ...windows,
      [update.windowIndex]: { points, at: update.at, sweep: update.sweep },
    },
  };
}
