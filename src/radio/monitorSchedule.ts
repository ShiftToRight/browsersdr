import {
  sourceCapabilities,
  validateSourceFrequency,
} from "./sourceCapabilities";
import type { MonitorSession, MonitorWindow } from "./signalMonitor";

/** Original and half-window grids have independent, stable measurement identities. */
export function alternatingMonitorSession(
  session: MonitorSession,
): MonitorSession {
  if (session.sweepPattern || session.analysis?.version !== 2) return session;
  const counts = new Map<string, MonitorWindow[]>();
  for (const w of session.windows)
    counts.set(w.bandId, [...(counts.get(w.bandId) ?? []), w]);
  if (![...counts.values()].some((windows) => windows.length > 1))
    return session;
  const receiver = session.snapshot.receiver;
  const base = session.windows.map((w) =>
    counts.get(w.bandId)!.length > 1 ? { ...w, sweepPhase: 0 as const } : w,
  );
  const shifted: MonitorWindow[] = [];
  for (const [bandId, windows] of counts) {
    if (windows.length === 1) continue;
    const first = windows[0]!.plan,
      last = windows.at(-1)!.plan;
    const width =
      (last.upperFrequencyHz - first.lowerFrequencyHz) / windows.length;
    for (let i = 0; i <= windows.length; i++) {
      const lowerFrequencyHz =
        i === 0
          ? first.lowerFrequencyHz
          : first.lowerFrequencyHz + (i - 0.5) * width;
      const upperFrequencyHz =
        i === windows.length
          ? last.upperFrequencyHz
          : first.lowerFrequencyHz + (i + 0.5) * width;
      // Endpoints keep an already validated acquisition center; only their accepted
      // region shrinks. Moving these centers toward the band edge can violate limits.
      let centerFrequencyHz =
        i === 0
          ? first.centerFrequencyHz
          : i === windows.length
            ? last.centerFrequencyHz
            : (lowerFrequencyHz + upperFrequencyHz) / 2;
      if (sourceCapabilities(receiver.source).frequency.integerHz)
        centerFrequencyHz = Math.round(centerFrequencyHz);
      validateSourceFrequency(
        receiver.source,
        centerFrequencyHz,
        receiver.actualSampleRateHz,
        receiver.hackrf?.capabilities.identity,
      );
      shifted.push({
        id: `${bandId}:offset:${i}`,
        bandId,
        sweepPhase: 1,
        plan: {
          index: i,
          lowerFrequencyHz,
          upperFrequencyHz,
          centerFrequencyHz,
        },
        visits: 0,
        validMs: 0,
        status: "unobserved",
        coverage: 0,
      });
    }
  }
  const next = {
    ...session,
    sweepPattern: { version: 1 as const, startedAtSweep: session.sweeps },
    windows: [...base, ...shifted],
  };
  if (
    monitorSweepIndices(next).length > 256 ||
    monitorSweepIndices(next, session.sweeps + 1).length > 256
  )
    throw new Error(
      "Alternating monitoring supports up to 256 windows per sweep, including endpoint windows. Narrow the enabled bands.",
    );
  return next;
}

export function monitorSweepIndices(
  session: MonitorSession,
  sweep = session.sweeps,
): number[] {
  const phase = session.sweepPattern
    ? (sweep - session.sweepPattern.startedAtSweep) % 2
    : undefined;
  return session.windows.flatMap((w, i) =>
    w.sweepPhase === undefined || w.sweepPhase === phase ? [i] : [],
  );
}

export function monitorSweepPhase(
  session: MonitorSession,
  sweep = session.sweeps,
): string {
  return session.sweepPattern
    ? (sweep - session.sweepPattern.startedAtSweep) % 2 === 0
      ? "Original grid"
      : "Half-window grid"
    : "Fixed grid";
}

/** Latest attempted visit for every frequency slab, across either grid. */
export function monitorCoverageWindows(
  session: MonitorSession,
  lower: number,
  upper: number,
): MonitorWindow[] {
  const windows = session.windows.filter(
    (w) => w.plan.lowerFrequencyHz < upper && w.plan.upperFrequencyHz > lower,
  );
  if (!session.sweepPattern) return windows;
  const edges = [
    ...new Set([
      lower,
      upper,
      ...windows.flatMap((w) => [
        Math.max(lower, w.plan.lowerFrequencyHz),
        Math.min(upper, w.plan.upperFrequencyHz),
      ]),
    ]),
  ].sort((a, b) => a - b);
  const latest = new Set<MonitorWindow>();
  for (let i = 1; i < edges.length; i++) {
    const covering = windows.filter(
      (w) =>
        w.plan.lowerFrequencyHz <= edges[i - 1]! &&
        w.plan.upperFrequencyHz >= edges[i]!,
    );
    covering.sort((a, b) =>
      (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""),
    );
    if (covering[0]) latest.add(covering[0]);
  }
  return [...latest];
}
