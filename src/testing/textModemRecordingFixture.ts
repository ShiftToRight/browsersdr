import { isWidebandRate } from "../radio/sourceCapabilities";
import { textModemSignal } from "./textModemSignal";
import { IqRecorder } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import { unknownCi8Format } from "../radio/ci8Recording";
import type { TextMode, TextModemSettings } from "../textmodem/settings";
export function textModemRecordingFixture(
  mode: TextMode,
  rate = 1_024_000,
  corrupt = false,
  settings?: TextModemSettings,
) {
  const text =
    mode === "NAVTEX"
      ? "ZCZC AB01\nTEST\nNNNN"
      : mode === "ACARS"
        ? "TEST FLIGHT"
        : "CQ TEST 123\n";
  const signal = textModemSignal(mode, text, rate, { corrupt, settings });
  const defaults = defaultModeSettings(mode);
  const recorder = new IqRecorder(
    {
      source: isWidebandRate(rate) ? "replay" : "synthetic",
      sessionGeneration: 1,
      requestedSampleRateHz: rate,
      actualSampleRateHz: rate,
      hardwareCenterFrequencyHz: 131_000_000,
      selectedChannelFrequencyHz: 131_037_000,
      mode,
      channelBandwidthHz: defaults.bandwidthHz,
      squelch: 0,
      textModem: settings ?? defaults.textModem,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    },
    "2026-10-15T00:00:00.000Z",
    signal.I.length * 2 + 2,
    "Generated text-modem RF; not off-air reception.",
    undefined,
    isWidebandRate(rate) ? unknownCi8Format(rate) : undefined,
  );
  if (isWidebandRate(rate)) {
    const bytes = new Uint8Array(signal.I.length * 2);
    for (let n = 0; n < signal.I.length; n++) {
      bytes[2 * n] = Math.round(signal.I[n]! * 128) & 255;
      bytes[2 * n + 1] = Math.round(signal.Q[n]! * 128) & 255;
    }
    recorder.appendCi8(bytes);
  } else recorder.appendNormalized(signal);
  return { ...recorder.finish("user"), expectedText: text };
}
