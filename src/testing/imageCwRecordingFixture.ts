import { IqRecorder } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import { DEFAULT_IMAGE_SETTINGS, defaultTextModemSettings, type TextModemSettings } from "../textmodem/settings";
import { cwSegments, martinSegments, toneIqBlocks, wefaxSegments } from "./imageCwSignal";

export function imageCwRecordingFixture(mode: "WEFAX" | "SSTV" | "CW-TEXT", settings?: TextModemSettings) {
  const rate = 1_024_000;
  const accepted = settings ?? { ...defaultTextModemSettings(), image: { ...DEFAULT_IMAGE_SETTINGS, automatic: false } };
  const segments = mode === "WEFAX" ? wefaxSegments(false, 8, accepted.image?.shiftHz ?? 800) : mode === "SSTV" ? martinSegments("Martin M2", 8) : cwSegments(accepted.cw?.wpm ?? 20);
  const total = Math.ceil(segments.reduce((sum, segment) => sum + segment.seconds, 0) * rate);
  const defaults = defaultModeSettings(mode);
  const recorder = new IqRecorder({
    source: "synthetic", sessionGeneration: 1, requestedSampleRateHz: rate, actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: 131_000_000, selectedChannelFrequencyHz: 131_037_000,
    mode, channelBandwidthHz: defaults.bandwidthHz, squelch: 0, beatToneHz: defaults.beatToneHz,
    textModem: accepted, gainDb: null, sampleFormat: "planar-f32-iq-normalized",
  }, "2026-10-15T00:00:00.000Z", total * 2 + 65536, "Generated image/CW wire vector; not off-air reception.");
  for (const block of toneIqBlocks(segments, rate)) recorder.appendNormalized(block);
  return { ...recorder.finish("user"), expectedText: "SOS TEST 123" };
}
