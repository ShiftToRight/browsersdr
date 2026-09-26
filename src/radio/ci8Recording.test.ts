import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { unzipSync } from "fflate";
import schema from "../../docs/vendor/sigmf-v1.2.6/sigmf-schema.json";
import { hackrfRecordingFixture } from "../testing/hackrfRecordingFixture";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { HackrfSampleAdapter } from "./hackrfSource";
import { IqRecorder, decodeRecordingSamples, parseRecording, recordingMetadataJson, validateRecordingMetadata, RECORDING_FORMAT, RECORDING_MAX_BYTES, type RecordingSampleFormat } from "./iqRecording";
import { CI8_NORMALIZATION, CI8_RECORDING_FORMAT } from "./ci8Recording";
import { fftInPlace } from "../dsp/spectrumMath";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import { prepareRecordingExport, createRecordingArchive, RecordingExportCoordinator } from "./recordingExport";
import { defaultModeSettings } from "./receiverConfig";

function tone(sign: number) {
  const bytes = new Uint8Array(4096 * 2);
  for (let n = 0; n < bytes.length / 2; n++) { bytes[2 * n] = Math.round(90 * Math.cos(sign * 2 * Math.PI * 37 * n / 4096)) + 8; bytes[2 * n + 1] = Math.round(90 * Math.sin(sign * 2 * Math.PI * 37 * n / 4096)) - 4; }
  return bytes;
}
describe("versioned native CI8 capture", () => {
  it("round-trips signed extrema and native byte offsets without CU8 recoding", async () => {
    const { recording, makeRecorder } = await hackrfRecordingFixture();
    const recorder = makeRecorder(); const backing = Uint8Array.of(99, 99, ...recording.data, 88, 88);
    recorder.appendCi8(backing.subarray(2, -2)); backing.fill(0);
    const captured = recorder.finish();
    expect(captured.data).toEqual(recording.data); expect(recorder.finish()).toBe(captured);
    const parsed = parseRecording(recordingMetadataJson(captured), captured.data);
    expect(parsed.data).toEqual(recording.data); expect(parsed.metadata).toEqual(captured.metadata);
    expect(parsed.metadata).not.toHaveProperty("gainDb");
    if (parsed.metadata.format === RECORDING_FORMAT || !parsed.metadata.hardware || !parsed.metadata.captureSettings) throw new Error("fixture");
    const frozen = structuredClone(parsed.metadata);
    delete frozen.hardware!.platformSupport; delete frozen.captureSettings!.kind;
    expect(() => validateRecordingMetadata(frozen, parsed.data.length)).not.toThrow();
    const { I, Q } = decodeRecordingSamples(parsed.data, parsed.metadata);
    expect([...I]).toEqual([-1, -1 / 128, 0, 127 / 128]); expect([...Q]).toEqual([127 / 128, 0, -1 / 128, -1]);
    expect(parsed.metadata).toMatchObject({ format: CI8_RECORDING_FORMAT, normalization: CI8_NORMALIZATION, hardware: { boardId: 5 }, provenanceDetails: { hardwareValidation: "pending" } });
  });
  it.each([-1, 1])("keeps %i tone orientation, DC and power identical to live", async sign => {
    const bytes = tone(sign), { recording, configured } = await hackrfRecordingFixture(bytes);
    const replay = decodeRecordingSamples(parseRecording(recordingMetadataJson(recording), bytes).data, recording.metadata);
    let live: { I: Float32Array; Q: Float32Array } | undefined;
    const adapter = new HackrfSampleAdapter({ setSampleRate() {}, receiveSamples: block => { live = { I: block.I.slice(), Q: block.Q.slice() }; } });
    adapter.ready(configured); adapter.receive({ bytes, encoding: "ci8", sampleOrder: "interleaved-iq", bytesPerComplexSample: 2,
      complexSampleCount: bytes.length / 2, nativeSampleRateHz: recording.metadata.sampleRateHz, generation: 1, sequence: 0, firstSampleIndex: 0, receivedAtMonotonicMs: 0, discontinuityBefore: null });
    expect(replay).toEqual(live);
    fftInPlace(replay.I, replay.Q);
    const powers = replay.I.map((v, n) => v * v + replay.Q[n]! ** 2);
    expect(powers.indexOf(Math.max(...powers))).toBe(sign > 0 ? 37 : 4096 - 37);
    expect(replay.I[0]! / 4096).toBeCloseTo(8 / 128, 6); expect(replay.Q[0]! / 4096).toBeCloseTo(-4 / 128, 6);
    const db = 10 * Math.log10(Math.max(...powers) / 4096 ** 2);
    expect(Math.abs(db - 20 * Math.log10(90 / 128))).toBeLessThan(.01);
  });
  it("bounds tiny appends, capacity, gaps and finalization without another dataset copy", async () => {
    const { makeRecorder } = await hackrfRecordingFixture(); const recorder = makeRecorder(65_540);
    for (let n = 0; n < 32_770; n++) recorder.appendCi8(Uint8Array.of(n % 256, 255));
    recorder.addGap(null, "unknown tail"); recorder.appendCi8(Uint8Array.of(9, 9));
    const result = recorder.finish();
    expect(result.data).toHaveLength(65_540); expect(result.metadata.stopReason).toBe("capacity");
    expect(result.metadata.knownGaps).toEqual([{ afterSample: 32_770, missingSamples: null, reason: "unknown tail" }]);
    expect(recorder.finish()).toBe(result);
    expect(() => makeRecorder(RECORDING_MAX_BYTES + 2)).toThrow();
    expect(() => makeRecorder(NaN)).toThrow();
    expect(() => makeRecorder().appendCi8(Uint8Array.of(1))).toThrow(/complete/);
    expect(() => makeRecorder().appendCu8(Uint8Array.of(1, 2))).toThrow(/CU8/);
    expect(() => makeRecorder().appendNormalized({ I: new Float32Array(1), Q: new Float32Array(1) })).toThrow(/native/);
  });
  it.each([
    { format: "browsersdr-ci16-v2" }, { sampleEncoding: "unsigned-8-bit" }, { bytesPerComplexSample: 4 }, { normalization: "float = byte / 128 - 0.995" },
    { sampleRateHz: NaN }, { sampleRateHz: 8_000_000 }, { nativeSampleRateHz: 2_400_000 }, { effectiveSampleRateHz: 512_000 },
    { adcSampleRateHz: 1_024_000 }, { fpgaDecimationFactor: 16 }, { hostResampling: { kind: "decimation", numerator: 1, denominator: 2 } },
    { gainDb: null }, { source: "rtl-sdr" }, { sampleCount: 99 }, { hardware: {} }, { provenanceDetails: { originalSource: "unknown" } },
  ])("rejects malformed v2 fields %j", async patch => {
    const { recording } = await hackrfRecordingFixture();
    expect(() => parseRecording(JSON.stringify({ ...recording.metadata, ...patch }), recording.data)).toThrow();
  });
  it("validates stage steps, profile identity, fixed point readback and evidence claims", async () => {
    const { recording } = await hackrfRecordingFixture();
    const metadata = recording.metadata;
    if (metadata.format === RECORDING_FORMAT || !metadata.hardware) throw new Error("fixture");
    for (const patch of [{ rxLnaGainCode: 8 }, { rxVgaGainDb: 3 }, { rfAmplifierEnabled: 1 }, { antennaPowerEnabled: true }, { appliedRateFixed36: "18446744073709551616" }]) {
      expect(() => validateRecordingMetadata({ ...metadata, captureSettings: { ...metadata.captureSettings, ...patch } }, recording.data.length)).toThrow();
    }
    expect(() => validateRecordingMetadata({ ...metadata, hardware: { ...metadata.hardware, usbApiVersion: 1 } }, recording.data.length)).toThrow();
    expect(() => validateRecordingMetadata({ ...metadata, provenanceDetails: { ...metadata.provenanceDetails, hardwareValidation: "validated" } }, recording.data.length)).toThrow();
    expect(() => decodeRecordingSamples(recording.data, { ...metadata, sampleEncoding: "float32" } as unknown as RecordingSampleFormat)).toThrow(/encoding/);
    const legacy = createDeterministicRecordingFixture(2);
    const recorder = new IqRecorder({ source: "replay", sessionGeneration: 1, requestedSampleRateHz: 48_000, actualSampleRateHz: 48_000, hardwareCenterFrequencyHz: 10_000_000, selectedChannelFrequencyHz: 10_000_000, mode: "AM", channelBandwidthHz: 15_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized" });
    expect(() => recorder.appendCi8(legacy.data)).toThrow(/CI8/);
  });
});

describe("CI8 export and import", () => {
  it.each([1_024_000, 4_800_000, 9_600_000, 19_200_000] as const)("exports schema-valid ci8 at %i, exact SHA-512 and truthful identity/settings/survey evidence", async rate => {
    const { recording } = await hackrfRecordingFixture(tone(1), rate);
    recording.metadata.survey = { sessionId: "test", site: { label: "Test site", latitude: 48, longitude: 11, antenna: "test dipole" }, signal: { label: "Unverified carrier", confidence: "low" } };
    recording.metadata.knownGaps = [{ afterSample: 10, missingSamples: 20, reason: "known app gap" }, { afterSample: 20, missingSamples: null, reason: "unknown loss" }, { afterSample: 30, missingSamples: 3, reason: "after unknown" }];
    const exported = await createSigmfExport(recording);
    expect(exported.data).toBe(recording.data);
    expect(exported.metadata.global).toMatchObject({ "core:datatype": "ci8", "core:sample_rate": rate, "core:sha512": createHash("sha512").update(recording.data).digest("hex") });
    expect(exported.metadata.global["core:hw"]).toContain("fixture-unvalidated");
    expect(exported.metadata.global["core:description"]).toContain("not calibrated");
    expect(exported.metadata.annotations[0]!["core:comment"]).not.toContain("automatic RF gain");
    expect(exported.basename).toContain("test-site");
    expect(exported.metadata.global["core:description"]).toContain("test dipole");
    const ajv = new Ajv2020({ strict: false, allErrors: true, unicodeRegExp: false }); addFormats(ajv);
    const validate = ajv.compile(schema); expect(validate(exported.metadata), JSON.stringify(validate.errors)).toBe(true);
    const imported = await importSigmfRecording(exported.metadataJson, exported.data, { modeSettings: defaultModeSettings("AM") });
    expect(imported.data).toEqual(recording.data); expect(imported.metadata).toMatchObject({ format: CI8_RECORDING_FORMAT, source: "replay", provenanceDetails: { originalSource: "unknown" } });
    expect(imported.metadata).not.toHaveProperty("hardware"); expect(imported.importedSigmf?.metadataText).toBe(exported.metadataJson);
    expect(imported.metadata.knownGaps).toEqual(recording.metadata.knownGaps);
    expect(decodeRecordingSamples(imported.data, imported.metadata)).toEqual(decodeRecordingSamples(recording.data, recording.metadata));
  });
  it.each(["browsersdr", "sigmf"] as const)("keeps %s ZIP preparation/retry bounded and byte exact", async format => {
    const { recording } = await hackrfRecordingFixture();
    let attempts = 0;
    const coordinator = new RecordingExportCoordinator(async (r, f) => { if (++attempts === 1) throw new Error("injected preparation error"); return prepareRecordingExport(r, f); });
    expect((await coordinator.retain(recording, format)).status).toBe("failure");
    expect(coordinator.blocksNewCapture).toBe(true);
    const result = await coordinator.retryPreparation(); if (result.status !== "prepared") throw new Error("retry failed");
    const files = unzipSync(createRecordingArchive(result.prepared).contents as Uint8Array);
    expect(files[result.prepared.files[0].name]).toEqual(recording.data);
    expect(result.prepared.files[0].name.endsWith(format === "browsersdr" ? ".ci8" : ".sigmf-data")).toBe(true);
    expect((await coordinator.requestDownload("archive", () => { throw new Error("blocked download"); })).status).toBe("failure");
    expect((await coordinator.requestDownload("archive", () => {})).status).toBe("download-requested");
    coordinator.discard(); expect(coordinator.getSnapshot().retainedBytes).toBe(0);
  });
});
