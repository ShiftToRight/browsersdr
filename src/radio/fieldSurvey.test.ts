import { hackrfRecordingFixture } from "../testing/hackrfRecordingFixture";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURVEY_PROFILE,
  createSurveyManifest,
  createSurveyRunSnapshot,
  parseSurveyProfile,
  surveyManifestCsv,
  surveyProfileJson,
  validateSurveyProfile,
  type SurveyManifest,
} from "./fieldSurvey";

describe("field survey profiles", () => {
  it("freezes effective settings, site and receiver provenance at acquisition start", () => {
    const profile = structuredClone(DEFAULT_SURVEY_PROFILE);
    const effectiveBand = { ...profile.bands[0]!, startFrequencyHz: 99_500_000, endFrequencyHz: 99_900_000, dwellMs: 775, thresholdDb: 17 };
    const metadata = {
      source: "synthetic" as const, sessionGeneration: 9, requestedSampleRateHz: 1_024_000, actualSampleRateHz: 1_024_000,
      hardwareCenterFrequencyHz: 99_700_000, selectedChannelFrequencyHz: 99_700_000, mode: "WBFM" as const,
      channelBandwidthHz: 150_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized" as const,
    };
    const snapshot = createSurveyRunSnapshot(profile, [effectiveBand], metadata, "2026-09-23T10:00:00.000Z", "survey-frozen");
    profile.site.label = "Edited later";
    profile.bands[0]!.dwellMs = 150;
    effectiveBand.thresholdDb = 1;
    metadata.actualSampleRateHz = 2_400_000;
    const manifest = createSurveyManifest(snapshot, "cancelled", [], "2026-09-23T10:00:05.000Z");
    expect(manifest).toMatchObject({
      sessionId: "survey-frozen", status: "cancelled",
      profile: { site: { label: "Unnamed site" }, bands: [{ startFrequencyHz: 99_500_000, endFrequencyHz: 99_900_000, dwellMs: 775, thresholdDb: 17 }] },
      receiver: { sampleRateHz: 1_024_000, metadata: { actualSampleRateHz: 1_024_000, sessionGeneration: 9 } },
    });
  });

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
      status: "completed",
      profile: DEFAULT_SURVEY_PROFILE,
      receiver: { sampleRateHz: 2_400_000, source: "rtl-sdr", levels: "relative-dB-uncalibrated", metadata: {
        source: "rtl-sdr", sessionGeneration: 1, requestedSampleRateHz: 2_400_000, actualSampleRateHz: 2_400_000,
        hardwareCenterFrequencyHz: 1_090_000_000, selectedChannelFrequencyHz: 1_090_000_000,
        mode: "AM", channelBandwidthHz: 2_000_000, squelch: 0, gainDb: 20, sampleFormat: "planar-f32-iq-normalized",
      } },
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


it("snapshots nested HackRF identity and accepted stages independently of later retunes", async () => {
  const { session } = await hackrfRecordingFixture();
  const snapshot = createSurveyRunSnapshot(DEFAULT_SURVEY_PROFILE, DEFAULT_SURVEY_PROFILE.bands, session);
  session.hackrf.captureSettings.rxVgaGainDb = 62;
  session.hackrf.capabilities.identity.firmwareVersion = "changed";
  const manifest = createSurveyManifest(snapshot, "completed", []);
  expect(manifest.receiver.metadata.hackrf?.captureSettings.rxVgaGainDb).toBe(12);
  expect(manifest.receiver.metadata.hackrf?.capabilities.identity.firmwareVersion).toBe("fixture-unvalidated");
  expect(manifest.receiver.source).toBe("hackrf");
  manifest.receiver.metadata.hackrf!.captureSettings.rxVgaGainDb = 2;
  expect(snapshot.receiver.hackrf?.captureSettings.rxVgaGainDb).toBe(12);
});
