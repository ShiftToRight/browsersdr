import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURVEY_PROFILE,
  parseSurveyProfile,
  surveyManifestCsv,
  surveyProfileJson,
  validateSurveyProfile,
  type SurveyManifest,
} from "./fieldSurvey";

describe("field survey profiles", () => {
  it("round-trips the portable default profile", () => {
    expect(parseSurveyProfile(surveyProfileJson(DEFAULT_SURVEY_PROFILE))).toEqual(DEFAULT_SURVEY_PROFILE);
  });

  it("rejects unsafe or ambiguous site and band values", () => {
    expect(() => validateSurveyProfile({ ...DEFAULT_SURVEY_PROFILE, site: { label: "", latitude: 100 } })).toThrow();
    expect(() => validateSurveyProfile({ ...DEFAULT_SURVEY_PROFILE, bands: [{ ...DEFAULT_SURVEY_PROFILE.bands[0], dwellMs: 20 }] })).toThrow();
  });

  it("exports stable CSV rows with signal annotations", () => {
    const manifest: SurveyManifest = {
      version: 1,
      sessionId: "survey-test",
      startedAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:01:00.000Z",
      profile: DEFAULT_SURVEY_PROFILE,
      receiver: { sampleRateHz: 2_400_000, source: "rtl-sdr", levels: "relative-dB-uncalibrated" },
      candidates: [{
        bandId: "adsb-1090", bandName: "1090 MHz transponders", frequencyHz: 1_090_000_000,
        peakDb: -20, noiseFloorDb: -50, bandwidthHz: 2_000_000, detector: "max-hold", occupancy: 0.1,
        selected: true, captured: false, annotation: { label: "ADS-B", modulation: "PPM", encoding: "Mode S", confidence: "medium" },
      }],
    };
    const csv = surveyManifestCsv(manifest);
    expect(csv).toContain("survey-test");
    expect(csv).toContain("ADS-B,PPM,Mode S,medium");
  });
});
