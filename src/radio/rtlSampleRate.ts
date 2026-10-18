export const RTL_EXPERIMENTAL_SAMPLE_RATE_HZ = 3_200_000;
export const RTL_SAMPLE_RATES_HZ = [1_024_000, 2_400_000, RTL_EXPERIMENTAL_SAMPLE_RATE_HZ] as const;
export const RTL_EXPERIMENTAL_RATE_WARNING = "Experimental 3.2 MS/s: samples may be lost on some devices or USB hosts. If audio or decoding breaks up, select 2.4 MS/s.";
export const RTL_EXPERIMENTAL_CAPTURE_PROVENANCE = "Experimental RTL-SDR 3.2 MS/s acquisition. Hardware sample loss is unobservable in ordinary RTL I/Q; an empty known-gaps list does not establish uninterrupted reception.";

export function experimentalRtlRecording(metadata: { source: string; sampleRateHz: number; provenance?: string; provenanceDetails?: { originalSource: string }; channelCapture?: { inputSampleRateHz: number } }): boolean {
  return ((metadata.source === "rtl-sdr" || metadata.provenanceDetails?.originalSource === "rtl-sdr") &&
    (metadata.channelCapture?.inputSampleRateHz ?? metadata.sampleRateHz) === RTL_EXPERIMENTAL_SAMPLE_RATE_HZ) ||
    metadata.provenance?.includes(RTL_EXPERIMENTAL_CAPTURE_PROVENANCE) === true;
}

/** The installed 28.8 MHz/zero-correction profile represents 3.2 exactly.
 * Never round a different returned clock into this decoder profile. */
export function validateRtlAcceptedRate(requested: number, actual: number): void {
  if (requested === RTL_EXPERIMENTAL_SAMPLE_RATE_HZ && actual !== requested)
    throw new Error("RTL-SDR did not accept the exact experimental 3.2 MS/s profile. Select 2.4 MS/s.");
}
