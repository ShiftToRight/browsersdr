import { analyzeMonitorWindow } from "./monitorDetection";
import {
  alternatingMonitorSession,
  monitorSweepIndices,
  monitorSweepPhase,
} from "./monitorSchedule";
import type {
  MonitorSpectrumUpdate,
  MonitorSpectrumPhase,
} from "./monitorSpectrum";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "./receiverController";
import {
  analyzeScanWindow,
  collectSpectrumMeasurement,
  failedScanWindow,
  type SpectrumMeasurementSource,
  type SpectrumMeasurement,
} from "./spectrumScan";
import {
  monitorContext,
  recordMonitorVisit,
  type MonitorSession,
} from "./signalMonitor";

export function monitorWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Monitoring paused", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
interface MonitorRunnerOptions {
  controller: Pick<
    ReceiverController,
    "getSnapshot" | "scanTune" | "tune" | "stop" | "setVolume"
  >;
  pipeline: SpectrumMeasurementSource;
  startReception: () => Promise<ReceiverSnapshot>;
  volume: number;
  onUpdate: (session: MonitorSession) => void;
  onSpectrum?: (update: MonitorSpectrumUpdate) => void;
  signal: AbortSignal;
  measure?: typeof collectSpectrumMeasurement;
  wait?: typeof monitorWait;
  now?: () => number;
}
/** Uses the existing receiver and analysis subscription. No USB reader or unbounded samples. */
export async function runMonitor(
  initial: MonitorSession,
  options: MonitorRunnerOptions,
): Promise<MonitorSession> {
  const { controller, pipeline, signal, onUpdate } = options;
  const now = options.now ?? Date.now;
  const measure = options.measure ?? collectSpectrumMeasurement;
  const wait = options.wait ?? monitorWait;
  let session = {
    ...initial,
    status: "running" as MonitorSession["status"],
    message: "Monitoring…",
  };
  const original = controller.getSnapshot();
  let ownedGeneration: number | undefined;
  const checkAbort = () => {
    if (signal.aborted)
      throw new DOMException("Monitoring paused", "AbortError");
  };
  const publish = () => onUpdate(session);
  let displayIndex = initial.nextWindow;
  let displaySweep = initial.sweeps + 1;
  const spectrumPhase = (phase: MonitorSpectrumPhase) =>
    options.onSpectrum?.({
      sessionId: initial.id,
      windowIndex: displayIndex,
      sweep: displaySweep,
      at: now(),
      phase,
    });
  try {
    const originalSession = original.session;
    if (
      !originalSession ||
      monitorContext(
        initial.snapshot.profile,
        originalSession,
        initial.targets,
        initial.analysis,
      ) !== initial.context
    )
      throw new Error(
        "Receiver settings changed. Restore the original source/rate/gains/mode or start a new session.",
      );
    let active =
      original.lifecycle === "connected"
        ? await options.startReception()
        : original;
    ownedGeneration = active.session?.sessionGeneration;
    checkAbort();
    if (active.lifecycle !== "running" || !active.session)
      throw new Error("Start a compatible local receiver before monitoring.");
    if (
      monitorContext(
        initial.snapshot.profile,
        active.session,
        initial.targets,
        initial.analysis,
      ) !== initial.context
    )
      throw new Error(
        "Acquisition settings changed at Start; start a new monitoring session.",
      );
    controller.setVolume(0);
    // Extend compatible adaptive history in place; old IDs, baseline and cursor survive.
    session = alternatingMonitorSession(session);
    publish();
    const sweepIndices = monitorSweepIndices(session);
    let validThisSweep = sweepIndices
      .slice(0, sweepIndices.indexOf(session.nextWindow))
      .filter(
        (i) =>
          session.windows[i]!.lastSweep === session.sweeps &&
          session.windows[i]!.status === "complete",
      ).length;
    while (true) {
      checkAbort();
      const index = session.nextWindow;
      const region = session.windows[index]!;
      displayIndex = index;
      displaySweep = session.sweeps + 1;
      const band = session.snapshot.profile.bands.find(
        (b) => b.id === region.bandId,
      )!;
      active = controller.getSnapshot();
      if (
        active.lifecycle !== "running" ||
        !active.session ||
        active.session.sessionGeneration !== ownedGeneration ||
        monitorContext(
          session.snapshot.profile,
          active.session,
          session.targets,
          session.analysis,
        ) !== session.context
      )
        throw new Error(
          "Receiver changed or stopped; monitoring ended. Existing history is retained.",
        );
      session = {
        ...session,
        message: `Monitoring ${band.name} · ${monitorSweepPhase(session)} · window ${monitorSweepIndices(session).indexOf(index) + 1}/${monitorSweepIndices(session).length}`,
      };
      publish();
      let result;
      let measurement: SpectrumMeasurement | undefined;
      try {
        let tuned = active.session;
        if (tuned.hardwareCenterFrequencyHz !== region.plan.centerFrequencyHz) {
          spectrumPhase("tuning");
          const next = await controller.scanTune(region.plan.centerFrequencyHz);
          if (next) ownedGeneration = next.sessionGeneration;
          checkAbort();
          if (!next)
            throw new Error("Receiver could not tune the monitoring window.");
          tuned = next;
          ownedGeneration = tuned.sessionGeneration;
          await wait(120, signal);
        }
        checkAbort();
        spectrumPhase("measuring");
        const started = now();
        measurement = await measure(pipeline, {
          generation: tuned.sessionGeneration,
          centerFrequencyHz: tuned.hardwareCenterFrequencyHz,
          sampleRateHz: tuned.actualSampleRateHz,
          dwellMs: band.dwellMs,
          signal,
          ...(tuned.source === "bladerf" ? { noDataTimeoutMs: 5000 } : {}),
        });
        checkAbort();
        result = session.analysis
          ? analyzeMonitorWindow(
              region.plan,
              measurement,
              band.thresholdDb,
              band.detector,
              session.analysis,
            )
          : analyzeScanWindow(
              region.plan,
              measurement.frames,
              band.thresholdDb,
              band.detector,
              measurement,
              session.targets ? "capture" : "window",
            );
        // A browser/OS suspension cannot turn the unobserved interval into negative evidence.
        if (now() - started > Math.max(5000, band.dwellMs * 4)) {
          session = {
            ...session,
            status: "interrupted",
            message:
              "Acquisition was delayed or suspended. Resume manually; the gap is unobserved.",
          };
          break;
        }
      } catch (error) {
        checkAbort();
        result = failedScanWindow(region.plan, error);
      }
      if (result.status === "complete") validThisSweep++;
      options.onSpectrum?.({
        sessionId: initial.id,
        windowIndex: index,
        sweep: displaySweep,
        at: now(),
        phase: result.status === "complete" ? "complete" : "failed",
        ...(result.status === "complete" ? { points: result.points } : {}),
      });
      const measuredMs = measurement
        ? (Math.min(measurement.targetSamples, measurement.sourceSamples) /
            session.snapshot.receiver.actualSampleRateHz) *
          1000 *
          measurement.coverage
        : 0;
      const previousSweep = session.sweeps;
      session = recordMonitorVisit(
        session,
        index,
        result,
        measuredMs,
        new Date(now()).toISOString(),
      );
      publish();
      if (session.sweeps !== previousSweep) {
        if (!validThisSweep)
          throw new Error(
            "No monitoring window had valid sample coverage in this sweep. Check input and Resume.",
          );
        validThisSweep = 0;
      }
    }
  } catch (error) {
    session = {
      ...session,
      status: signal.aborted ? "paused" : "failed",
      message: signal.aborted
        ? "Monitoring paused. History retained; Resume continues this session."
        : error instanceof Error
          ? error.message
          : "Monitoring failed; history retained.",
    };
  } finally {
    spectrumPhase("idle");
    const current = controller.getSnapshot();
    // Never retune/restart a replacement or externally stopped source during cleanup.
    if (
      ownedGeneration !== undefined &&
      current.lifecycle === "running" &&
      current.session?.sessionGeneration === ownedGeneration &&
      original.session
    ) {
      try {
        if (
          current.session.hardwareCenterFrequencyHz !==
          original.session.hardwareCenterFrequencyHz
        )
          await controller.scanTune(original.session.hardwareCenterFrequencyHz);
        if (controller.getSnapshot().lifecycle === "running")
          await controller.tune(original.session.selectedChannelFrequencyHz);
        if (original.lifecycle === "connected") await controller.stop();
      } catch (error) {
        session = {
          ...session,
          status: "failed",
          message: `Monitoring cleanup failed: ${error instanceof Error ? error.message : "receiver unavailable"}`,
        };
      }
    }
    controller.setVolume(options.volume);
    session = { ...session, updatedAt: new Date(now()).toISOString() };
    publish();
  }
  return session;
}
