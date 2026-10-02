import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contractSnapshot from "../../docs/implementation/atlas-integration/fixtures/p0-01-contract-snapshot.json";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { unknownCi8Format } from "./ci8Recording";
import { IqRecorder, type IqRecording } from "./iqRecording";
import { usrpB205Ci16RecordingFormat } from "./ci16Recording";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import {
  ATLAS_INTEGRATION_CONTRACT_VERSION,
  ATLAS_INTEGRATION_SCHEMA_ARTIFACT_SHA256,
  ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256,
  inspectBrowserSigmfForAtlas,
} from "./atlasSigmfCompatibility";
import { createSigmfExport, type SigmfMetadata } from "./sigmf";

const fixtureUrl = new URL("../../docs/implementation/atlas-integration/fixtures/browsersdr-cu8-v1.json", import.meta.url);

async function productionFixture() {
  const recording = createDeterministicRecordingFixture(64);
  recording.metadata.survey = {
    sessionId: "bsd-01-fixture",
    profileName: "BSD-01 deterministic survey",
    site: { label: "Contract lab", latitude: 48.1, longitude: 11.7, antenna: "test dipole", notes: "Synthetic fixture; no RF measurement." },
    bandName: "Contract band",
    detector: "average",
    signal: { label: "Synthetic AM fixture", modulation: "AM", encoding: "unknown", confidence: "low" },
  };
  const exported = await createSigmfExport(recording);
  return {
    contract_version: ATLAS_INTEGRATION_CONTRACT_VERSION,
    schema_digest_sha256: ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256,
    basename: exported.basename,
    data_base64: Buffer.from(exported.data).toString("base64"),
    data_byte_length: String(exported.data.byteLength),
    data_sha256: createHash("sha256").update(exported.data).digest("hex"),
    data_sha512: exported.metadata.global["core:sha512"],
    metadata: exported.metadata,
  };
}

async function checkedFixture(): Promise<Awaited<ReturnType<typeof productionFixture>>> {
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as Awaited<ReturnType<typeof productionFixture>>;
}

