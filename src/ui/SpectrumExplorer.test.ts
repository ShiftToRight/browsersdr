// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurveyBand, SurveyCandidateRecord } from "../radio/fieldSurvey";
import type { ScanWindowResult } from "../radio/spectrumScan";
import {
  applyCapturedFrequencies,
  coarseSurveyBands,
  currentWindowSurveyBand,
  recordsForCompletedSurveyWindows,
  refinementSurveyBands,
  surveyStatusLabel,
  waitForSurveySettle,
} from "./SpectrumExplorer";

afterEach(() => vi.useRealTimers());

describe("Spectrum Explorer survey lifecycle", () => {
  const band: SurveyBand = {
    id: "edited",
    name: "Edited band",
    startFrequencyHz: 100_000_000,
    endFrequencyHz: 110_000_000,
    dwellMs: 500,
    thresholdDb: 8,
    detector: "max-hold",
    captureSeconds: 5,
  };

  it("plans a guarded current window and a faster coarse pass", () => {
    const session = {
      source: "bladerf",
      actualSampleRateHz: 2_400_000,
      hardwareCenterFrequencyHz: 105_000_000,
    } as NonNullable<import("../radio/types").SourceSessionMetadata>;
    expect(currentWindowSurveyBand(session, band)).toMatchObject({
      id: "current-window",
      startFrequencyHz: 104_040_000,
      endFrequencyHz: 105_960_000,
    });
    expect(coarseSurveyBands([band])[0]).toMatchObject({
      dwellMs: 150,
      thresholdDb: 11,
    });
    expect(band).toMatchObject({ dwellMs: 500, thresholdDb: 8 });
  });

  it("bounds and merges detailed regions around the strongest coarse candidates", () => {
    const candidates = [
      {
        bandId: band.id,
        frequencyHz: 103_000_000,
        peakDb: -40,
        noiseFloorDb: -90,
      },
      {
        bandId: band.id,
        frequencyHz: 103_100_000,
        peakDb: -45,
        noiseFloorDb: -90,
      },
      {
        bandId: "missing",
        frequencyHz: 500_000_000,
        peakDb: -20,
        noiseFloorDb: -90,
      },
    ] as SurveyCandidateRecord[];
    expect(refinementSurveyBands([band], candidates, 2_400_000)).toMatchObject([
      {
        id: band.id,
        startFrequencyHz: 102_160_000,
        endFrequencyHz: 103_940_000,
        dwellMs: 500,
      },
    ]);
  });

  it("distinguishes terminal run outcomes in the UI label", () => {
    expect(
      ["completed", "cancelled", "failed", "insufficient"].map((status) =>
        surveyStatusLabel(
          status as "completed" | "cancelled" | "failed" | "insufficient",
          false,
          false,
        ),
      ),
    ).toEqual(["completed", "cancelled", "failed", "insufficient"]);
    expect(surveyStatusLabel("cancelled", false, false, true)).toBe("paused");
  });

  it("makes settling cancellation immediate and clears its timer", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = waitForSurveySettle(10_000, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns each completed window into retained partial candidate records", () => {
    const candidateBand: SurveyBand = {
      id: "edited",
      name: "Edited band",
      startFrequencyHz: 100,
      endFrequencyHz: 200,
      dwellMs: 500,
      thresholdDb: 8,
      detector: "max-hold",
      captureSeconds: 5,
    };
    const result: ScanWindowResult = {
      plan: {
        index: 0,
        centerFrequencyHz: 150,
        lowerFrequencyHz: 100,
        upperFrequencyHz: 175,
      },
      points: [],
      noiseFloorDb: -90,
      frameCount: 3,
      coverage: 1,
      missingSamples: 0,
      status: "complete",
      candidates: [
        {
          frequencyHz: 140,
          peakDb: -40,
          noiseFloorDb: -90,
          bandwidthHz: 10,
          detector: "max-hold",
        },
      ],
    };
    expect(
      recordsForCompletedSurveyWindows([], candidateBand, [result]),
    ).toMatchObject([
      {
        frequencyHz: 140,
        bandId: "edited",
        bandName: "Edited band",
        selected: false,
        captured: false,
      },
    ]);
  });

  it("preserves completed candidate-capture progress when a later capture is cancelled", () => {
    const records = [
      { frequencyHz: 100, captured: false },
      { frequencyHz: 200, captured: false },
    ] as SurveyCandidateRecord[];
    expect(applyCapturedFrequencies(records, [100])).toMatchObject([
      { frequencyHz: 100, captured: true },
      { frequencyHz: 200, captured: false },
    ]);
  });
});
