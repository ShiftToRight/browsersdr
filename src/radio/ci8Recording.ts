import { channelSampleRate, hostResamplingForRate, type HostResampling, type HackrfProtocolProfile, type HackrfReferenceCommit, validateHackrfSessionDetails, type HackrfIdentity, type HackrfCaptureSettings, type HackrfSessionDetails } from "./sourceCapabilities";
import { validateLiveRateBudget } from "./liveRateBudget";

export const CI8_RECORDING_FORMAT = "browsersdr-ci8-v2" as const;
export const CI8_NORMALIZATION = "float = signedByte / 128" as const;
interface Ci8Format {
  format: typeof CI8_RECORDING_FORMAT;
  sampleEncoding: "signed-8-bit";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 2;
  normalization: typeof CI8_NORMALIZATION;
  nativeSampleRateHz: number;
  effectiveSampleRateHz: number;
  hostResampling: HostResampling;
}
export interface HackrfRecordingFormat extends Ci8Format {
  rateEvidence: HackrfSessionDetails["rateEvidence"];
  adcSampleRateHz: number;
  fpgaDecimationFactor: 1 | 2 | 4 | 8 | 16 | 32;
  hardware: Omit<HackrfIdentity, "platformSupport"> & {
    platformSupport?: number;
    protocolProfile: HackrfProtocolProfile;
    referenceCommit: HackrfReferenceCommit;
    standardImageIndex: 0 | null;
    formatEvidence: "standard-image-selection-acknowledged" | "firmware-standard-ci8";
  };
  captureSettings: Omit<HackrfCaptureSettings, "kind"> & { kind?: "hackrf" };
  provenanceDetails: {
    originalSource: "hackrf";
    datasetProcessing: "native-usb-bytes-unchanged";
    timestampBasis: "host-first-retained-block";
    hardwareValidation: "pending" | "validated";
    validationRecord?: string;
  };
}
export interface UnknownCi8RecordingFormat extends Ci8Format {
  rateEvidence: "imported";
  adcSampleRateHz: null;
  fpgaDecimationFactor: null;
  hardware?: never;
  captureSettings?: never;
  provenanceDetails: {
    originalSource: "unknown";
    datasetProcessing: "imported-ci8-bytes-unchanged";
    timestampBasis: "imported-or-host-estimate";
    hardwareValidation: "pending";
  };
}
export type Ci8RecordingFormat = HackrfRecordingFormat | UnknownCi8RecordingFormat;
export function unknownCi8Format(rate: number): UnknownCi8RecordingFormat {
  return { format: CI8_RECORDING_FORMAT, sampleEncoding: "signed-8-bit", sampleOrder: "interleaved-iq", bytesPerComplexSample: 2,
    normalization: CI8_NORMALIZATION, nativeSampleRateHz: rate, effectiveSampleRateHz: channelSampleRate(rate),
    hostResampling: hostResamplingForRate(rate), rateEvidence: "imported", adcSampleRateHz: null, fpgaDecimationFactor: null,
    provenanceDetails: { originalSource: "unknown", datasetProcessing: "imported-ci8-bytes-unchanged", timestampBasis: "imported-or-host-estimate", hardwareValidation: "pending" } };
}
export function hackrfRecordingFormat(details: HackrfSessionDetails): HackrfRecordingFormat {
  validateHackrfSessionDetails(details);
  return structuredClone({ ...unknownCi8Format(details.nativeSampleRateHz), rateEvidence: details.rateEvidence,
    hostResampling: details.hostResampling, effectiveSampleRateHz: details.effectiveSampleRateHz, adcSampleRateHz: details.adcSampleRateHz, fpgaDecimationFactor: details.fpgaDecimationFactor,
    hardware: { ...details.capabilities.identity, protocolProfile: details.capabilities.protocolProfile, referenceCommit: details.capabilities.referenceCommit,
      standardImageIndex: details.capabilities.standardImageIndex, formatEvidence: details.capabilities.formatEvidence },
    captureSettings: details.captureSettings,
    provenanceDetails: { originalSource: "hackrf", datasetProcessing: "native-usb-bytes-unchanged", timestampBasis: "host-first-retained-block", hardwareValidation: "pending" },
  });
}
export function ci8SessionDetails(format: HackrfRecordingFormat): HackrfSessionDetails {
  return structuredClone({ nativeEncoding: "ci8", nativeSampleRateHz: format.nativeSampleRateHz, effectiveSampleRateHz: format.effectiveSampleRateHz,
    adcSampleRateHz: format.adcSampleRateHz, fpgaDecimationFactor: format.fpgaDecimationFactor, hostResampling: format.hostResampling,
    rateEvidence: format.rateEvidence, captureSettings: { ...format.captureSettings, kind: format.captureSettings.kind ?? "hackrf" },
    capabilities: { source: "hackrf", phase: "discovered", identity: { ...format.hardware, platformSupport: format.hardware.platformSupport ?? (format.hardware.kind === "hackrf-one" ? 0 : 0x10) }, protocolProfile: format.hardware.protocolProfile,
      referenceCommit: format.hardware.referenceCommit, nativeEncoding: "ci8", standardImageIndex: format.hardware.standardImageIndex,
      formatEvidence: format.hardware.formatEvidence, firmwareBuildValidation: "unvalidated", hardwareValidation: "pending" },
  });
}
export function validateCi8Format(format: Ci8RecordingFormat, source: string, rate: number, center: number): void {
  if (format.sampleEncoding !== "signed-8-bit" || format.normalization !== CI8_NORMALIZATION || format.sampleOrder !== "interleaved-iq" || format.bytesPerComplexSample !== 2
    || format.nativeSampleRateHz !== rate || Math.abs(format.effectiveSampleRateHz - channelSampleRate(rate)) > 1e-6 || !Number.isFinite(format.effectiveSampleRateHz)
    || format.hostResampling?.kind !== hostResamplingForRate(rate).kind || format.hostResampling.numerator !== 1 || format.hostResampling.denominator !== hostResamplingForRate(rate).denominator) throw new Error("Invalid CI8 encoding, normalization or native/effective rate contract.");
  // Every produced/imported v2 pair must be replayable on common audio clocks.
  validateLiveRateBudget(format.effectiveSampleRateHz, 48_000); validateLiveRateBudget(format.effectiveSampleRateHz, 44_100);
  const provenance = format.provenanceDetails;
  if (provenance?.originalSource === "hackrf") {
    if (source !== "hackrf" && source !== "replay") throw new Error("Invalid CI8 source.");
    if (provenance.datasetProcessing !== "native-usb-bytes-unchanged" || provenance.timestampBasis !== "host-first-retained-block"
      || !["pending", "validated"].includes(provenance.hardwareValidation)
      || (provenance.hardwareValidation === "validated" && (typeof provenance.validationRecord !== "string" || !provenance.validationRecord.trim()))
      || (provenance.validationRecord !== undefined && (typeof provenance.validationRecord !== "string" || provenance.validationRecord.length > 4096))) throw new Error("Invalid HackRF capture provenance.");
    const known = format as HackrfRecordingFormat;
    if (!known.hardware || !known.captureSettings) throw new Error("HackRF recording requires hardware identity and accepted capture settings.");
    validateHackrfSessionDetails(ci8SessionDetails(known));
    const fixed = known.captureSettings.appliedRfFixed24;
    const raw = fixed === null ? null : BigInt(fixed);
    const reported = raw === null ? known.captureSettings.requestedCenterFrequencyHz : Number(raw / 2n ** 24n) + Number(raw % 2n ** 24n) / 2 ** 24;
    if (Math.abs(center - reported) > 1e-6) throw new Error("Recording center does not match the accepted hardware setting.");
  } else if (provenance?.originalSource === "unknown") {
    if (source !== "replay" || format.rateEvidence !== "imported" || format.adcSampleRateHz !== null || format.fpgaDecimationFactor !== null
      || format.hardware !== undefined || format.captureSettings !== undefined
      || provenance.datasetProcessing !== "imported-ci8-bytes-unchanged" || provenance.timestampBasis !== "imported-or-host-estimate"
      || provenance.hardwareValidation !== "pending" || "validationRecord" in provenance) throw new Error("Invalid unknown-origin CI8 provenance.");
  } else throw new Error("CI8 recording requires explicit origin provenance.");
}
