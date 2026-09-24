import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import schema from "../../docs/vendor/sigmf-v1.2.6/sigmf-schema.json";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { buildSigmfMetadata, createSigmfExport } from "./sigmf";

const FIXTURE_SHA512 = "a936ed1c87e6a2fbc496648647710738fac157a3cc906f0d6af12953be19559973ad88893163861bf12e0f3f8f7ca1a0eacba9ec3b2c141e47316afea210f533";

describe("SigMF v1.2.6 export", () => {
  it("exports the fixture bytes unchanged with a known SHA-512 and safe paired names", async () => {
    const recording = createDeterministicRecordingFixture(4096);
    const original = new Uint8Array(recording.data);
    const exported = await createSigmfExport(recording);

    expect(exported.data).toBe(recording.data);
    expect(exported.data).toEqual(original);
    expect(recording.data).toEqual(original);
    expect(exported.metadata.global["core:sha512"]).toBe(FIXTURE_SHA512);
    expect(exported.dataFilename).toBe(`${exported.basename}.sigmf-data`);
    expect(exported.metadataFilename).toBe(`${exported.basename}.sigmf-meta`);
    expect(exported.basename).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses the capture center and describes the selected channel with RF edges", async () => {
    const recording = createDeterministicRecordingFixture(128);
    const metadata = await buildSigmfMetadata(recording);
    expect(Object.keys(metadata)).toEqual(["global", "captures", "annotations"]);
    expect(metadata.global).toMatchObject({
      "core:datatype": "cu8",
      "core:version": "1.2.6",
      "core:sample_rate": 48_000,
    });
    expect(metadata.global).not.toHaveProperty("core:dataset");
    expect(metadata.captures[0]).toEqual({
      "core:sample_start": 0,
      "core:frequency": 10_000_000,
      "core:datetime": "2026-09-08T00:00:00.000Z",
      "core:global_index": 0,
    });
    expect(metadata.annotations.find((entry) => entry["core:label"] === "AM")).toMatchObject({
      "core:sample_start": 0,
      "core:sample_count": 128,
      "core:freq_lower_edge": 9_998_500,
      "core:freq_upper_edge": 10_013_500,
    });
  });

  it("consolidates gaps, accumulates known indices, and stops inventing indices after an unknown gap", async () => {
    const recording = createDeterministicRecordingFixture(128);
    recording.metadata.knownGaps = [
      { afterSample: 10, missingSamples: 3, reason: "queue drop" },
      { afterSample: 10, missingSamples: 5, reason: "second drop" },
      { afterSample: 20, missingSamples: 2, reason: "late block" },
      { afterSample: 30, missingSamples: null, reason: "device reset" },
      { afterSample: 40, missingSamples: 4, reason: "post-reset drop" },
    ];
    const metadata = await buildSigmfMetadata(recording);
    expect(metadata.captures).toEqual([
      expect.objectContaining({ "core:sample_start": 0, "core:global_index": 0 }),
      expect.objectContaining({ "core:sample_start": 10, "core:global_index": 18 }),
      expect.objectContaining({ "core:sample_start": 20, "core:global_index": 30 }),
    ]);
    const gaps = metadata.annotations.filter((entry) => entry["core:label"] === "gap");
    expect(gaps.map((entry) => entry["core:sample_start"])).toEqual([10, 20, 30, 40]);
    expect(gaps[0]?.["core:comment"]).toContain("8 missing samples");
    expect(gaps[2]?.["core:comment"]).toContain("unknown duration");
    expect(metadata.annotations.map((entry) => entry["core:sample_start"])).toEqual([0, 10, 20, 30, 40]);
  });

  it("merges initial gaps into the first capture without duplicating sample zero", async () => {
    const known = createDeterministicRecordingFixture(32);
    known.metadata.knownGaps = [{ afterSample: 0, missingSamples: 7, reason: "initial loss" }];
    expect((await buildSigmfMetadata(known)).captures).toEqual([expect.objectContaining({
      "core:sample_start": 0,
      "core:global_index": 7,
    })]);

    const unknown = createDeterministicRecordingFixture(32);
    unknown.metadata.knownGaps = [{ afterSample: 0, missingSamples: null, reason: "unknown initial loss" }];
    expect((await buildSigmfMetadata(unknown)).captures[0]).not.toHaveProperty("core:global_index");
  });

  it("truthfully records provenance, quantization, replay normalization, and generic RTL hardware", async () => {
    const synthetic = createDeterministicRecordingFixture(32);
    const syntheticMetadata = await buildSigmfMetadata(synthetic);
    expect(syntheticMetadata.global["core:description"]).toContain("quantized");
    expect(syntheticMetadata.global["core:description"]).toContain("Provenance:");
    expect(syntheticMetadata.global).not.toHaveProperty("core:hw");

    const replay = { ...synthetic, metadata: { ...synthetic.metadata, source: "replay" as const } };
    expect((await buildSigmfMetadata(replay)).global["core:description"]).toContain("copied unchanged");

    const rtl = { ...synthetic, metadata: { ...synthetic.metadata, source: "rtl-sdr" as const, provenance: undefined } };
    const rtlMetadata = await buildSigmfMetadata(rtl);
    expect(rtlMetadata.global["core:hw"]).toBe("RTL-SDR via WebUSB");
    expect(rtlMetadata.global["core:hw"]).not.toMatch(/tuner|antenna|serial|model/i);
  });

  it("adds opt-in survey location, classification, and meaningful paired filenames", async () => {
    const recording = createDeterministicRecordingFixture(64);
    recording.metadata.survey = {
      sessionId: "survey-test",
      profileName: "Portable survey",
      site: { label: "Munich East", latitude: 48.1, longitude: 11.7, antenna: "dipole" },
      bandName: "FM broadcast",
      detector: "average",
      signal: { label: "Bayern 2", modulation: "WBFM", encoding: "RDS", confidence: "high" },
    };
    const exported = await createSigmfExport(recording);
    expect(exported.basename).toContain("munich-east");
    expect(exported.metadata.captures[0]?.["core:geolocation"]).toEqual({ type: "Point", coordinates: [11.7, 48.1] });
    expect(exported.metadata.annotations.find((entry) => entry["core:label"] === "Bayern 2")?.["core:comment"]).toContain("encoding RDS");
  });

  it("is deterministic, does not mutate its input, and validates against the vendored official schema", async () => {
    const recording = createDeterministicRecordingFixture(64);
    const before = structuredClone(recording.metadata);
    const first = await createSigmfExport(recording);
    const second = await createSigmfExport(recording);
    expect(second.metadataJson).toBe(first.metadataJson);
    expect(recording.metadata).toEqual(before);

    // The upstream schema contains a legacy decimal escape in its timestamp
    // pattern, so compile it without the ECMAScript Unicode regexp flag.
    const ajv = new Ajv2020({ strict: false, allErrors: true, unicodeRegExp: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(first.metadata), JSON.stringify(validate.errors)).toBe(true);
  });
});
