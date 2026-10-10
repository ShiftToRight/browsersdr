import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { SignalCenterEstimator, type SignalCenterResult } from "./signalCenter";
import type { SourceSessionMetadata } from "../radio/types";

it.skipIf(!existsSync(new URL("../../samples/munich-2026-09-23/munich_089500_wendelstein_bayern2_wbfm_rds.sigmf-data", import.meta.url)))("measures the Bayern 2 RF recording and tracks imposed tuning offsets", async () => {
  const data = await readFile(
    new URL(
      "../../samples/munich-2026-09-23/munich_089500_wendelstein_bayern2_wbfm_rds.sigmf-data",
      import.meta.url,
    ),
  );
  const results: SignalCenterResult[] = [];
  for (const offset of [0, -5000, 5000]) {
    const metadata: SourceSessionMetadata = {
      source: "replay",
      sessionGeneration: 1,
      requestedSampleRateHz: 1_024_000,
      actualSampleRateHz: 1_024_000,
      hardwareCenterFrequencyHz: 89_499_882.20214844,
      selectedChannelFrequencyHz: 89_499_898.14814815 + offset,
      mode: "WBFM",
      channelBandwidthHz: 150_000,
      squelch: 0,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    };
    const estimator = new SignalCenterEstimator(metadata);
    // Start one second into the fixture to avoid the acquisition start transient.
    for (let start = 1_024_000; start < 2_000_000; start += 8192) {
      const I = new Float32Array(8192),
        Q = new Float32Array(8192);
      for (let n = 0; n < I.length; n++) {
        I[n] = (data[(start + n) * 2]! - 127.5) / 128;
        Q[n] = (data[(start + n) * 2 + 1]! - 127.5) / 128;
      }
      const result = estimator.accept(I, Q);
      if (result) {
        results.push(result);
        break;
      }
    }
  }
  for (const result of results)
    expect(result.kind, result.message).toBe("estimate");
  expect(results).toHaveLength(3);
  expect(results[1]!.offsetHz! - results[0]!.offsetHz!).toBeCloseTo(5000, -2);
  expect(results[2]!.offsetHz! - results[0]!.offsetHz!).toBeCloseTo(-5000, -2);
  // This validates tracking on recorded RF; its transmitter's absolute error is unknown.
});

it.skipIf(!existsSync(new URL("../../samples/center-signal-2026-10-02/rtl-089600-noisy-wbfm.sigmf-data", import.meta.url)))("isolates the live RTL-SDR station that failed the wide envelope/SNR checks", async () => {
  const data = await readFile(
    new URL(
      "../../samples/center-signal-2026-10-02/rtl-089600-noisy-wbfm.sigmf-data",
      import.meta.url,
    ),
  );
  const results: SignalCenterResult[] = [];
  for (const imposed of [-5000, 0, 5000]) {
    const metadata: SourceSessionMetadata = {
      source: "replay",
      sessionGeneration: 1,
      requestedSampleRateHz: 2_400_000,
      actualSampleRateHz: 2_400_000,
      hardwareCenterFrequencyHz: 90_199_985.96191406,
      selectedChannelFrequencyHz: 89_610_610.93864167 + imposed,
      mode: "WBFM",
      channelBandwidthHz: 150_000,
      squelch: 0,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
    };
    const estimator = new SignalCenterEstimator(metadata);
    for (let start = 0; start + 8192 <= data.length / 2; start += 8192) {
      const I = new Float32Array(8192),
        Q = new Float32Array(8192);
      for (let n = 0; n < I.length; n++) {
        I[n] = (data[(start + n) * 2]! - 127.5) / 128;
        Q[n] = (data[(start + n) * 2 + 1]! - 127.5) / 128;
      }
      const result = estimator.accept(I, Q);
      if (result) {
        results.push(result);
        break;
      }
    }
  }
  expect(results).toHaveLength(3);
  for (const result of results) {
    expect(result.kind, result.message).toBe("estimate");
    expect(result.diagnostics?.envelopeRatio).toBeGreaterThan(1.3);
    expect(result.diagnostics?.integratedSnrDb).toBeLessThan(
      10 * Math.log10(12),
    );
    expect(result.diagnostics?.refinement?.envelopeRatio).toBeLessThan(1.3);
    expect(result.diagnostics?.refinement?.integratedSnrDb).toBeGreaterThan(
      10 * Math.log10(12),
    );
  }
  expect(results[0]!.offsetHz! - results[1]!.offsetHz!).toBeCloseTo(5000, -2);
  expect(results[2]!.offsetHz! - results[1]!.offsetHz!).toBeCloseTo(-5000, -2);
  // Absolute transmitter frequency is unknown: this verifies estimator tracking,
  // the measured failing class and independent filtering, not station identity.
});
