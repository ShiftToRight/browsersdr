// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../deploy/report-service/compatibility-report-schema.json";
import { COMMUNITY_FEATURES, COMMUNITY_HARDWARE } from "./communityCatalog";
import {
  buildCommunityReport,
  communityContextKey,
  communityParticipant,
  isCommunityMatrix,
  readCommunityMatrix,
} from "./communityReports";
import type { CompatibilityReportContext } from "./compatibilityTypes";
import { communityCellSummary } from "../ui/CommunityCompatibility";
import type { CommunityMatrix } from "./communityTypes";

const context: CompatibilityReportContext = {
  source: "hackrf",
  deviceProfile: "HackRF Pro",
  mode: "WBFM",
  lifecycle: "running",
  sampleRateHz: 9600000,
  nativeSampleRateHz: 76800000,
  bandwidthHz: 180000,
  squelch: 0,
  gainMode: "staged",
  gainDb: null,
  lnaGainCode: 16,
  vgaGainDb: 20,
  rfAmplifierEnabled: false,
  antennaPowerEnabled: false,
  firmwareVersion: "v2026.01.3",
  usbApiVersion: 0x110,
  protocolProfile: "hackrf-pro-stable-2026-v1",
  recordingActive: false,
  audioState: "running",
  exactFrequencyHz: 91400000,
};
const build = {
  id: "unit-community-build",
  version: "1.0.0-rc.1",
  builtAt: "2026-10-12T00:00:00.000Z",
};
afterEach(() => vi.restoreAllMocks());
function report() {
  return {
    ...buildCommunityReport(context, {
      hardwareId: "hackrf-pro",
      participantToken: "a".repeat(64),
      durationMinutes: 10,
      observations: [{ feature: "rds", result: "working" }],
      notes: "Private note",
    }),
    build,
  };
}

