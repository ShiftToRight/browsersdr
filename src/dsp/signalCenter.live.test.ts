import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { SignalCenterEstimator } from "./signalCenter";
import type { SourceSessionMetadata } from "../radio/types";

// Optional local RTL-SDR regression capture, never required in CI. The selected
// channel was 89.610610938 MHz and the isolated station was near 89.6 MHz.
it.skipIf(!process.env.BROWSERSDR_CENTER_LIVE_DATA)(
  "centers repeated fresh windows of the captured 89.6 MHz RTL-SDR station",
  async () => {
    const data = await readFile(process.env.BROWSERSDR_CENTER_LIVE_DATA!);
    const metadata: SourceSessionMetadata = {
      source: "replay",
      sessionGeneration: 1,
      requestedSampleRateHz: 2_400_000,
      actualSampleRateHz: 2_400_000,
      hardwareCenterFrequencyHz: 90_199_985.96191406,
      selectedChannelFrequencyHz: 89_610_610.93864167,
      mode: "WBFM",
      channelBandwidthHz: 150_000,
      squelch: 0,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    };
    for (const seconds of [0.2, 1, 1.8, 2.6, 3.4, 4.2]) {
      const estimator = new SignalCenterEstimator(metadata);
      let result;
      for (
        let start = Math.round(seconds * metadata.actualSampleRateHz);
        start < data.length / 2;
        start += 8192
      ) {
        const I = new Float32Array(8192),
          Q = new Float32Array(8192);
        for (let n = 0; n < I.length; n++) {
          I[n] = (data[(start + n) * 2]! - 127.5) / 128;
          Q[n] = (data[(start + n) * 2 + 1]! - 127.5) / 128;
        }
        result = estimator.accept(I, Q);
        if (result) break;
      }
      expect(result?.kind, result?.message).toBe("estimate");
      expect(Math.abs(result!.offsetHz! + 10_500)).toBeLessThan(500);
    }
  },
  20_000,
);
