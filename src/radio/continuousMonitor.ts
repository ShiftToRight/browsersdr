import { runMonitor, type MonitorRunnerOptions } from "./monitorRunner";
import {
  analyzeCandidates,
  retainAnalysisEvidence,
  type SignalAnalysisActivity,
  type SignalAnalysisRecord,
} from "./signalAnalysis";
import { monitorContext, type MonitorSession } from "./signalMonitor";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { ReceiverSnapshot } from "./receiverController";

export interface MonitorCycleProgress {
  phase: "discovery" | "analysis" | "cleanup";
  discoveryStart: number;
  discoverySweeps: number;
  pending: number;
  analyzed: number;
  discoveryMs: number;
  analysisMs: number;
}

/** Bounded, fair work queue. A transmitted name is never an association key. */
export class ContinuousAnalysisQueue {
  private waiting = new Map<string, number>();
  select(
    session: MonitorSession,
    records: readonly SignalAnalysisRecord[],
    now: number,
  ) {
    const previous = new Map(records.map((r) => [r.candidate.id, r]));
    const eligible = session.signals
      .filter((s) => s.misses === 0)
      .flatMap((s) => {
        const record = previous.get(s.id);
        const changed =
          record &&
          ((record.candidate.aboveNoiseDb !== undefined &&
            Math.abs(
              s.peakDb - s.noiseFloorDb - record.candidate.aboveNoiseDb,
            ) >= 6) ||
            (record.candidate.aboveNoiseDb === undefined &&
              s.change === "changed") ||
            Math.abs(s.frequencyHz - record.candidate.frequencyHz) >
              Math.max(
                2 *
                  (s.group?.binSpacingHz ??
                    session.snapshot.receiver.actualSampleRateHz / 4096),
                s.bandwidthHz * 0.2,
              ) ||
            Math.abs(s.bandwidthHz - record.candidate.bandwidthHz) >
              record.candidate.bandwidthHz * 0.3);
        // Recheck inconclusive/error evidence sooner, without probing it every sweep.
        const retryMs = record?.result?.suggestedMode ? 300_000 : 60_000;
        if (record && !changed && now - Date.parse(record.at) < retryMs)
          return [];
        if (!this.waiting.has(s.id))
          this.waiting.set(
            s.id,
            Math.min(
              now,
              record
                ? Math.min(
                    Date.parse(record.at) + retryMs,
                    Date.parse(s.lastSeen),
                  )
                : Date.parse(s.firstSeen),
            ),
          );
        const since = this.waiting.get(s.id)!;
        return [
          {
            candidate: {
              id: s.id,
              frequencyHz: s.frequencyHz,
              bandwidthHz: s.bandwidthHz,
              aboveNoiseDb: s.peakDb - s.noiseFloorDb,
            },
            since,
            priority:
              (!record ? 0 : changed ? 1 : 2) -
              Math.floor((now - since) / 60_000),
          },
        ];
      });
    const ids = new Set(eligible.map((e) => e.candidate.id));
    for (const id of this.waiting.keys())
      if (!ids.has(id)) this.waiting.delete(id);
    eligible.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.since - b.since ||
        a.candidate.frequencyHz - b.candidate.frequencyHz ||
        a.candidate.id.localeCompare(b.candidate.id),
    );
    return { candidate: eligible[0]?.candidate, pending: eligible.length };
  }
  serviced(id: string) {
    this.waiting.delete(id);
  }
}

