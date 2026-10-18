import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { defaultModeSettings, RECEIVER_MODES } from "./receiverConfig";
import { IqRecorder, parseRecording, recordingMetadataJson } from "./iqRecording";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import { CHANNEL_RECORDING_FORMAT } from "./channelRecording";
import { RTL_EXPERIMENTAL_CAPTURE_PROVENANCE, experimentalRtlRecording } from "./rtlSampleRate";

it.each(RECEIVER_MODES)("round-trips unchanged 3.2 MS/s native CU8 with %s metadata and honest loss provenance", async mode => {
  const settings = defaultModeSettings(mode);
  const input = Uint8Array.from({ length: 4096 }, (_, n) => n & 255);
  const original = input.slice();
  const recorder = new IqRecorder({ source: "rtl-sdr", sessionGeneration: 3, requestedSampleRateHz: 3_200_000, actualSampleRateHz: 3_200_000, hardwareCenterFrequencyHz: 100e6, selectedChannelFrequencyHz: 100e6, channelBandwidthHz: settings.bandwidthHz, ...settings, gainDb: 25, sampleFormat: "planar-f32-iq-normalized" }, "2026-10-18T00:00:00.000Z", 8192, "Generated transport fixture, not RF evidence.");
  recorder.appendCu8(input);
  const recording = recorder.finish();
  expect(recording.data).toEqual(original);
  expect(input).toEqual(original);
  expect(recording.metadata).toMatchObject({ sampleRateHz: 3_200_000, sampleCount: 2048, durationSeconds: 2048 / 3_200_000, knownGaps: [] });
  expect(recording.metadata.provenance).toContain(RTL_EXPERIMENTAL_CAPTURE_PROVENANCE);
  expect(recording.metadata.captureWarning).toBeUndefined();
  expect(parseRecording(recordingMetadataJson(recording), recording.data).data).toEqual(original);
  const exported = await createSigmfExport(recording);
  expect(exported.metadata.global["core:sample_rate"]).toBe(3_200_000);
  expect(exported.metadata.global["core:datatype"]).toBe("cu8");
  expect(exported.metadata.global["core:sha512"]).toBe(createHash("sha512").update(original).digest("hex"));
  const imported = await importSigmfRecording(exported.metadataJson, original, { modeSettings: settings });
  expect(imported.data).toEqual(original);
  expect(imported.metadata.durationSeconds).toBe(recording.metadata.durationSeconds);
  // External SigMF does not authenticate a hardware source. Its original
  // warning is retained verbatim in the sidecar, not promoted to identity.
  expect(imported.importedSigmf?.metadataText).toBe(exported.metadataJson);
  expect(exported.metadataJson).toContain(RTL_EXPERIMENTAL_CAPTURE_PROVENANCE);
  expect(experimentalRtlRecording(imported.metadata)).toBe(false);
});

it.each(["AM", "APRS", "DAB", "ADS-B"] as const)("keeps processed %s captures separate from native CU8 and preserves their routing clock", async mode => {
  const settings = defaultModeSettings(mode);
  const recorder = new IqRecorder({ source: "rtl-sdr", sessionGeneration: 3, requestedSampleRateHz: 3_200_000, actualSampleRateHz: 3_200_000, hardwareCenterFrequencyHz: 100e6, selectedChannelFrequencyHz: 100e6, channelBandwidthHz: settings.bandwidthHz, ...settings, gainDb: 25, sampleFormat: "planar-f32-iq-normalized" }, "2026-10-18T00:00:00.000Z", 32768, undefined, undefined, undefined, "memory", { captureCurrentChannel: true });
  recorder.appendCu8(new Uint8Array(8192).fill(160));
  const recording = recorder.finish();
  expect(recording.metadata.format).toBe(CHANNEL_RECORDING_FORMAT);
  expect(recording.metadata.sampleEncoding).toBe("signed-8-bit");
  expect(experimentalRtlRecording(recording.metadata)).toBe(true);
  const exported = await createSigmfExport(recording);
  const imported = await importSigmfRecording(exported.metadataJson, recording.data, { modeSettings: settings });
  expect(imported.data).toEqual(recording.data);
  expect(imported.metadata.sampleRateHz).toBe(recording.metadata.sampleRateHz);
  expect(parseRecording(recordingMetadataJson(recording), recording.data).metadata).toEqual(recording.metadata);
});

it("does not infer RTL origin from a generic 3.2 MS/s recording", () => {
  expect(experimentalRtlRecording({ source: "replay", sampleRateHz: 3_200_000 })).toBe(false);
});
