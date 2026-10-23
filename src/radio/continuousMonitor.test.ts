import { describe, expect, it, vi } from "vitest";
import {
  ContinuousAnalysisQueue,
  runContinuousMonitor,
  type MonitorCycleProgress,
} from "./continuousMonitor";
import {
  createMonitorSession,
  validateMonitorSession,
  type MonitorSession,
} from "./signalMonitor";
import { runMonitor } from "./monitorRunner";
import type { ReceiverSnapshot } from "./receiverController";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import type { SignalAnalysisRecord } from "./signalAnalysis";
import type { SignalProbeResult } from "../dsp/signalIntelligence";

function fixture(connected = false) {
  const metadata: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: 1024000,
    actualSampleRateHz: 1024000,
    hardwareCenterFrequencyHz: 100e6,
    selectedChannelFrequencyHz: 100e6,
    mode: "OFF",
    channelBandwidthHz: 200000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  let snapshot: ReceiverSnapshot = {
    lifecycle: connected ? "connected" : "running",
    message: "Fixture",
    sessionGeneration: 1,
    session: metadata,
  };
  const replace = (s: ReceiverSnapshot) => {
    snapshot = s;
  };
  const controller = {
    getSnapshot: () => snapshot,
    scanTune: vi.fn(async (hz: number) => {
      const generation = snapshot.sessionGeneration + 1;
      snapshot = {
        ...snapshot,
        sessionGeneration: generation,
        session: {
          ...snapshot.session!,
          hardwareCenterFrequencyHz: hz,
          selectedChannelFrequencyHz: hz,
          sessionGeneration: generation,
        },
      };
      return snapshot.session;
    }),
    tune: vi.fn(async (hz: number) => {
      snapshot = {
        ...snapshot,
        session: { ...snapshot.session!, selectedChannelFrequencyHz: hz },
      };
    }),
    stop: vi.fn(async () => {
      const generation = snapshot.sessionGeneration + 1;
      snapshot = {
        ...snapshot,
        lifecycle: "connected",
        sessionGeneration: generation,
        session: { ...snapshot.session!, sessionGeneration: generation },
      };
    }),
    setVolume: vi.fn(),
  };
  const startReception = vi.fn(async () => {
    snapshot = { ...snapshot, lifecycle: "running" };
    return snapshot;
  });
  const initial = createMonitorSession(
    {
      version: 1,
      name: "Cycle fixture",
      site: { label: "Test" },
      bands: [
        {
          id: "test",
          name: "Test",
          startFrequencyHz: 99.7e6,
          endFrequencyHz: 100.3e6,
          dwellMs: 150,
          thresholdDb: 6,
          detector: "average",
          captureSeconds: 2,
        },
      ],
    },
    metadata,
    undefined,
    undefined,
    { version: 2, preset: "general" },
  );
  const abort = new AbortController();
  const measure = vi.fn(async (_pipeline, options) => {
    const bins = new Float32Array(4096).fill(-100);
    for (let i = 0; i < 4096; i++) {
      const hz = options.centerFrequencyHz + (i - 2048) * 250;
      if (Math.abs(hz - 99.85e6) < 40000 || Math.abs(hz - 100.15e6) < 40000)
        bins[i] = -40;
    }
    return {
      frames: [
        {
          bins,
          centerFrequencyHz: options.centerFrequencyHz,
          sampleRateHz: options.sampleRateHz,
        } as SpectrumFrame,
      ],
      targetSamples: 153600,
      sourceSamples: 153600,
      missingSamples: 0,
      coverage: 1,
      status: "complete" as const,
    };
  });
  const pipeline = {
    subscribeMeasurements: () => () => {},
    analyzeSignal: vi.fn(
      async () =>
        ({
          version: 1,
          status: "inconclusive",
          label: "Unknown signal",
          sampledSeconds: 2,
          resolutionHz: 62.5,
          frequencyHz: 99.85e6,
          discontinuities: 0,
          pilotObserved: false,
          pilotFraction: 0,
          reasons: [],
          stableProgrammeService: null,
          rds: {
            validGroups: 0,
            pi: null,
            programmeService: null,
            radioText: null,
          },
        }) as SignalProbeResult,
    ),
  };
  const records: SignalAnalysisRecord[] = [];
  const phases: MonitorCycleProgress[] = [];
  const updates: MonitorSession[] = [];
  const options = {
    controller,
    pipeline,
    startReception,
    volume: 0.4,
    measure,
    wait: async () => {},
    signal: abort.signal,
    analyze: true,
    seconds: 12,
    records,
    onRecord: (r: SignalAnalysisRecord) => {
      records.push(r);
    },
    onActivity: vi.fn(),
    onCycle: (p: MonitorCycleProgress) => {
      phases.push(p);
    },
    onUpdate: (s: MonitorSession) => {
      updates.push(s);
      if (s.sweeps >= 8) abort.abort();
    },
  };
  return {
    initial,
    options,
    abort,
    records,
    phases,
    updates,
    controller,
    pipeline,
    measure,
    replace,
  };
}

