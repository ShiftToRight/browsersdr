import { describe, expect, it, vi } from "vitest";
import {
  analyzeCandidates,
  analysisContext,
  retainAnalysisEvidence,
} from "./signalAnalysis";
import type { ReceiverSnapshot } from "./receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SignalProbeResult } from "../dsp/signalIntelligence";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

function fixture(initiallyConnected = false) {
  let snapshot = {
    lifecycle: initiallyConnected ? "connected" : "running",
    session: { ...SYNTHETIC_DEMO_SESSION, sessionGeneration: 1 },
  } as ReceiverSnapshot;
  const controller = {
    getSnapshot: () => snapshot,
    scanTune: vi.fn(async (hz: number) => {
      snapshot = {
        ...snapshot,
        session: {
          ...snapshot.session!,
          hardwareCenterFrequencyHz: hz,
          selectedChannelFrequencyHz: hz,
          sessionGeneration: snapshot.session!.sessionGeneration + 1,
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
    setVolume: vi.fn(),
    stop: vi.fn(async () => {
      snapshot = { ...snapshot, lifecycle: "connected" };
    }),
  };
  const pipeline = {
    analyzeSignal: vi.fn(
      async () =>
        ({ version: 1, label: "Unknown signal" }) as SignalProbeResult,
    ),
  };
  const startReception = vi.fn(async () => {
    snapshot = { ...snapshot, lifecycle: "running" };
    return snapshot;
  });
  return {
    controller,
    pipeline,
    startReception,
    replace: (next: ReceiverSnapshot) => {
      snapshot = next;
    },
  };
}
const candidates = [
  { id: "a", frequencyHz: 100.125e6, bandwidthHz: 180e3 },
  { id: "b", frequencyHz: 99.77e6, bandwidthHz: 2000 },
];
describe("candidate analysis receiver ownership", () => {
  it("keeps dated decoded evidence when a later visit is inconclusive", () => {
    const strong = {
      candidate: candidates[0]!,
      at: "2026-10-21T20:00:00Z",
      result: {
        stableProgrammeService: "TEST FM",
        label: "RDS: TEST FM",
      } as SignalProbeResult,
    };
    const next = {
      candidate: candidates[0]!,
      at: "2026-10-21T20:01:00Z",
      error: "Signal absent during visit",
    };
    const retained = retainAnalysisEvidence([strong], next);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      ...next,
      previousEvidence: { at: strong.at, result: strong.result },
    });
    expect(strong).not.toHaveProperty("previousEvidence");
  });
  it("publishes tuning, accepted capture, acquired progress and clears activity before restoration", async () => {
    const f = fixture();
    const activity = vi.fn();
    const pipeline: Pick<AnalysisPipeline, "analyzeSignal"> = {
      analyzeSignal: vi.fn(async (_config, _signal, progress) => {
        progress?.(1.25);
        return { version: 1, label: "Unknown signal" } as SignalProbeResult;
      }),
    };
    await analyzeCandidates([candidates[0]!], {
      ...f,
      pipeline,
      seconds: 12,
      volume: 0.5,
      signal: new AbortController().signal,
      wait: async () => {},
      onResult: vi.fn(),
      onProgress: vi.fn(),
      onActivity: activity,
    });
    expect(activity.mock.calls.map(([a]) => a?.phase)).toEqual([
      "tuning",
      "settling",
      "measuring",
      "measuring",
      undefined,
    ]);
    expect(activity.mock.calls[0]![0].acquisition.sessionGeneration).toBe(1);
    expect(
      activity.mock.calls[0]![0].acquisition.hardwareCenterFrequencyHz,
    ).toBe(100e6);
    const measured = activity.mock.calls[3]![0];
    expect(measured).toMatchObject({
      acquiredSeconds: 1.25,
      budgetSeconds: 12,
      index: 0,
      total: 1,
      candidate: candidates[0],
    });
    expect(measured.acquisition.hardwareCenterFrequencyHz).not.toBe(
      candidates[0]!.frequencyHz,
    );
    expect(measured.acquisition.sessionGeneration).toBe(2);
  });
  it("clears the candidate marker on cancellation during settling", async () => {
    const f = fixture(),
      cancellation = new AbortController(),
      activity = vi.fn();
    await expect(
      analyzeCandidates(candidates, {
        ...f,
        seconds: 12,
        volume: 0.5,
        signal: cancellation.signal,
        wait: async () => {
          cancellation.abort();
        },
        onResult: vi.fn(),
        onProgress: vi.fn(),
        onActivity: activity,
      }),
    ).rejects.toThrow();
    expect(activity.mock.calls.map(([a]) => a?.phase)).toEqual([
      "tuning",
      "settling",
      undefined,
    ]);
    expect(f.pipeline.analyzeSignal).not.toHaveBeenCalled();
  });
  it("visits all candidates in frequency order, uses bounded budgets and restores original center/channel/volume", async () => {
    const f = fixture(true),
      records = vi.fn();
    await analyzeCandidates(candidates, {
      ...f,
      seconds: 12,
      volume: 0.6,
      signal: new AbortController().signal,
      wait: async () => {},
      onResult: records,
      onProgress: vi.fn(),
    });
    expect(records.mock.calls.map(([r]) => r.candidate.id)).toEqual(["b", "a"]);
    expect(
      f.pipeline.analyzeSignal.mock.calls.map(
        (call) => (call as unknown as [{ seconds: number }])[0].seconds,
      ),
    ).toEqual([2, 12]);
    expect(f.controller.getSnapshot().session).toMatchObject({
      hardwareCenterFrequencyHz: 100e6,
      selectedChannelFrequencyHz: 100.125e6,
    });
    expect(f.controller.setVolume.mock.calls).toEqual([[0], [0.6]]);
    expect(f.controller.stop).toHaveBeenCalledOnce();
  });
  it("retains a per-candidate failure and continues the queue", async () => {
    const f = fixture(),
      records = vi.fn();
    f.pipeline.analyzeSignal.mockRejectedValueOnce(new Error("No samples"));
    await analyzeCandidates(candidates, {
      ...f,
      seconds: 12,
      volume: 0.6,
      signal: new AbortController().signal,
      wait: async () => {},
      onResult: records,
      onProgress: vi.fn(),
    });
    expect(records).toHaveBeenCalledTimes(2);
    expect(records.mock.calls[0]![0].error).toBe("No samples");
    expect(f.controller.stop).not.toHaveBeenCalled();
  });
  it("cancels without visiting the remaining candidates and restores owned reception", async () => {
    const f = fixture(),
      cancellation = new AbortController();
    await expect(
      analyzeCandidates(candidates, {
        ...f,
        seconds: 12,
        volume: 0.6,
        signal: cancellation.signal,
        wait: async () => {
          cancellation.abort();
        },
        onResult: vi.fn(),
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.pipeline.analyzeSignal).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().session?.hardwareCenterFrequencyHz).toBe(
      100e6,
    );
  });
  it("never restores or stops a replacement receiver generation", async () => {
    const f = fixture();
    await expect(
      analyzeCandidates(candidates, {
        ...f,
        seconds: 12,
        volume: 0.6,
        signal: new AbortController().signal,
        wait: async () => {
          f.replace({
            ...f.controller.getSnapshot(),
            session: { ...SYNTHETIC_DEMO_SESSION, sessionGeneration: 999 },
          });
        },
        onResult: vi.fn(),
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow("settings changed");
    expect(f.controller.scanTune).toHaveBeenCalledTimes(1);
    expect(f.controller.stop).not.toHaveBeenCalled();
  });
  it("acquisition comparison ignores tuned frequency but retains rate and gain", () => {
    const base = SYNTHETIC_DEMO_SESSION;
    expect(analysisContext(base)).toBe(
      analysisContext({
        ...base,
        hardwareCenterFrequencyHz: 90e6,
        selectedChannelFrequencyHz: 90e6,
        sessionGeneration: 999,
      }),
    );
    expect(analysisContext(base)).not.toBe(
      analysisContext({ ...base, actualSampleRateHz: 2.4e6 }),
    );
    expect(analysisContext(base)).not.toBe(
      analysisContext({ ...base, gainDb: 10 }),
    );
  });
});