describe("SigIntAtlas BrowserSDR contract parity", () => {
  it("pins the actual shared schema identity and P0 examples", () => {
    expect(contractSnapshot).toMatchObject({
      contract_version: ATLAS_INTEGRATION_CONTRACT_VERSION,
      schema_digest_sha256: ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256,
      schema_artifact_sha256: ATLAS_INTEGRATION_SCHEMA_ARTIFACT_SHA256,
    });
    expect(contractSnapshot.examples.contiguous_cu8.expected).toEqual({ archive_eligible: true, analysis_eligible: true });
    expect(contractSnapshot.examples.structured_gap.expected).toEqual({
      archive_eligible: true,
      analysis_eligible: false,
      error_code: "structured_gap_unsupported",
    });
  });

  it("reproduces the checked fixture through the production exporter", async () => {
    const actual = await productionFixture();
    if (process.env.BSD01_UPDATE_FIXTURES === "1") {
      const path = fileURLToPath(fixtureUrl);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const generatedFixture = await checkedFixture();
    expect(actual).toEqual(generatedFixture);
    const bytes = Buffer.from(generatedFixture.data_base64, "base64");
    expect(String(bytes.byteLength)).toBe(generatedFixture.data_byte_length);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(generatedFixture.data_sha256);
    expect(createHash("sha512").update(bytes).digest("hex")).toBe(generatedFixture.data_sha512);
    expect(generatedFixture.metadata.global).toMatchObject({
      "core:datatype": "cu8",
      "core:sample_rate": 48_000,
      "core:version": "1.2.6",
    });
    expect(generatedFixture.metadata.captures[0]).toMatchObject({
      "core:sample_start": 0,
      "core:datetime": "2026-09-08T00:00:00.000Z",
    });
    expect(generatedFixture.metadata.annotations.every((item) =>
      item["core:sample_start"] + item["core:sample_count"] <= 64,
    )).toBe(true);
    expect(generatedFixture.metadata.annotations[0]?.["core:comment"]).toContain("receiver settings, not calibrated RF measurements");
    expect(generatedFixture.metadata.annotations[1]?.["core:comment"]).toContain("Receiver mode is not treated as proof");
  });

  it("separates contiguous CU8 analysis readiness from integrity quarantine", async () => {
    const exported = await createSigmfExport(createDeterministicRecordingFixture(64));
    await expect(inspectBrowserSigmfForAtlas(exported.metadata, exported.data)).resolves.toMatchObject({
      archiveEligible: true,
      analysisEligible: true,
      quarantine: false,
      byteLength: "128",
      sampleCount: "64",
      issues: [],
    });
    const tampered = new Uint8Array(exported.data);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(inspectBrowserSigmfForAtlas(exported.metadata, tampered)).resolves.toMatchObject({
      archiveEligible: false,
      analysisEligible: false,
      quarantine: true,
      issues: [{ code: "integrity_failed" }],
    });
  });

  it("keeps known and unknown gaps archive-only without manufacturing continuity", async () => {
    const recording = createDeterministicRecordingFixture(64);
    recording.metadata.knownGaps = [
      { afterSample: 16, missingSamples: 5, reason: "known queue loss" },
      { afterSample: 32, missingSamples: null, reason: "unknown device pause" },
    ];
    const exported = await createSigmfExport(recording);
    const compatibility = await inspectBrowserSigmfForAtlas(exported.metadata, exported.data);
    expect(compatibility).toMatchObject({ archiveEligible: true, analysisEligible: false, quarantine: false });
    expect(compatibility.issues).toContainEqual(expect.objectContaining({ code: "structured_gap_unsupported" }));
    expect(exported.metadata.captures).toContainEqual(expect.objectContaining({
      "core:sample_start": 16,
      "core:global_index": 21,
    }));
    expect(exported.metadata.annotations).toContainEqual(expect.objectContaining({
      "core:sample_start": 32,
      "core:sample_count": 0,
      "core:label": "gap",
      "core:comment": expect.stringContaining("unknown duration"),
    }));
  });

  it("accepts contiguous capture transitions but reports native ci8 as archive-only", async () => {
    const cu8 = await createSigmfExport(createDeterministicRecordingFixture(64));
    const transition = structuredClone(cu8.metadata);
    transition.captures.push({ "core:sample_start": 32, "core:frequency": 10_000_000, "core:global_index": 32 });
    await expect(inspectBrowserSigmfForAtlas(transition, cu8.data)).resolves.toMatchObject({
      archiveEligible: true,
      analysisEligible: true,
      issues: [],
    });

    const base = createDeterministicRecordingFixture(64);
    const { gainDb: _gainDb, ...commonMetadata } = base.metadata;
    const ci8: IqRecording = {
      data: new Uint8Array(base.data),
      metadata: {
        ...commonMetadata,
        ...unknownCi8Format(base.metadata.sampleRateHz),
        source: "replay",
      },
    };
    const signed = await createSigmfExport(ci8);
    expect(signed.metadata.global["core:datatype"]).toBe("ci8");
    await expect(inspectBrowserSigmfForAtlas(signed.metadata, signed.data)).resolves.toMatchObject({
      archiveEligible: true,
      analysisEligible: false,
      issues: [{ code: "datatype_unsupported" }],
    });
  });

  it("accepts contiguous USRP ci16_le for Atlas analysis", async () => {
    const details = usrpB205SessionDetails();
    const recorder = new IqRecorder({
      source: "usrp-b205",
      sessionGeneration: 1,
      requestedSampleRateHz: details.nativeSampleRateHz,
      actualSampleRateHz: details.nativeSampleRateHz,
      hardwareCenterFrequencyHz: details.configuration.acceptedCenterFrequencyHz,
      selectedChannelFrequencyHz: details.configuration.acceptedCenterFrequencyHz,
      mode: "AM",
      channelBandwidthHz: 10_000,
      squelch: 0,
      gainDb: null,
      sampleFormat: "planar-f32-iq-normalized",
      usrpB205: details,
    }, undefined, 1024, undefined, undefined, usrpB205Ci16RecordingFormat(details));
    recorder.appendUsrpSc16(Uint8Array.of(0x00, 0x80, 0xff, 0x7f, 0x34, 0x12, 0xcc, 0xed));
    const recording = recorder.finish();
    const exported = await createSigmfExport(recording);
    expect(exported.data).toEqual(Uint8Array.of(0xff, 0x7f, 0x00, 0x80, 0xcc, 0xed, 0x34, 0x12));
    expect(exported.metadata.global["core:datatype"]).toBe("ci16_le");
    await expect(inspectBrowserSigmfForAtlas(exported.metadata, exported.data)).resolves.toMatchObject({
      archiveEligible: true,
      analysisEligible: true,
      sampleCount: "2",
      issues: [],
    });
  });

  it("rejects inconsistent source counts before export and out-of-range annotations at parity inspection", async () => {
    const inconsistent = createDeterministicRecordingFixture(64);
    inconsistent.metadata.sampleCount = 63;
    await expect(createSigmfExport(inconsistent)).rejects.toThrow(/sample count does not match/);

    const exported = await createSigmfExport(createDeterministicRecordingFixture(64));
    const invalid = structuredClone(exported.metadata) as SigmfMetadata;
    invalid.annotations[0]!["core:sample_count"] = 65;
    await expect(inspectBrowserSigmfForAtlas(invalid, exported.data)).resolves.toMatchObject({
      archiveEligible: false,
      analysisEligible: false,
      issues: [{ code: "layout_invalid" }],
    });
  });

  it("keeps the fixture readable without any sibling checkout", async () => {
    await expect(checkedFixture()).resolves.toEqual(await productionFixture());
  });
});