/** Serialize discovery and one whole probe, with one cancellation owner across all stages. */
export async function runContinuousMonitor(
  initial: MonitorSession,
  options: MonitorRunnerOptions & {
    pipeline: MonitorRunnerOptions["pipeline"] &
      Pick<AnalysisPipeline, "analyzeSignal">;
    analyze: boolean;
    seconds: number;
    records: readonly SignalAnalysisRecord[];
    onRecord: (record: SignalAnalysisRecord) => void;
    onActivity: (activity: SignalAnalysisActivity | undefined) => void;
    onCycle: (progress: MonitorCycleProgress) => void;
  },
): Promise<MonitorSession> {
  let session = initial;
  const original = options.controller.getSnapshot();
  let lastReleased: ReceiverSnapshot | undefined;
  let records = [...options.records];
  const queue = new ContinuousAnalysisQueue();
  const now = options.now ?? Date.now;
  let progress: MonitorCycleProgress = {
    phase: "discovery",
    discoveryStart: initial.sweeps,
    discoverySweeps: Math.max(1, 3 - initial.sweeps),
    pending: 0,
    analyzed: 0,
    discoveryMs: 0,
    analysisMs: 0,
  };
  const publish = (patch: Partial<MonitorCycleProgress>) => {
    progress = { ...progress, ...patch };
    options.onCycle(progress);
  };
  const check = (released?: ReceiverSnapshot) => {
    if (options.signal.aborted)
      throw new DOMException("Monitoring cycle paused", "AbortError");
    const current = options.controller.getSnapshot();
    if (
      !released?.session ||
      !current.session ||
      current.session.sessionGeneration !==
        released.session.sessionGeneration ||
      current.sessionGeneration !== released.sessionGeneration ||
      !["running", "connected"].includes(current.lifecycle) ||
      monitorContext(
        session.snapshot.profile,
        current.session,
        session.targets,
        session.analysis,
      ) !== session.context
    )
      throw new Error(
        "Receiver ownership or settings changed; continuous monitoring stopped. Resume manually.",
      );
  };
  try {
    const starting =
      original.lifecycle === "connected"
        ? options.startReception()
        : Promise.resolve(original);
    const startingGeneration =
      options.controller.getSnapshot().sessionGeneration;
    const active = await starting;
    if (active.sessionGeneration !== startingGeneration)
      throw new Error("Receiver changed during activation; Resume manually.");
    lastReleased = active;
    check(active);
    options.controller.setVolume(0);
    while (!options.signal.aborted) {
      let released: ReceiverSnapshot | undefined;
      publish({
        phase: "discovery",
        discoveryStart: session.sweeps,
        discoverySweeps: Math.max(1, 3 - session.sweeps),
      });
      const started = now();
      session = await runMonitor(session, {
        ...options,
        volume: 0,
        stopAfterSweeps: options.analyze ? progress.discoverySweeps : undefined,
        onReleased: (s) => {
          released = s;
          lastReleased = s;
        },
        onUpdate: (s) => {
          session = s;
          options.onUpdate(s);
        },
      });
      publish({ discoveryMs: progress.discoveryMs + now() - started });
      if (
        options.signal.aborted ||
        session.status !== "paused" ||
        !options.analyze
      )
        break;
      check(released);
      const next = queue.select(session, records, now());
      publish({ pending: next.pending });
      if (!next.candidate) continue;
      publish({ phase: "analysis" });
      const analysisStarted = now();
      released = undefined;
      await analyzeCandidates([next.candidate], {
        ...options,
        volume: 0,
        onReleased: (s) => {
          released = s;
          lastReleased = s;
        },
        onActivity: (activity) => {
          options.onActivity(activity);
          if (!activity) publish({ phase: "cleanup" });
        },
        onProgress: () => {},
        onResult: (record) => {
          records = retainAnalysisEvidence(records, record);
          queue.serviced(record.candidate.id);
          options.onRecord(record);
          publish({
            analyzed: progress.analyzed + 1,
            pending: Math.max(0, progress.pending - 1),
          });
        },
      });
      publish({ analysisMs: progress.analysisMs + now() - analysisStarted });
      check(released);
    }
  } catch (error) {
    session = {
      ...session,
      status: options.signal.aborted ? "paused" : "failed",
      message: options.signal.aborted
        ? "Monitoring cycle paused. History and completed analysis retained."
        : error instanceof Error
          ? error.message
          : "Continuous monitoring failed; Resume manually.",
    };
  } finally {
    options.onActivity(undefined);
    const current = options.controller.getSnapshot();
    if (
      lastReleased?.session &&
      current.lifecycle === "running" &&
      current.session &&
      current.sessionGeneration === lastReleased.sessionGeneration &&
      current.session.sessionGeneration ===
        lastReleased.session.sessionGeneration &&
      monitorContext(
        session.snapshot.profile,
        current.session,
        session.targets,
        session.analysis,
      ) ===
        monitorContext(
          session.snapshot.profile,
          lastReleased.session,
          session.targets,
          session.analysis,
        )
    ) {
      try {
        options.controller.setVolume(options.volume);
        if (original.lifecycle === "connected") await options.controller.stop();
      } catch (error) {
        session = {
          ...session,
          status: "failed",
          message: `Cycle cleanup failed: ${error instanceof Error ? error.message : "receiver unavailable"}`,
        };
      }
    }
    if (options.signal.aborted && session.status !== "failed")
      session = {
        ...session,
        status: "paused",
        message:
          "Monitoring cycle paused. History and completed analysis retained.",
      };
    options.onUpdate(session);
  }
  return session;
}