describe("continuous discovery and analysis", () => {
  it("releases its own activation if the accepted rate makes the retained history incompatible", async () => {
    const x = fixture(true);
    x.options.startReception.mockImplementation(async () => {
      const s = x.controller.getSnapshot();
      const active: ReceiverSnapshot = {
        ...s,
        lifecycle: "running",
        session: { ...s.session!, actualSampleRateHz: 2048000 },
      };
      x.replace(active);
      return active;
    });
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.status).toBe("failed");
    expect(x.controller.getSnapshot().lifecycle).toBe("connected");
    expect(x.controller.stop).toHaveBeenCalledTimes(1);
    expect(x.measure).not.toHaveBeenCalled();
  });
  it("never adopts an identically configured replacement returned during activation", async () => {
    const x = fixture(true);
    x.options.startReception.mockImplementation(async () => {
      const s = x.controller.getSnapshot();
      await Promise.resolve();
      const active: ReceiverSnapshot = {
        ...s,
        lifecycle: "running",
        sessionGeneration: 999,
        session: { ...s.session!, sessionGeneration: 999 },
      };
      x.replace(active);
      return active;
    });
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.status).toBe("failed");
    expect(x.controller.stop).not.toHaveBeenCalled();
    expect(x.controller.setVolume).not.toHaveBeenCalled();
  });
  it("collects three initial sweeps, probes one candidate, sweeps again, then probes the next without changing history", async () => {
    const x = fixture(true);
    const analysisSweeps: number[] = [];
    x.options.onCycle = (p) => {
      x.phases.push(p);
      if (p.phase === "analysis" && x.phases.at(-2)?.phase !== "analysis")
        analysisSweeps.push(x.updates.at(-1)!.sweeps);
      if (p.analyzed === 2) x.abort.abort();
    };
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(analysisSweeps).toEqual([3, 4]);
    expect(x.pipeline.analyzeSignal).toHaveBeenCalledTimes(2);
    expect(x.records).toHaveLength(2);
    expect(new Set(x.records.map((r) => r.candidate.id)).size).toBe(2);
    expect(final.status).toBe("paused");
    expect(final.id).toBe(x.initial.id);
    expect(final.context).toBe(x.initial.context);
    expect(validateMonitorSession(final)).toEqual(final);
    expect(x.controller.getSnapshot().lifecycle).toBe("connected");
    expect(x.controller.getSnapshot().session!.selectedChannelFrequencyHz).toBe(
      100e6,
    );
  });
  it("keeps discovery-only mode running without probes", async () => {
    const x = fixture();
    x.options.analyze = false;
    x.options.onUpdate = (s) => {
      if (s.sweeps === 5) x.abort.abort();
    };
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.sweeps).toBe(5);
    expect(final.status).toBe("paused");
    expect(x.pipeline.analyzeSignal).not.toHaveBeenCalled();
  });
  it("continues discovery when there are no candidates", async () => {
    const x = fixture();
    x.measure.mockImplementation(async (_pipeline, o) => ({
      frames: [
        {
          bins: new Float32Array(4096).fill(-100),
          centerFrequencyHz: o.centerFrequencyHz,
          sampleRateHz: o.sampleRateHz,
        } as SpectrumFrame,
      ],
      targetSamples: 153600,
      sourceSamples: 153600,
      missingSamples: 0,
      coverage: 1,
      status: "complete",
    }));
    x.options.onUpdate = (s) => {
      if (s.sweeps === 6) x.abort.abort();
    };
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.sweeps).toBe(6);
    expect(final.signals).toHaveLength(0);
    expect(x.pipeline.analyzeSignal).not.toHaveBeenCalled();
  });
  it("pause during a probe waits for restoration and never starts another discovery slice", async () => {
    const x = fixture(true);
    x.pipeline.analyzeSignal.mockImplementation(async () => {
      x.abort.abort();
      throw new DOMException("Paused", "AbortError");
    });
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.status).toBe("paused");
    expect(final.sweeps).toBe(3);
    expect(x.records).toHaveLength(0);
    expect(x.controller.getSnapshot().lifecycle).toBe("connected");
    expect(x.pipeline.analyzeSignal).toHaveBeenCalledTimes(1);
  });
  it("does not restore or resume an identically configured replacement source during analysis", async () => {
    const x = fixture();
    x.pipeline.analyzeSignal.mockImplementation(async () => {
      const s = x.controller.getSnapshot();
      x.replace({
        ...s,
        sessionGeneration: 999,
        session: { ...s.session!, sessionGeneration: 999 },
      });
      return { version: 1, label: "Unknown signal" } as SignalProbeResult;
    });
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.status).toBe("failed");
    expect(final.sweeps).toBe(3);
    expect(x.controller.getSnapshot().sessionGeneration).toBe(999);
    expect(x.controller.tune).toHaveBeenCalledTimes(1); // Discovery restoration only.
    expect(x.options.startReception).not.toHaveBeenCalled();
    expect(x.controller.stop).not.toHaveBeenCalled();
  });
  it("requires a verified release before analysis when a replacement arrives during discovery cleanup", async () => {
    const x = fixture(true);
    x.controller.tune.mockImplementation(async () => {
      const s = x.controller.getSnapshot();
      await Promise.resolve();
      x.replace({
        ...s,
        lifecycle: "running",
        sessionGeneration: 999,
        session: { ...s.session!, sessionGeneration: 999 },
      });
    });
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.status).toBe("failed");
    expect(x.pipeline.analyzeSignal).not.toHaveBeenCalled();
    expect(x.options.startReception).toHaveBeenCalledTimes(1);
  });
  it("retains a failed probe and continues to the next candidate after another sweep", async () => {
    const x = fixture();
    x.pipeline.analyzeSignal.mockRejectedValueOnce(
      new Error("Probe inconclusive"),
    );
    x.options.onCycle = (p) => {
      if (p.analyzed === 2) x.abort.abort();
    };
    const final = await runContinuousMonitor(x.initial, x.options);
    expect(final.sweeps).toBe(4);
    expect(x.records[0]!.error).toBe("Probe inconclusive");
    expect(x.records[1]!.result).toBeDefined();
  });
  it("resumes established history with one sweep, preserving its alternating cursor", async () => {
    const x = fixture();
    const history = await runMonitor(x.initial, {
      ...x.options,
      stopAfterSweeps: 6,
    });
    const cursor = history.nextWindow;
    x.options.onCycle = (p) => {
      if (p.analyzed === 1) x.abort.abort();
    };
    const final = await runContinuousMonitor(history, x.options);
    expect(final.sweeps).toBe(7);
    expect(final.id).toBe(history.id);
    expect(final.signals.map((s) => s.id)).toEqual(
      history.signals.map((s) => s.id),
    );
    expect(cursor).toBeDefined();
    expect(final.sweepPattern).toEqual(history.sweepPattern);
  });
});

