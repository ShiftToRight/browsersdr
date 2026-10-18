import { unknownCi8Format } from "../radio/ci8Recording";
import { isWidebandRate } from "../radio/sourceCapabilities";
import {
  buildUiFrame,
  encodedPacketBits,
  generateAfsk,
} from "../aprs/fixtures/testSignal";
import {
  bytesFromHex,
  RS41_REAL_FRAME_HEX,
} from "../rs41/fixtures/referenceFrames";
import { xorRs41Whitening } from "../rs41/whitening";
import { IqRecorder } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import type { SourceSessionMetadata } from "../radio/types";

/** Generated RF only: APRS specification position and independent RS41 frame bytes.
 * This is not an off-air capture. A nonzero selected offset exercises channel routing. */
export function packetRecordingFixture(
  mode: "APRS" | "RS41",
  rate = 1_024_000,
  offsetHz = 37_000,
  corrupt = false,
) {
  let discriminator: Float32Array;
  if (mode === "APRS") {
    const frame = buildUiFrame(
      "!4903.50N/07201.75W-Test <script>literal text</script>",
    );
    if (corrupt) frame[frame.length - 1]! ^= 1;
    const audio = generateAfsk(encodedPacketBits(frame, 32), rate);
    discriminator = Float32Array.from(audio, (value) => value * 3_200);
  } else {
    const frame = bytesFromHex(RS41_REAL_FRAME_HEX);
    if (corrupt) for (let n = 0; n < 26; n++) frame[0x38 + n * 2]! ^= 0x5a;
    const onAir = xorRs41Whitening(frame);
    const bits = [
      ...Array.from({ length: 160 }, (_, n) => n & 1),
      ...Array.from(onAir).flatMap((byte) =>
        Array.from({ length: 8 }, (_, n) => (byte >>> n) & 1),
      ),
      ...Array.from({ length: 800 }, (_, n) => n & 1),
    ];
    discriminator = Float32Array.from(
      { length: Math.ceil((bits.length * rate) / 4800) },
      (_, n) =>
        bits[Math.min(bits.length - 1, Math.floor((n * 4800) / rate))]
          ? 2_300
          : -2_300,
    );
  }
  const I = new Float32Array(discriminator.length),
    Q = new Float32Array(I.length);
  let phase = 0.91;
  for (let n = 0; n < I.length; n++) {
    phase += (2 * Math.PI * (offsetHz + discriminator[n]!)) / rate;
    I[n] = 0.45 * Math.cos(phase);
    Q[n] = 0.45 * Math.sin(phase);
  }
  const session: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: mode === "APRS" ? 144_763_000 : 402_963_000,
    selectedChannelFrequencyHz:
      (mode === "APRS" ? 144_763_000 : 402_963_000) + offsetHz,
    mode,
    channelBandwidthHz: defaultModeSettings(mode).bandwidthHz,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const recorder = new IqRecorder(
    { ...session, ...(isWidebandRate(rate) ? { source: "replay" as const } : {}) },
    "2026-10-09T00:00:00.000Z",
    I.length * 2 + 2,
    "BrowserSDR generated packet acceptance RF; not hardware or off-air evidence.",
    undefined,
    isWidebandRate(rate) ? unknownCi8Format(rate) : undefined,
  );
  if (isWidebandRate(rate)) {
    const bytes = new Uint8Array(I.length * 2);
    for (let n = 0; n < I.length; n++) {
      bytes[n * 2] = Math.round(I[n]! * 128) & 255;
      bytes[n * 2 + 1] = Math.round(Q[n]! * 128) & 255;
    }
    recorder.appendCi8(bytes);
  } else recorder.appendNormalized({ I, Q });
  return recorder.finish("user");
}
