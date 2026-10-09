import { channelSampleRate } from "./sourceCapabilities";
import type { ReceiverSnapshot } from "./receiverController";

/** Explicit download only. Acquisition-clock provenance is distinct from export time. */
export function packetDecoderExport(receiver: ReceiverSnapshot) {
  const session = receiver.session;
  if (!session || (session.mode !== "APRS" && session.mode !== "RS41"))
    return undefined;
  const snapshot = session.mode === "APRS" ? receiver.aprs : receiver.rs41;
  if (!snapshot) return undefined;
  return {
    schema: `browsersdr-${session.mode.toLowerCase()}-export-v1`,
    exportedAt: new Date().toISOString(),
    settings: { mode: session.mode, bandwidthHz: session.channelBandwidthHz },
    acquisition: {
      source: session.source,
      generation: session.sessionGeneration,
      nativeSampleRateHz: session.actualSampleRateHz,
      decoderInputSampleRateHz: channelSampleRate(session.actualSampleRateHz),
      processing:
        session.actualSampleRateHz ===
        channelSampleRate(session.actualSampleRateHz)
          ? "native selected-channel input"
          : "wideband channel FIR reduction before packet decoder",
      centerFrequencyHz: session.hardwareCenterFrequencyHz,
      selectedFrequencyHz: session.selectedChannelFrequencyHz,
    },
    provenanceClock:
      "decoder-input-samples; GPS time, when present, is not UTC",
    limits: {
      recentRecords: 32,
      ...(session.mode === "APRS"
        ? { stations: 32 }
        : { sondes: 32, totalTrackPoints: 128 }),
    },
    units: {
      coordinates: "decimal degrees",
      altitude:
        session.mode === "RS41" ? "metres above WGS-84 ellipsoid" : "metres",
      velocity: "metres/second",
      weather: "Celsius, millimetres, percent, hectopascals, watts/metre²",
    },
    snapshot,
    worker: session.mode === "APRS" ? receiver.aprsWorker : receiver.rs41Worker,
  };
}
