import { afterEach, expect, it, vi } from "vitest";
import {
  coalescedWriter,
  loadLatestSurveyRun,
  saveLatestSurveyRun,
  type PersistedSurveyRun,
} from "./surveyStorage";
import { validatePersistedSurveyRun } from "./surveyStorageValidation";
import { DEFAULT_SURVEY_PROFILE } from "./fieldSurvey";

function fixture(): PersistedSurveyRun {
  return {
    version: 1,
    key: "latest",
    savedAt: "2026-10-12T00:00:00Z",
    scope: "window",
    status: "running",
    snapshot: {
      sessionId: "test",
      startedAt: "2026-10-12T00:00:00Z",
      profile: structuredClone(DEFAULT_SURVEY_PROFILE),
      receiver: {
        source: "synthetic",
        mode: "OFF",
        sessionGeneration: 1,
        requestedSampleRateHz: 1024000,
        actualSampleRateHz: 1024000,
        hardwareCenterFrequencyHz: 100000000,
        selectedChannelFrequencyHz: 100000000,
        channelBandwidthHz: 0,
        squelch: 0,
        gainDb: null,
        sampleFormat: "planar-f32-iq-normalized",
      },
    },
    windows: [],
    records: [],
    progress: { completed: 0, total: 1 },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("coalesces slow writes to one active and latest pending, including final status", async () => {
  const written: number[] = [];
  let finish!: () => void;
  const save = coalescedWriter<number>(async (value) => {
    written.push(value);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const pending = save(0);
  await Promise.resolve();
  for (let i = 1; i <= 1000; i++) expect(save(i)).toBe(pending);
  expect(written).toEqual([0]);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(written).toEqual([0, 1000]);
  finish();
  await pending;
});
it("reports quota failure and permits a subsequent successful save", async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Quota", "QuotaExceededError"))
    .mockResolvedValue(undefined);
  const save = coalescedWriter(write);
  await expect(save(fixture())).rejects.toThrow("Quota");
  await expect(save(fixture())).resolves.toBeUndefined();
});
it.each(["blocked", "timeout"])(
  "reports %s IndexedDB open and closes late success",
  async (kind) => {
    vi.useFakeTimers();
    const close = vi.fn();
    const request = {
      result: { close },
      onblocked: () => {},
      onsuccess: () => {},
    };
    vi.stubGlobal("indexedDB", { open: () => request });
    const result = loadLatestSurveyRun();
    const assertion = expect(result).rejects.toThrow(/blocked|timed out/);
    if (kind === "blocked") request.onblocked();
    else await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    request.onsuccess();
    expect(close).toHaveBeenCalledOnce();
  },
);
it("does not pretend unavailable storage saved results", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(saveLatestSurveyRun(fixture())).rejects.toThrow("unavailable");
});
it("accepts a valid old run and rejects malformed nested content before application", () => {
  expect(
    validatePersistedSurveyRun(fixture()).snapshot.profile.bands.length,
  ).toBe(6);
  for (const mutate of [
    (run: PersistedSurveyRun) => {
      run.snapshot.profile.bands = [];
    },
    (run: PersistedSurveyRun) => {
      run.snapshot.receiver.actualSampleRateHz = NaN;
    },
    (run: PersistedSurveyRun) => {
      run.progress.completed = 2;
    },
    (run: PersistedSurveyRun) => {
      run.windows = [{} as never];
    },
    (run: PersistedSurveyRun) => {
      run.records = [{} as never];
    },
  ]) {
    const run = fixture();
    mutate(run);
    expect(() => validatePersistedSurveyRun(run)).toThrow();
  }
});

it("restores full FFT windows rather than mistaking the chart's point limit for storage schema", () => {
  const run = fixture();
  run.windows = [
    {
      plan: {
        index: 0,
        centerFrequencyHz: 100000000,
        lowerFrequencyHz: 99500000,
        upperFrequencyHz: 100500000,
      },
      points: Array.from({ length: 3073 }, (_, i) => ({
        frequencyHz: 99500000 + i * 250,
        powerDb: -80,
      })),
      candidates: [],
      noiseFloorDb: -100,
      frameCount: 10,
      coverage: 1,
      missingSamples: 0,
      status: "complete",
    },
  ];
  expect(validatePersistedSurveyRun(run).windows[0]!.points).toHaveLength(3073);
});
