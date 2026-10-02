import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { CU8_NORMALIZATION, decodeCu8, RECORDING_MAX_BYTES } from "./iqRecording";
import { defaultModeSettings } from "./receiverConfig";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";

const startedAt = "2026-09-24T10:15:30.000Z";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    global: {
      "core:datatype": "cu8",
      "core:version": "1.2.6",
      "core:sample_rate": 48_000,
    },
    captures: [{
      "core:sample_start": 0,
      "core:global_index": 0,
      "core:frequency": 12_000_000,
      "core:datetime": startedAt,
    }],
    annotations: [],
    ...overrides,
  };
}

const options = {
  modeSettings: defaultModeSettings("AM"),
  dataFilename: "fixture.sigmf-data",
  metadataFilename: "fixture.sigmf-meta",
};

describe("bounded SigMF import", () => {
  it("round-trips BrowserSDR bytes, timestamp, frequency, and structured gaps", async () => {
    const original = createDeterministicRecordingFixture(128);
    original.metadata.knownGaps = [
      { afterSample: 0, missingSamples: 3, reason: "initial" },
      { afterSample: 32, missingSamples: 7, reason: "middle" },
      { afterSample: 128, missingSamples: 11, reason: "tail" },
    ];
    const exported = await createSigmfExport(original);
    const imported = await importSigmfRecording(exported.metadataJson, exported.data, options);

    expect(imported.data).toEqual(original.data);
    expect(imported.data).not.toBe(original.data);
    expect(imported.metadata).toMatchObject({
      normalization: CU8_NORMALIZATION,
      sampleRateHz: original.metadata.sampleRateHz,
      centerFrequencyHz: original.metadata.centerFrequencyHz,
      selectedChannelFrequencyHz: original.metadata.centerFrequencyHz,
      captureStartedAt: original.metadata.captureStartedAt,
      source: "replay",
      mode: "AM",
      stopReason: "import",
      knownGaps: [
        { afterSample: 0, missingSamples: 3 },
        { afterSample: 32, missingSamples: 7 },
        { afterSample: 128, missingSamples: 11 },
      ],
    });
    expect(imported.importedSigmf).toEqual({
      metadataText: exported.metadataJson,
      dataFilename: "fixture.sigmf-data",
      metadataFilename: "fixture.sigmf-meta",
    });
  });

  it("imports an independently constructed multi-segment fixture without trusting annotations", async () => {
    const data = Uint8Array.from([0, 255, 127, 128, 64, 192, 32, 224]);
    const value = metadata({
      captures: [
        { "core:sample_start": 0, "core:global_index": 20, "core:frequency": 12_000_000, "core:datetime": startedAt },
        { "core:sample_start": 2, "core:global_index": 25, "core:frequency": 12_000_000, "core:datetime": "2026-09-24T10:15:31Z" },
        { "core:sample_start": 4, "core:global_index": 27, "core:frequency": 12_000_000 },
      ],
      annotations: [{ "core:sample_start": 0, "core:label": "DAB", "core:comment": "mode=DAB selected=99MHz" }],
    });
    const imported = await importSigmfRecording(JSON.stringify(value), data, {
      ...options,
      selectedChannelFrequencyHz: 12_001_000,
    });

    expect(imported.metadata.mode).toBe("AM");
    expect(imported.metadata.selectedChannelFrequencyHz).toBe(12_001_000);
    expect(imported.metadata.knownGaps).toEqual([
      { afterSample: 0, missingSamples: 20, reason: "SigMF global_index discontinuity" },
      { afterSample: 2, missingSamples: 3, reason: "SigMF global_index discontinuity" },
    ]);
    const decoded = decodeCu8(imported.data);
    expect(decoded.I[0]).toBe(-0.99609375);
    expect(decoded.Q[0]).toBe(0.99609375);
  });

  it("validates a supplied SHA-512 and rejects a mismatch", async () => {
    const data = Uint8Array.from([1, 2, 3, 4]);
    const value = metadata();
    const global = value.global as Record<string, unknown>;
    global["core:sha512"] = createHash("sha512").update(data).digest("hex");
    await expect(importSigmfRecording(JSON.stringify(value), data, options)).resolves.toMatchObject({ data });
    global["core:sha512"] = "0".repeat(128);
    await expect(importSigmfRecording(JSON.stringify(value), data, options)).rejects.toThrow(/SHA-512/);
  });

  it.each([
    ["datatype", { global: { ...metadata().global, "core:datatype": "ci16_le" } }, /format\/scaling/i],
    ["channels", { global: { ...metadata().global, "core:num_channels": 2 } }, /exactly one/],
    ["offset", { global: { ...metadata().global, "core:offset": 1 } }, /offset/],
    ["non-conforming data", { global: { ...metadata().global, "core:dataset": "other.bin" } }, /non-conforming/],
    ["required extension", { global: { ...metadata().global, "core:extensions": [{ name: "required", version: "1.0.0", optional: false }] } }, /Required SigMF extension/],
    ["capture header", { captures: [{ ...metadata().captures[0], "core:header_bytes": 2 }] }, /headers/],
    ["changing frequency", { captures: [metadata().captures[0], { "core:sample_start": 1, "core:frequency": 13_000_000 }] }, /change capture frequency/],
    ["backwards index", { captures: [metadata().captures[0], { "core:sample_start": 1, "core:global_index": 0, "core:frequency": 12_000_000 }] }, /cannot precede/],
  ])("rejects unsupported %s metadata", async (_label, overrides, message) => {
    await expect(importSigmfRecording(JSON.stringify(metadata(overrides)), Uint8Array.from([1, 2, 3, 4]), options)).rejects.toThrow(message);
  });

  it("rejects unsupported rate/mode combinations without producing a recording", async () => {
    await expect(importSigmfRecording(JSON.stringify(metadata()), Uint8Array.from([1, 2]), {
      modeSettings: defaultModeSettings("DAB"),
    })).rejects.toThrow(/2.048 MS\/s/);
  });

  it("rejects an oversized dataset before parsing or copying it", async () => {
    const oversized = new Uint8Array(RECORDING_MAX_BYTES + 2);
    await expect(importSigmfRecording("not json", oversized, options)).rejects.toThrow(/32 MiB/);
  });

  it("rejects malformed and oversized metadata", async () => {
    await expect(importSigmfRecording("{", Uint8Array.from([1, 2]), options)).rejects.toThrow(/not valid JSON/);
    const oversized = `${JSON.stringify(metadata())}${" ".repeat(1024 * 1024)}`;
    await expect(importSigmfRecording(oversized, Uint8Array.from([1, 2]), options)).rejects.toThrow(/1 MiB/);
  });

  it.each([
    ["munich_089500_wendelstein_bayern2_wbfm_rds", "WBFM"],
    ["munich_220352_dab11c_partial", "AM"],
    ["munich_434048_srd_unknown_narrowband", "NBFM"],
    ["munich_864000_srd_unknown_narrowband", "NBFM"],
  ] as const)("imports the repository sample %s with an explicit supported %s mode", async (basename, mode) => {
    const base = new URL(`../../samples/munich-2026-09-23/${basename}`, import.meta.url);
    const [metadataText, data] = await Promise.all([
      readFile(new URL(`${base.href}.sigmf-meta`), "utf8"),
      readFile(new URL(`${base.href}.sigmf-data`)),
    ]);
    const imported = await importSigmfRecording(metadataText, data, { ...options, modeSettings: defaultModeSettings(mode) });
    expect(imported.metadata).toMatchObject({ mode, sampleRateHz: 1_024_000, sampleCount: data.byteLength / 2 });
    expect(imported.data.byteLength).toBe(data.byteLength);
    for (const index of [0, 1, 1024, data.byteLength - 2, data.byteLength - 1]) {
      expect(imported.data[index]).toBe(data[index]);
    }
  });
});
