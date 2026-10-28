import {
  isAirspyRate,
  validateAirspySettings,
  type AirspySessionDetails,
} from "./airspySettings";
export const AIRSPY_RECORDING_FORMAT = "browsersdr-airspy-ci16-v1" as const;
export interface AirspyRecordingFormat {
  format: typeof AIRSPY_RECORDING_FORMAT;
  sampleEncoding: "signed-16-bit-little-endian";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 4;
  normalization: "float = int16 / 32768";
  airspy: AirspySessionDetails;
  hardware?: never;
  gainDb?: never;
  provenanceDetails: {
    originalSource: "airspy";
    datasetProcessing: "airspy-fs4-real-to-iq-v1";
  };
}
export function airspyRecordingFormat(
  details: AirspySessionDetails,
): AirspyRecordingFormat {
  return {
    format: AIRSPY_RECORDING_FORMAT,
    sampleEncoding: "signed-16-bit-little-endian",
    sampleOrder: "interleaved-iq",
    bytesPerComplexSample: 4,
    normalization: "float = int16 / 32768",
    airspy: structuredClone(details),
    provenanceDetails: {
      originalSource: "airspy",
      datasetProcessing: "airspy-fs4-real-to-iq-v1",
    },
  };
}
export function validateAirspyRecording(
  format: AirspyRecordingFormat,
  source: string,
  rate: number,
  center: number,
): void {
  const d = format.airspy;
  if (!d || !d.identity || !Array.isArray(d.identity.sampleRates))
    throw new Error("Missing Airspy acquisition provenance.");
  validateAirspySettings(d.settings);
  if (
    !["airspy", "replay"].includes(source) ||
    format.normalization !== "float = int16 / 32768" ||
    format.sampleEncoding !== "signed-16-bit-little-endian" ||
    format.bytesPerComplexSample !== 4 ||
    format.sampleOrder !== "interleaved-iq" ||
    !isAirspyRate(rate) ||
    d.outputSampleRateHz !== rate ||
    d.deviceSampleRateHz / d.settings.decimation !== rate ||
    d.adcSampleRateHz !== d.deviceSampleRateHz * 2 ||
    !d.identity.sampleRates.includes(d.deviceSampleRateHz) ||
    d.requestedCenterFrequencyHz !== center ||
    d.correctedDeviceFrequencyHz !==
      Math.round(center * (1 + d.settings.ppm / 1e6)) ||
    d.rateEvidence !== "firmware-advertised-and-usb-acknowledged" ||
    d.conversion !== "airspy-fs4-real-to-iq-v1" ||
    format.provenanceDetails?.originalSource !== "airspy" ||
    format.provenanceDetails.datasetProcessing !== "airspy-fs4-real-to-iq-v1"
  )
    throw new Error("Invalid Airspy converted-I/Q provenance.");
}
