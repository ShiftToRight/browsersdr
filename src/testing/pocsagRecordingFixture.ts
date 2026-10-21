import { IqRecorder } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import type { SourceSessionMetadata } from "../radio/types";
import { pocsagBits } from "../pocsag/fixtures/testSignal";
import type { PocsagRate } from "../pocsag/types";
/** Generated RF only. No off-air or hardware claim. */
export function pocsagRecordingFixture(
  rate: PocsagRate = 1200,
  complete = true,
  inputRate = 1_024_000,
  offset = 37000,
) {
  const bits = pocsagBits(
    `POCSAG ${rate} DEMO <script>literal text</script>`,
    123456,
    3,
    complete,
  );
  const count = Math.ceil((bits.length * inputRate) / rate),
    I = new Float32Array(count),
    Q = new Float32Array(count);
  let phase = 0.91;
  for (let n = 0; n < count; n++) {
    phase +=
      (2 *
        Math.PI *
        (offset +
          (bits[Math.min(bits.length - 1, Math.floor((n * rate) / inputRate))]
            ? 4500
            : -4500))) /
      inputRate;
    I[n] = 0.45 * Math.cos(phase);
    Q[n] = 0.45 * Math.sin(phase);
  }
  const mode = defaultModeSettings("POCSAG");
  const session: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: inputRate,
    actualSampleRateHz: inputRate,
    hardwareCenterFrequencyHz: 439_950_500,
    selectedChannelFrequencyHz: 439_950_500 + offset,
    mode: "POCSAG",
    channelBandwidthHz: 20000,
    squelch: 0,
    pocsag: mode.pocsag,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const recorder = new IqRecorder(
    session,
    "2026-10-20T00:00:00.000Z",
    count * 2 + 2,
    "BrowserSDR generated POCSAG demo RF. Not an off-air recording.",
  );
  recorder.appendNormalized({ I, Q });
  return recorder.finish("user");
}