describe("bounded fair analysis queue", () => {
  it("reuses fresh evidence, rechecks changed geometry and delays unknown retries", async () => {
    const x = fixture();
    const session = await runMonitor(x.initial, {
      ...x.options,
      stopAfterSweeps: 1,
    });
    const queue = new ContinuousAnalysisQueue(),
      time = Date.now();
    const first = queue.select(session, [], time);
    expect(first.pending).toBe(2);
    const records = session.signals.map((s) => ({
      candidate: {
        id: s.id,
        frequencyHz: s.frequencyHz,
        bandwidthHz: s.bandwidthHz,
        aboveNoiseDb: s.peakDb - s.noiseFloorDb,
      },
      at: new Date(time).toISOString(),
      result: { version: 1, label: "Unknown signal" } as SignalProbeResult,
    }));
    expect(queue.select(session, records, time + 59000).pending).toBe(0);
    session.signals[0]!.peakDb += 7;
    expect(queue.select(session, records, time + 59001).candidate!.id).toBe(
      session.signals[0]!.id,
    );
    session.signals[0]!.peakDb -= 7;
    expect(queue.select(session, records, time + 60000).pending).toBe(2);
    session.signals[1]!.bandwidthHz *= 2;
    expect(queue.select(session, records, time + 1000).candidate!.id).toBe(
      session.signals[1]!.id,
    );
    records.forEach((r) => {
      r.result!.suggestedMode = "WBFM";
    });
    session.signals[1]!.bandwidthHz /= 2;
    expect(queue.select(session, records, time + 299000).pending).toBe(0);
    expect(queue.select(session, records, time + 300000).pending).toBe(2);
  });
  it("ages a stale waiting job ahead of a newly arrived candidate and excludes absent history", async () => {
    const x = fixture();
    const session = await runMonitor(x.initial, {
      ...x.options,
      stopAfterSweeps: 1,
    });
    const time = Date.now(),
      queue = new ContinuousAnalysisQueue();
    const records = session.signals.map((s) => ({
      candidate: {
        id: s.id,
        frequencyHz: s.frequencyHz,
        bandwidthHz: s.bandwidthHz,
      },
      at: new Date(time - 60000).toISOString(),
    }));
    queue.select(session, records, time);
    session.signals.push({
      ...session.signals[0]!,
      id: "new",
      frequencyHz: 100.2e6,
      firstSeen: new Date(time + 180000).toISOString(),
    });
    expect(
      queue.select(session, records, time + 180000).candidate!.id,
    ).not.toBe("new");
    session.signals.forEach((s) => {
      s.misses = 1;
    });
    expect(queue.select(session, records, time + 180001).pending).toBe(0);
  });
});
