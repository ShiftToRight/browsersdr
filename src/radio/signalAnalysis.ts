import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SignalProbeResult } from "../dsp/signalIntelligence";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "./receiverController";
import { validateSourceFrequency } from "./sourceCapabilities";
import type { SourceSessionMetadata } from "./types";
import { monitorWait } from "./monitorRunner";

export interface AnalysisCandidate {
  id: string;
  frequencyHz: number;
  bandwidthHz: number;
  /** Measured relative level at scheduling, used only to prioritize later rechecks. */
  aboveNoiseDb?: number;
}
export interface SignalAnalysisActivity {
  candidate: AnalysisCandidate;
  index: number;
  total: number;
  phase: "tuning" | "settling" | "measuring";
  acquiredSeconds: number;
  budgetSeconds: number;
  acquisition?: SourceSessionMetadata;
}
export interface SignalAnalysisRecord {
  candidate: AnalysisCandidate;
  at: string;
  acquisition?: SourceSessionMetadata;
  result?: SignalProbeResult;
  error?: string;
  /** Strongest prior evidence survives an inconclusive revisit, with its original provenance. */
  previousEvidence?: {
    at: string;
    acquisition?: SourceSessionMetadata;
    result: SignalProbeResult;
  };
}
const evidenceRank = (result?: SignalProbeResult) =>
  result?.stableProgrammeService
    ? 3
    : result?.rds.pi
      ? 2
      : result?.pilotObserved
        ? 1
        : 0;
export function retainAnalysisEvidence(
  previous: SignalAnalysisRecord[],
  next: SignalAnalysisRecord,
): SignalAnalysisRecord[] {
  const old = previous.find(
    (record) => record.candidate.id === next.candidate.id,
  );
  const strongest =
    old?.previousEvidence &&
    evidenceRank(old.previousEvidence.result) > evidenceRank(old.result)
      ? old.previousEvidence
      : old?.result
        ? { at: old.at, acquisition: old.acquisition, result: old.result }
        : old?.previousEvidence;
  const record =
    strongest &&
    evidenceRank(strongest.result) >= evidenceRank(next.result) &&
    evidenceRank(strongest.result) > 0
      ? { ...next, previousEvidence: strongest }
      : next;
  return [
    ...previous.filter((item) => item.candidate.id !== next.candidate.id),
    record,
  ].slice(-512);
}
export function analysisContext(session: SourceSessionMetadata): string {
  return JSON.stringify({
    source: session.source,
    rate: session.actualSampleRateHz,
    mode: session.mode,
    bandwidth: session.channelBandwidthHz,
    gain: session.gainDb,
    hackrf: session.hackrf && {
      identity: session.hackrf.capabilities.identity,
      rate: session.hackrf.nativeSampleRateHz,
      lna: session.hackrf.captureSettings.rxLnaGainCode,
      vga: session.hackrf.captureSettings.rxVgaGainDb,
      amplifier: session.hackrf.captureSettings.rfAmplifierEnabled,
      bandwidth: session.hackrf.captureSettings.requestedBasebandBandwidthHz,
    },
    bladerf: session.bladerf && {
      identity: session.bladerf.identity,
      rate: session.bladerf.acceptedSampleRateHz,
      bandwidth: session.bladerf.acceptedBandwidthHz,
      gain: session.bladerf.requestedGainDb,
      mode: session.bladerf.gainMode,
      input: session.bladerf.rxInput,
    },
    usrp: session.usrpB205 && {
      capabilities: session.usrpB205.capabilities,
      rate: session.usrpB205.configuration.acceptedSampleRateHz,
      mode: session.usrpB205.configuration.acceptedGainMode,
    },
  });
}

