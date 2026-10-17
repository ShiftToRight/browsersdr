import { expect, it } from "vitest";
import { DEFAULT_SURVEY_PROFILE, type SurveyCandidateRecord } from "../radio/fieldSurvey";
import { surveyInvestigationMode } from "./surveyInvestigation";
it("suggests AM from the actual saved airband plan and avoids guesses for custom or changed ranges", () => {
  const record = {bandId:"airband", frequencyHz:125e6} as SurveyCandidateRecord;
  expect(surveyInvestigationMode(record, DEFAULT_SURVEY_PROFILE)).toBe("AM");
  expect(surveyInvestigationMode({...record, bandId:"custom"}, DEFAULT_SURVEY_PROFILE)).toBe("OFF");
  expect(surveyInvestigationMode(record)).toBe("OFF");
  const profile = structuredClone(DEFAULT_SURVEY_PROFILE);
  profile.bands.find(band => band.id === "airband")!.endFrequencyHz = 433e6;
  expect(surveyInvestigationMode(record, profile)).toBe("OFF");
});
