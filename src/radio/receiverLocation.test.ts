import { describe, expect, it } from "vitest";
import {
  locationFromBrowser,
  locationIsStale,
  snapshotReceiverLocation,
  validateReceiverLocation,
  type ReceiverLocation,
} from "./receiverLocation";
import { IqRecorder, validateRecordingMetadata } from "./iqRecording";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import { inspectBrowserSigmfForAtlas } from "./atlasSigmfCompatibility";
import { defaultModeSettings } from "./receiverConfig";
import type { SourceSessionMetadata } from "./types";
import {
  createSurveyRunSnapshot,
  DEFAULT_SURVEY_PROFILE,
  validateSurveyProfile,
} from "./fieldSurvey";
const site: ReceiverLocation = {
  version: 1,
  latitude: 48.1,
  longitude: 11.7,
  source: "browser",
  observedAt: "2026-10-09T12:00:00.000Z",
  accuracyMeters: 12,
  label: "Synthetic site",
};
const session: SourceSessionMetadata = {
  source: "synthetic",
  sessionGeneration: 1,
  requestedSampleRateHz: 48_000,
  actualSampleRateHz: 48_000,
  hardwareCenterFrequencyHz: 10_000_000,
  selectedChannelFrequencyHz: 10_006_000,
  mode: "AM",
  channelBandwidthHz: 10_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
describe("receiver site provenance", () => {
  it("bounds coordinates, sources, timestamps and accuracy without string coercion", () => {
    for (const change of [
      { latitude: 91 },
      { longitude: -181 },
      { latitude: "48" },
      { accuracyMeters: -1 },
      { accuracyMeters: Infinity },
      { source: "ip" },
      { observedAt: "yesterday" },
      { snapshotAt: true },
      { stale: "false" },
      { version: 2 },
    ])
      expect(() => validateReceiverLocation({ ...site, ...change })).toThrow();
    expect(
      validateReceiverLocation({
        version: 1,
        latitude: 0,
        longitude: 0,
        source: "manual",
      }).accuracyMeters,
    ).toBeUndefined();
    expect(locationIsStale(site, Date.parse(site.observedAt!) + 300_001)).toBe(
      true,
    );
    expect(locationIsStale(site, Date.parse(site.observedAt!) + 299_999)).toBe(
      false,
    );
    expect(locationIsStale({ ...site, source: "manual" }, Date.now())).toBe(
      false,
    );
    expect(() =>
      locationFromBrowser({
        coords: {
          latitude: 0,
          longitude: 0,
          accuracy: NaN,
        } as GeolocationCoordinates,
        timestamp: Date.now(),
      }),
    ).toThrow();
  });
  it("snapshots at recorder creation and rejects inconsistent survey provenance", () => {
    const chosen = { ...site };
    const recorder = new IqRecorder(
      session,
      "2026-10-09T12:06:00.000Z",
      undefined,
      undefined,
      undefined,
      undefined,
      "memory",
      { receiverLocation: chosen },
    );
    chosen.latitude = 50;
    recorder.appendNormalized({
      I: new Float32Array(64),
      Q: new Float32Array(64),
    });
    const recording = recorder.finish("user")!;
    expect(recording.metadata.receiverLocation).toEqual({
      ...site,
      snapshotAt: "2026-10-09T12:06:00.000Z",
      stale: true,
    });
    expect(() =>
      validateRecordingMetadata(
        {
          ...recording.metadata,
          receiverLocation: { ...site, longitude: 999 },
        },
        recording.data.byteLength,
      ),
    ).toThrow();
    const profile = {
      ...DEFAULT_SURVEY_PROFILE,
      site: {
        label: "Test",
        latitude: site.latitude,
        longitude: site.longitude,
        location: { ...site },
      },
    };
    const survey = createSurveyRunSnapshot(profile, profile.bands, session);
    profile.site.location.latitude = 51;
    expect(survey.profile.site.location?.latitude).toBe(48.1);
    expect(() => validateSurveyProfile(profile)).toThrow(/disagree/);
  });
  it("exports GeoJSON longitude-first and round-trips exact site provenance and original bytes", async () => {
    const recording = createDeterministicRecordingFixture(64);
    recording.metadata.receiverLocation = snapshotReceiverLocation(
      site,
      "2026-10-09T12:01:00.000Z",
    );
    const pair = await createSigmfExport(recording);
    if (process.env.GEO1_RECORD_FIXTURE === "1") {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        ".local/geo1-2026-10-09/site.sigmf-meta",
        pair.metadataJson,
      );
      await writeFile(".local/geo1-2026-10-09/site.sigmf-data", pair.data);
    }
    expect(pair.metadata.captures[0]?.["core:geolocation"]).toEqual({
      type: "Point",
      coordinates: [11.7, 48.1],
    });
    expect(pair.metadata.global["core:extensions"]).toEqual([
      { name: "browsersdr", version: "1.0.0", optional: true },
    ]);
    const imported = await importSigmfRecording(pair.metadataJson, pair.data, {
      modeSettings: defaultModeSettings("AM"),
    });
    expect(imported.metadata.receiverLocation).toEqual(
      recording.metadata.receiverLocation,
    );
    expect(imported.importedSigmf?.metadataText).toBe(pair.metadataJson);
    const reexport = await createSigmfExport(imported);
    expect(
      reexport.metadata.captures[0]?.["browsersdr:receiver_location"],
    ).toEqual(recording.metadata.receiverLocation);
    expect(reexport.data).toEqual(recording.data);
    expect(reexport.metadata.global["core:sha512"]).toBe(
      pair.metadata.global["core:sha512"],
    );
    expect(
      await inspectBrowserSigmfForAtlas(pair.metadata, pair.data),
    ).toMatchObject({
      archiveEligible: true,
      analysisEligible: true,
      quarantine: false,
    });
    const tampered = structuredClone(pair.metadata);
    tampered.captures[0]!["browsersdr:receiver_location"]!.latitude = 47;
    await expect(
      importSigmfRecording(JSON.stringify(tampered), pair.data, {
        modeSettings: defaultModeSettings("AM"),
      }),
    ).rejects.toThrow(/disagrees/);
  });
  it("does not invent accuracy or a fix time for imported core-only sites", async () => {
    const pair = await createSigmfExport(
      createDeterministicRecordingFixture(64),
    );
    pair.metadata.captures[0]!["core:geolocation"] = {
      type: "Point",
      coordinates: [0, 0],
    };
    const imported = await importSigmfRecording(
      JSON.stringify(pair.metadata),
      pair.data,
      { modeSettings: defaultModeSettings("AM") },
    );
    expect(imported.metadata.receiverLocation).toEqual({
      version: 1,
      latitude: 0,
      longitude: 0,
      source: "imported",
    });
    pair.metadata.captures.push({
      "core:sample_start": 32,
      "core:frequency": recordingFrequency(pair.metadata),
      "core:geolocation": { type: "Point", coordinates: [1, 1] },
    });
    await expect(
      importSigmfRecording(JSON.stringify(pair.metadata), pair.data, {
        modeSettings: defaultModeSettings("AM"),
      }),
    ).rejects.toThrow(/moving/);
  });
});
function recordingFrequency(
  metadata: Awaited<ReturnType<typeof createSigmfExport>>["metadata"],
) {
  return metadata.captures[0]!["core:frequency"];
}

it("preserves imported altitude and global fallback without inventing browser evidence", async () => {
  const pair = await createSigmfExport(createDeterministicRecordingFixture(64));
  const metadata = {
    ...pair.metadata,
    global: {
      ...pair.metadata.global,
      "core:geolocation": { type: "Point", coordinates: [11, 48, 520] },
    },
  };
  const imported = await importSigmfRecording(
    JSON.stringify(metadata),
    pair.data,
    { modeSettings: defaultModeSettings("AM") },
  );
  expect(imported.metadata.receiverLocation).toEqual({
    version: 1,
    latitude: 48,
    longitude: 11,
    altitudeMeters: 520,
    source: "imported",
  });
  expect(
    (await createSigmfExport(imported)).metadata.captures[0]?.[
      "core:geolocation"
    ],
  ).toEqual({ type: "Point", coordinates: [11, 48, 520] });
  metadata.global["core:geolocation"].coordinates[2] = NaN;
  await expect(
    importSigmfRecording(JSON.stringify(metadata), pair.data, {
      modeSettings: defaultModeSettings("AM"),
    }),
  ).rejects.toThrow(/altitude/);
});