/** One receiver owner. Detections remain immutable; analysis is separate dated evidence. */
export async function analyzeCandidates(
  candidates: readonly AnalysisCandidate[],
  options: {
    controller: Pick<
      ReceiverController,
      "getSnapshot" | "scanTune" | "tune" | "setVolume" | "stop"
    >;
    pipeline: Pick<AnalysisPipeline, "analyzeSignal">;
    startReception: () => Promise<ReceiverSnapshot>;
    seconds: number;
    volume: number;
    signal: AbortSignal;
    onResult: (record: SignalAnalysisRecord) => void;
    onProgress: (
      completed: number,
      total: number,
      candidate: AnalysisCandidate,
      seconds: number,
    ) => void;
    onActivity?: (activity: SignalAnalysisActivity | undefined) => void;
    onReleased?: (snapshot: ReceiverSnapshot) => void;
    wait?: typeof monitorWait;
  },
): Promise<void> {
  if (
    candidates.length > 512 ||
    !Number.isFinite(options.seconds) ||
    options.seconds < 1 ||
    options.seconds > 30
  )
    throw new Error(
      "Analyze up to 512 candidates with a 1–30 second per-candidate budget.",
    );
  for (const c of candidates)
    if (
      !c.id ||
      !Number.isFinite(c.frequencyHz) ||
      !Number.isFinite(c.bandwidthHz) ||
      c.bandwidthHz <= 0
    )
      throw new Error("Invalid signal candidate.");
  const { controller, signal } = options;
  const original = controller.getSnapshot();
  const initial = original.session;
  if (!initial || !["connected", "running"].includes(original.lifecycle))
    throw new Error("Connect a receiver before signal analysis.");
  if (initial.source === "replay" || initial.mode === "ADS-B")
    throw new Error(
      "Range analysis needs a tunable local source in a scanning-compatible mode.",
    );
  const context = analysisContext(initial);
  let ownedGeneration: number | undefined;
  const check = () => {
    if (signal.aborted)
      throw new DOMException("Signal analysis cancelled", "AbortError");
    const current = controller.getSnapshot();
    if (
      !current.session ||
      current.lifecycle !== "running" ||
      current.session.sessionGeneration !== ownedGeneration ||
      analysisContext(current.session) !== context
    )
      throw new Error("Receiver settings changed; signal analysis stopped.");
  };
  const wait = options.wait ?? monitorWait;
  const restoreOriginal = async () => {
    const restored = await controller.scanTune(
      initial.hardwareCenterFrequencyHz,
    );
    if (!restored)
      throw new Error(
        "Could not restore the original receiver center after analysis.",
      );
    ownedGeneration = restored.sessionGeneration;
    const tuning = controller.tune(initial.selectedChannelFrequencyHz);
    // tune publishes its owned generation synchronously before awaiting hardware.
    const restoringGeneration =
      controller.getSnapshot().session?.sessionGeneration;
    await tuning;
    if (
      controller.getSnapshot().session?.sessionGeneration ===
      restoringGeneration
    )
      ownedGeneration = restoringGeneration;
    else ownedGeneration = undefined;
  };
  try {
    const active =
      original.lifecycle === "connected"
        ? await options.startReception()
        : original;
    ownedGeneration = active.session?.sessionGeneration;
    check();
    controller.setVolume(0);
    const ordered = [
      ...new Map(candidates.map((c) => [c.id, c])).values(),
    ].sort((a, b) => a.frequencyHz - b.frequencyHz || a.id.localeCompare(b.id));
    for (let index = 0; index < ordered.length; index++) {
      check();
      const candidate = ordered[index]!;
      const budgetSeconds =
        candidate.bandwidthHz >= 40_000 && candidate.bandwidthHz <= 350_000
          ? options.seconds
          : Math.min(2, options.seconds);
      const activity = {
        candidate,
        index,
        total: ordered.length,
        acquiredSeconds: 0,
        budgetSeconds,
      };
      options.onActivity?.({
        ...activity,
        phase: "tuning",
        acquisition: { ...controller.getSnapshot().session! },
      });
      options.onProgress(index, ordered.length, candidate, 0);
      try {
        const rate = initial.actualSampleRateHz;
        // Keep the measured candidate away from the tuner/DC center; try legal alternatives at band edges.
        const center = [
          candidate.frequencyHz - rate * 0.18,
          candidate.frequencyHz + rate * 0.18,
          candidate.frequencyHz,
        ].find((hz) => {
          try {
            validateSourceFrequency(
              initial.source,
              hz,
              ["hackrf", "bladerf", "usrp-b205"].includes(initial.source)
                ? rate
                : 0,
              initial.hackrf?.capabilities.identity,
            );
            return true;
          } catch {
            return false;
          }
        });
        if (center === undefined)
          throw new Error("No legal acquisition center covers this candidate.");
        const tuned = await controller.scanTune(center);
        if (!tuned) throw new Error("Receiver could not tune this candidate.");
        ownedGeneration = tuned.sessionGeneration;
        check();
        options.onActivity?.({
          ...activity,
          phase: "settling",
          acquisition: { ...tuned },
        });
        await wait(150, signal);
        check();
        options.onActivity?.({
          ...activity,
          phase: "measuring",
          acquisition: { ...tuned },
        });
        const result = await options.pipeline.analyzeSignal(
          {
            sampleRateHz: tuned.actualSampleRateHz,
            centerFrequencyHz: tuned.hardwareCenterFrequencyHz,
            frequencyHz: candidate.frequencyHz,
            bandwidthHz: candidate.bandwidthHz,
            seconds: budgetSeconds,
          },
          signal,
          (seconds) => {
            if (
              signal.aborted ||
              controller.getSnapshot().session?.sessionGeneration !==
                ownedGeneration
            )
              return;
            options.onProgress(index, ordered.length, candidate, seconds);
            options.onActivity?.({
              ...activity,
              phase: "measuring",
              acquiredSeconds: seconds,
              acquisition: { ...tuned },
            });
          },
        );
        check();
        options.onResult({
          candidate,
          at: new Date().toISOString(),
          acquisition: { ...tuned },
          result,
        });
      } catch (error) {
        check(); // Cancellation/context loss ends the queue; a single inconclusive probe does not.
        options.onResult({
          candidate,
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Analysis failed.",
        });
      }
    }
  } finally {
    options.onActivity?.(undefined);
    const current = controller.getSnapshot();
    // Never retune/stop a replacement acquisition or a source changed by the owner.
    if (
      ownedGeneration !== undefined &&
      current.session?.sessionGeneration === ownedGeneration &&
      current.lifecycle === "running" &&
      analysisContext(current.session) === context
    ) {
      try {
        await restoreOriginal();
      } finally {
        const last = controller.getSnapshot();
        if (
          last.session &&
          last.session.sessionGeneration === ownedGeneration &&
          analysisContext(last.session) === context &&
          last.session.source === initial.source
        ) {
          controller.setVolume(options.volume);
          const stopping =
            original.lifecycle === "connected" && last.lifecycle === "running"
              ? controller.stop()
              : Promise.resolve();
          const releaseGeneration = controller.getSnapshot().sessionGeneration;
          await stopping;
          const released = controller.getSnapshot();
          if (
            released.session &&
            released.sessionGeneration === releaseGeneration &&
            released.lifecycle === original.lifecycle &&
            analysisContext(released.session) === context
          )
            options.onReleased?.(released);
        }
      }
    }
  }
}
