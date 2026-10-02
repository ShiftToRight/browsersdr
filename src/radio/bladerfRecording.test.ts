import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../docs/vendor/sigmf-v1.2.6/sigmf-schema.json";
import { bladeRfRecordingFixture } from "../testing/bladerfRecordingFixture";
import { BLADERF_SC16_RECORDING_FORMAT } from "./bladerfRecording";
import {
  IqRecorder,
  decodeRecordingSamples,
  parseRecording,
  recordingMetadataJson,
  recordingRoutingSampleRate,
  validateRecordingMetadata,
} from "./iqRecording";
import { prepareRecordingExport } from "./recordingExportFormat";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import { defaultModeSettings } from "./receiverConfig";
import { inspectBrowserSigmfForAtlas } from "./atlasSigmfCompatibility";

const models = ["xA4", "xA5", "xA9"] as const;

describe("native bladeRF SC16 Q11 recording", () => {
  it.each(
    models.flatMap((model) =>
      [4, 5, 6].map((firmware) => ({ model, firmware })),
    ),
  )(
    "exports and reimports unchanged $model firmware 2.$firmware bytes with explicit Q11 scale and identity",
    async ({ model, firmware }) => {
      const { recording } = await bladeRfRecordingFixture(
        undefined,
        2_400_000,
        model,
        firmware,
      );
      const exported = await createSigmfExport(recording);
      expect(exported.data).toEqual(recording.data);
      expect(exported.metadata.global["core:datatype"]).toBe("ci16_le");
      expect(exported.metadata.global["core:hw"]).toContain(
        `bladeRF 2.0 Micro ${model}`,
      );
      expect(exported.metadata.global["core:sha512"]).toBe(
        createHash("sha512").update(recording.data).digest("hex"),
      );
      expect(
        exported.metadata.global["browsersdr:sample_format"],
      ).toMatchObject({
        format: BLADERF_SC16_RECORDING_FORMAT,
        normalization: "float = int16 / 2048",
        provenanceDetails: {
          originalSource: "bladerf",
          hardwareValidation: "pending",
        },
        hardware: {
          identity: {
            model,
            firmware: { major: 2, minor: firmware },
            volatileImage: null,
          },
          rxInput: "RX1",
          gainMode: "slow-attack-agc",
        },
      });
      const ajv = new Ajv2020({
        strict: false,
        allErrors: true,
        unicodeRegExp: false,
      });
      addFormats(ajv);
      const validate = ajv.compile(schema);
      expect(validate(exported.metadata), JSON.stringify(validate.errors)).toBe(
        true,
      );
      const imported = await importSigmfRecording(
        exported.metadataJson,
        exported.data,
        { modeSettings: defaultModeSettings("OFF") },
      );
      expect(imported.data).toEqual(recording.data);
      expect(imported.metadata).toMatchObject({
        format: BLADERF_SC16_RECORDING_FORMAT,
        source: "replay",
        bytesPerComplexSample: 4,
      });
      const decoded = decodeRecordingSamples(imported.data, imported.metadata);
      expect([...decoded.I]).toEqual([-1, -0.5]);
      expect([...decoded.Q]).toEqual([2047 / 2048, 0.5]);
      await expect(
        prepareRecordingExport(recording, "browsersdr"),
      ).rejects.toThrow(/SigMF/);
      const compatibility = await inspectBrowserSigmfForAtlas(
        exported.metadata,
        exported.data,
      );
      expect(compatibility).toMatchObject({
        archiveEligible: true,
        analysisEligible: false,
        quarantine: false,
      });
      expect(compatibility.issues).toContainEqual(
        expect.objectContaining({ code: "q11_analysis_unsupported" }),
      );
    },
  );

  it.each([2_400_000, 4_800_000, 9_600_000, 19_200_000] as const)(
    "preserves accepted timing and center separately from nominal %i DSP rate",
    async (rate) => {
      const { recording } = await bladeRfRecordingFixture(
        undefined,
        rate,
        "xA9",
        5,
        -1,
      );
      const exported = await createSigmfExport(recording);
      expect(recording.metadata.sampleRateHz).toBe(rate - 1);
      expect(recording.metadata.durationSeconds).toBe(2 / (rate - 1));
      expect(exported.metadata.global["core:sample_rate"]).toBe(rate - 1);
      expect(exported.metadata.captures[0]!["core:frequency"]).toBe(
        100_000_010,
      );
      const imported = await importSigmfRecording(
        exported.metadataJson,
        exported.data,
        { modeSettings: defaultModeSettings("OFF") },
      );
      expect(recordingRoutingSampleRate(imported.metadata)).toBe(rate);
      expect(imported.metadata.sampleRateHz).toBe(rate - 1);
    },
  );

  it("owns offset native words without swapping, scaling, quantization or later provider mutation", async () => {
    const { makeRecorder } = await bladeRfRecordingFixture();
    const recorder = makeRecorder(9);
    const backing = Uint8Array.of(99, 0, 248, 255, 7, 0, 252, 0, 4, 88);
    recorder.appendBladeRfSc16(backing.subarray(1, 9));
    backing.fill(0);
    recorder.appendBladeRfSc16(Uint8Array.of(0, 0, 0, 0));
    const recording = recorder.finish();
    expect(recording.data).toEqual(Uint8Array.of(0, 248, 255, 7, 0, 252, 0, 4));
    expect(recording.metadata).toMatchObject({
      stopReason: "capacity",
      sampleCount: 2,
    });
    expect(
      parseRecording(recordingMetadataJson(recording), recording.data).data,
    ).toEqual(recording.data);
    expect(() => makeRecorder().appendUsrpSc16(recording.data)).toThrow(/USRP/);
    expect(() =>
      makeRecorder().appendNormalized({
        I: new Float32Array(1),
        Q: new Float32Array(1),
      }),
    ).toThrow(/native/);
    expect(() => makeRecorder().appendBladeRfSc16(Uint8Array.of(1, 2))).toThrow(
      /complete/,
    );
  });

  it.each([
    { normalization: "float = int16 / 32768" },
    { source: "usrp-b205" },
    { bytesPerComplexSample: 2 },
    { nativeSampleRateHz: 2_400_001 },
    { sampleRateHz: 2_400_001 },
    { effectiveSampleRateHz: 4_800_000 },
  ])("rejects conflicting Q11 format evidence %j", async (patch) => {
    const { recording } = await bladeRfRecordingFixture();
    expect(() =>
      validateRecordingMetadata(
        { ...recording.metadata, ...patch },
        recording.data.byteLength,
      ),
    ).toThrow();
  });

  it("rejects unknown/contradictory identity, forged verified-image digest and absent scaling rather than guessing Q11", async () => {
    const { recording, session } = await bladeRfRecordingFixture();
    if (recording.metadata.format !== BLADERF_SC16_RECORDING_FORMAT)
      throw new Error("fixture");
    const metadata = recording.metadata;
    for (const patch of [
      { model: "xA6" },
      { detection: undefined },
      {
        detection: {
          ...metadata.hardware.identity.detection,
          calibrationValue: "A9",
        },
      },
      {
        volatileImage: {
          model: "xA4",
          version: "0.16.0",
          sha256: "0".repeat(64),
        },
      },
      { detection: { ...metadata.hardware.identity.detection, flash: {} } },
    ]) {
      expect(() =>
        validateRecordingMetadata(
          {
            ...metadata,
            hardware: {
              ...metadata.hardware,
              identity: { ...metadata.hardware.identity, ...patch },
            },
          },
          recording.data.byteLength,
        ),
      ).toThrow();
    }
    const { recording: legacy } = await bladeRfRecordingFixture(
      undefined,
      2_400_000,
      "xA4",
      4,
    );
    if (legacy.metadata.format !== BLADERF_SC16_RECORDING_FORMAT)
      throw new Error("fixture");
    const legacyMetadata = legacy.metadata;
    const { selectBladeRfImage } = await import("./bladerfImages");
    const image = selectBladeRfImage("xA4", { major: 2, minor: 4 });
    expect(() =>
      validateRecordingMetadata(
        {
          ...legacyMetadata,
          hardware: {
            ...legacyMetadata.hardware,
            identity: {
              ...legacyMetadata.hardware.identity,
              fpga: { major: 0, minor: 15, patch: 0 },
              volatileImage: {
                model: image.model,
                version: image.version,
                sha256: image.sha256,
              },
            },
          },
        },
        legacy.data.byteLength,
      ),
    ).toThrow();
    const exported = await createSigmfExport(recording);
    delete exported.metadata.global["browsersdr:sample_format"];
    await expect(
      importSigmfRecording(JSON.stringify(exported.metadata), recording.data, {
        modeSettings: defaultModeSettings("OFF"),
      }),
    ).rejects.toThrow(/format\/scaling/);
    expect(() => new IqRecorder(session)).toThrow(/native SC16 Q11/);
  });
});
