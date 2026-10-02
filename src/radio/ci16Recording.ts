import {
  validateUsrpB205SessionDetails,
  type UsrpB205SessionDetails,
} from "./usrpB205Capabilities";

export const CI16_RECORDING_FORMAT = "browsersdr-ci16-v1" as const;
export const CI16_NORMALIZATION =
  "float = int16 * 0.9999997558594347 / 32767" as const;

export interface UsrpB205Ci16RecordingFormat {
  format: typeof CI16_RECORDING_FORMAT;
  sampleEncoding: "signed-16-bit-little-endian";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 4;
  normalization: typeof CI16_NORMALIZATION;
  nativeSampleRateHz: number;
  rateEvidence: "ddc-calculated";
  hardware: UsrpB205SessionDetails;
  provenanceDetails: {
    originalSource: "usrp-b205";
    datasetProcessing: "native-q-i-words-reordered-to-i-q";
    timestampBasis: "host-record-command";
    hardwareValidation: "pending";
  };
}

export function usrpB205Ci16RecordingFormat(
  details: UsrpB205SessionDetails,
): UsrpB205Ci16RecordingFormat {
  validateUsrpB205SessionDetails(details);
  return {
    format: CI16_RECORDING_FORMAT,
    sampleEncoding: "signed-16-bit-little-endian",
    sampleOrder: "interleaved-iq",
    bytesPerComplexSample: 4,
    normalization: CI16_NORMALIZATION,
    nativeSampleRateHz: details.nativeSampleRateHz,
    rateEvidence: "ddc-calculated",
    hardware: structuredClone(details),
    provenanceDetails: {
      originalSource: "usrp-b205",
      datasetProcessing: "native-q-i-words-reordered-to-i-q",
      timestampBasis: "host-record-command",
      hardwareValidation: "pending",
    },
  };
}

export function validateUsrpB205Ci16Format(
  format: UsrpB205Ci16RecordingFormat,
  source: string,
  rate: number,
  center: number,
): void {
  validateUsrpB205SessionDetails(format.hardware);
  const accepted = format.hardware.configuration;
  if (
    (source !== "usrp-b205" && source !== "replay") ||
    format.sampleEncoding !== "signed-16-bit-little-endian" ||
    format.sampleOrder !== "interleaved-iq" ||
    format.bytesPerComplexSample !== 4 ||
    format.normalization !== CI16_NORMALIZATION ||
    format.nativeSampleRateHz !== rate ||
    format.hardware.nativeSampleRateHz !== rate ||
    accepted.acceptedSampleRateHz !== rate ||
    accepted.acceptedCenterFrequencyHz !== center ||
    format.rateEvidence !== "ddc-calculated" ||
    format.provenanceDetails?.originalSource !== "usrp-b205" ||
    format.provenanceDetails.datasetProcessing !==
      "native-q-i-words-reordered-to-i-q" ||
    format.provenanceDetails.timestampBasis !== "host-record-command" ||
    format.provenanceDetails.hardwareValidation !== "pending"
  ) {
    throw new Error("Invalid USRP B205-mini CI16 recording provenance.");
  }
}
