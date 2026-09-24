import { defaultModeSettings } from "../radio/receiverConfig";
import { IqRecorder, type IqRecording, type IqRecordingMetadata } from "../radio/iqRecording";
import type { SourceSessionMetadata } from "../radio/types";
import { syntheticAm } from "./syntheticModulation";

/**
 * Generated, deterministic AM fixture: 48 kHz CU8 I/Q, carrier at +6 kHz,
 * modulated by a 1 kHz tone. Provenance lives in the exported metadata.
 */
export function createDeterministicRecordingFixture(sampleCount = 24_000): IqRecording & { metadata: Extract<IqRecordingMetadata, { format: "browsersdr-cu8-v1" }> } {
  const mode = defaultModeSettings("AM");
  const session: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: 48_000,
    actualSampleRateHz: 48_000,
    hardwareCenterFrequencyHz: 10_000_000,
    selectedChannelFrequencyHz: 10_006_000,
    mode: "AM",
    channelBandwidthHz: mode.bandwidthHz,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const generator = syntheticAm(session.hardwareCenterFrequencyHz + 6_000, 1_000);
  const recorder = new IqRecorder(
    session,
    "2026-09-08T00:00:00.000Z",
    sampleCount * 2 + 2,
    "BrowserSDR deterministic generator: AM carrier +6 kHz, 1 kHz tone, 48 ksample/s; no hardware capture.",
  );
  const I = new Float32Array(sampleCount);
  const Q = new Float32Array(sampleCount);
  generator(0, session.actualSampleRateHz, session.hardwareCenterFrequencyHz, I, Q);
  recorder.appendNormalized({ I, Q });
  return recorder.finish("user") as IqRecording & { metadata: Extract<IqRecordingMetadata, { format: "browsersdr-cu8-v1" }> };
}
