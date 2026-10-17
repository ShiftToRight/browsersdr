import { compressSpectrumPoints, type SpectrumPoint } from "./spectrumScan";

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
