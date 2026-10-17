import { DEFAULT_SURVEY_PROFILE, type SurveyCandidateRecord, type SurveyProfile } from "../radio/fieldSurvey";
import type { ReceiverMode } from "../radio/receiverConfig";

const bandModes: Record<string, ReceiverMode> = {
  "fm-broadcast": "WBFM", airband: "AM", "dab-band-iii": "DAB",
  "srd-433": "SRD", "srd-868": "SRD", "adsb-1090": "ADS-B",
};
/** A listening suggestion from the actual survey plan, never detected modulation or identity. */
export function surveyInvestigationMode(record: SurveyCandidateRecord, profile?: SurveyProfile): ReceiverMode {
  const band = profile?.bands.find(item => item.id === record.bandId);
  const known = DEFAULT_SURVEY_PROFILE.bands.find(item => item.id === record.bandId);
  if (!band || !known || band.startFrequencyHz < known.startFrequencyHz || band.endFrequencyHz > known.endFrequencyHz ||
      record.frequencyHz < band.startFrequencyHz || record.frequencyHz > band.endFrequencyHz) return "OFF";
  return bandModes[known.id] ?? "OFF";
}