describe("community wire and public evidence boundaries", () => {
  it("retains an exact experimental RTL setup without borrowing the 2.4 MS/s context", () => {
    const rtl: CompatibilityReportContext = { ...context, source: "rtl-sdr", deviceProfile: "RTL-SDR", sampleRateHz: 3_200_000, nativeSampleRateHz: null, protocolProfile: null, firmwareVersion: null, usbApiVersion: null, gainMode: "manual", gainDb: 25 };
    const input = { ...buildCommunityReport(rtl, { hardwareId: "rtl-nesdr-smart-v5", participantToken: "a".repeat(64), durationMinutes: 1, observations: [{ feature: "rds", result: "degraded" }] }), build };
    expect(input.setup).toMatchObject({ source: "rtl-sdr", rateHz: 3_200_000 });
    expect(communityContextKey(rtl)).not.toBe(communityContextKey({ ...rtl, sampleRateHz: 2_400_000 }));
    const ajv = new Ajv2020(); addFormats(ajv);
    expect(ajv.compile(schema)(input)).toBe(true);
  });
  it("separates processing/native rates, freezes provenance, and omits radio content, location and exact frequency", () => {
    const input = report();
    expect(input.setup).toMatchObject({
      rateHz: 9600000,
      nativeRateHz: 76800000,
    });
    expect(input.setup).not.toHaveProperty("exactFrequencyHz");
    expect(input).not.toHaveProperty("receiver");
    expect(input.receiverDetails).toMatchObject({
      gainMode: "staged",
      vgaGainDb: 20,
      bandwidthHz: 180000,
    });
    expect(input.receiverDetails).not.toHaveProperty("exactFrequencyHz");
    expect(input.browserCapabilities!.webAssembly).toBe(true);
    const ajv = new Ajv2020();
    addFormats(ajv);
    expect(ajv.compile(schema)(input)).toBe(true);
    const previous = communityContextKey(context);
    expect(communityContextKey({ ...context, lifecycle: "connected" })).toBe(
      previous,
    );
    expect(communityContextKey({ ...context, sampleRateHz: 2400000 })).not.toBe(
      previous,
    );
    expect(input.setup.rateHz).toBe(9600000);
  });
  it("keeps catalog wire IDs/modes aligned and unknown hardware distinct", () => {
    const contract = schema.oneOf[1]!.properties!;
    expect(COMMUNITY_FEATURES.map((f) => f.id)).toEqual(
      contract.observations!.items!.properties!.feature!.enum,
    );
    expect(COMMUNITY_HARDWARE.map((h) => h.id)).toEqual(
      contract.setup!.properties.hardwareId.enum,
    );
  });
  it("deduplicates participation per build even with blocked local storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(communityParticipant("blocked-a")).toBe(
      communityParticipant("blocked-a"),
    );
    expect(communityParticipant("blocked-a")).not.toBe(
      communityParticipant("blocked-b"),
    );
  });
  it("rejects poisoned nested rows/links and never sums mixed rates into confirmation", () => {
    const input = report();
    const matrix: CommunityMatrix = {
      schemaVersion: 1,
      generatedAt: build.builtAt,
      builds: [build],
      buildId: build.id,
      engineChecks: [],
      cells: [9600000, 2400000].map((rateHz, i) => ({
        key: String(i),
        hardwareId: "hackrf-pro",
        feature: "rds",
        setup: { ...input.setup, rateHz },
        testScope: "smoke",
        platform: null,
        working: 1,
        eligibleWorking: 1,
        problems: 0,
        status: "working",
        lastAt: build.builtAt,
        reports: [
          {
            result: "working",
            durationMinutes: 10,
            receivedAt: build.builtAt,
            environment: input.environment,
            setup: { ...input.setup, rateHz },
            review: "accepted",
          },
        ],
      })),
    };
    expect(isCommunityMatrix(matrix)).toBe(true);
    expect(communityCellSummary(matrix.cells)).toMatchObject({
      count: "2 setups",
      label: "Setup reports",
    });
    expect(
      isCommunityMatrix({
        ...matrix,
        cells: [{ ...matrix.cells[0], setup: null }],
      }),
    ).toBe(false);
    expect(
      isCommunityMatrix({
        ...matrix,
        engineChecks: [
          {
            feature: "rds",
            result: "passed",
            checkedAt: build.builtAt,
            evidence: "javascript:alert(1)",
          },
        ],
      }),
    ).toBe(false);
    expect(JSON.stringify(matrix)).not.toContain("Private note");
  });
  it("reads anonymously and preserves failure as unavailable, rather than returning an empty pass", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response('{"schemaVersion":1,"cells":[]}', { status: 200 }),
      );
    await expect(readCommunityMatrix(build.id)).rejects.toThrow(
      "Invalid community matrix",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
    fetch.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(readCommunityMatrix(build.id)).rejects.toThrow(
      "unavailable (503)",
    );
  });
  it("validates carried provenance and separates fresh/carried progress without false confirmation", () => {
    const input = report();
    const cell = {
      key: "carry-cell",
      hardwareId: input.setup.hardwareId,
      feature: "rds" as const,
      setup: input.setup,
      testScope: "smoke" as const,
      platform: null,
      working: 1,
      eligibleWorking: 1,
      problems: 0,
      status: "working" as const,
      lastAt: build.builtAt,
      reports: [],
      carried: {
        build: { ...build, id: "original", version: "0.9.0" },
        equivalence: {
          fingerprint: "c".repeat(64),
          checkedAt: build.builtAt,
          evidence: "https://browsersdr.com/equivalence",
        },
        working: 1,
        eligibleWorking: 1,
        problems: 0,
        lastAt: build.builtAt,
        reports: [
          {
            result: "working" as const,
            durationMinutes: 10,
            receivedAt: build.builtAt,
            expiresAt: "2026-12-01T00:00:00Z",
            setup: input.setup,
            environment: input.environment,
            review: "pending" as const,
          },
        ],
      },
    };
    const matrix: CommunityMatrix = {
      schemaVersion: 2,
      generatedAt: build.builtAt,
      builds: [build],
      buildId: build.id,
      cells: [cell],
      engineChecks: [],
    };
    expect(isCommunityMatrix(matrix)).toBe(true);
    expect(communityCellSummary([cell])).toMatchObject({
      count: "1/2",
      label: "Reported working",
    });
    const confirmed = {
      ...cell,
      working: 0,
      eligibleWorking: 0,
      status: "confirmed" as const,
      carried: { ...cell.carried, working: 2, eligibleWorking: 2 },
    };
    expect(isCommunityMatrix({ ...matrix, cells: [confirmed] })).toBe(true);
    expect(communityCellSummary([confirmed])).toMatchObject({
      count: "2/2+",
      label: "Confirmed · carried",
    });
    expect(
      communityCellSummary([
        {
          ...confirmed,
          carried: { ...confirmed.carried, problems: 1 },
          status: "issue",
        },
      ]).label,
    ).toBe("Issue reported");
    for (const poisoned of [
      { ...cell, status: "confirmed" },
      { ...cell, carried: { ...cell.carried, build } },
      {
        ...cell,
        carried: {
          ...cell.carried,
          equivalence: {
            ...cell.carried.equivalence,
            evidence: "javascript:bad",
          },
        },
      },
      {
        ...cell,
        carried: {
          ...cell.carried,
          reports: [{ ...cell.carried.reports[0], expiresAt: "invalid" }],
        },
      },
    ])
      expect(isCommunityMatrix({ ...matrix, cells: [poisoned] })).toBe(false);
    expect(isCommunityMatrix({ ...matrix, schemaVersion: 1 })).toBe(false);
    expect(
      isCommunityMatrix({
        ...matrix,
        carriedEngineChecks: [
          {
            feature: "rds",
            result: "passed",
            checkedAt: build.builtAt,
            evidence: "https://browsersdr.com/reference",
            build: cell.carried.build,
            equivalence: cell.carried.equivalence,
          },
        ],
      }),
    ).toBe(true);
  });
});

it.each([
  ["WEFAX", "wefax"], ["SSTV", "sstv"], ["CW-TEXT", "cw-text"],
] as const)("builds a schema-valid %s report without changing its mode or feature", (mode, feature) => {
  const input = { ...buildCommunityReport({ ...context, mode }, {
    hardwareId: "hackrf-pro", participantToken: "a".repeat(64), durationMinutes: 10,
    observations: [{ feature, result: "working" }],
  }), build };
  const ajv = new Ajv2020(); addFormats(ajv);
  expect(ajv.compile(schema)(input)).toBe(true);
  expect(input.setup.mode).toBe(mode);
  expect(input.observations).toEqual([{ feature, result: "working" }]);
});
