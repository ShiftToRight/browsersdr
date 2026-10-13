// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommunityCompatibility } from "./CommunityCompatibility";
import { readCommunityMatrix } from "../diagnostics/communityReports";
import type {
  CommunityCell,
  CommunityMatrix,
} from "../diagnostics/communityTypes";
import type { CompatibilityReportContext } from "../diagnostics/compatibilityTypes";
vi.mock("../diagnostics/communityReports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diagnostics/communityReports")>()),
  readCommunityMatrix: vi.fn(),
}));
const context: CompatibilityReportContext = {
  source: "synthetic",
  deviceProfile: "Demo",
  mode: "WBFM",
  lifecycle: "idle",
  sampleRateHz: 2400000,
  nativeSampleRateHz: null,
  bandwidthHz: 180000,
  squelch: 0,
  gainMode: "not-applicable",
  gainDb: null,
  lnaGainCode: null,
  vgaGainDb: null,
  rfAmplifierEnabled: null,
  antennaPowerEnabled: null,
  firmwareVersion: null,
  usbApiVersion: null,
  protocolProfile: null,
  recordingActive: false,
  audioState: null,
};
it("refreshes only while visible and aborts and removes its poll when Help unmounts", async () => {
  const spy = vi.mocked(readCommunityMatrix);
  spy.mockResolvedValue({
    schemaVersion: 1,
    generatedAt: "2026-10-12T00:00:00.000Z",
    builds: [],
    cells: [],
    engineChecks: [],
    buildId: null,
  });
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () =>
      root.render(<CommunityCompatibility context={context} />),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const signal = spy.mock.calls[1]![1]!;
    hidden = true;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    hidden = false;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(spy).toHaveBeenCalledTimes(3);
    const last = spy.mock.calls[2]![1]!;
    await act(async () => root.unmount());
    expect(last.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(spy).toHaveBeenCalledTimes(3);
  } finally {
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("shows one B205mini-i row in both views while retaining alias evidence without combining confirmations", async () => {
  const build = {
    id: "usrp-matrix-fixture",
    version: "1.0.0",
    builtAt: "2026-10-13T00:00:00.000Z",
  };
  const cells: CommunityCell[] = (
    ["usrp-b205-mini", "usrp-b205mini-i", "usrp-unknown"] as const
  ).flatMap((hardwareId) =>
    ([null, "Chrome 154 / Linux"] as const).map((platform) => ({
      key: `${hardwareId}-${platform}`,
      hardwareId,
      feature: platform ? "access" : "adsb",
      setup: {
        source: "usrp-b205",
        hardwareId,
        mode: "ADS-B",
        srdProtocol: null,
        rateHz: 2400000,
        nativeRateHz: 2400000,
        protocolProfile: null,
        firmwareVersion: null,
        origin: "live",
      },
      testScope: "smoke",
      platform,
      working: 1,
      eligibleWorking: 1,
      problems: 0,
      status: "working",
      lastAt: build.builtAt,
      reports: [],
    })),
  );
  const matrix: CommunityMatrix = {
    schemaVersion: 1,
    generatedAt: build.builtAt,
    builds: [build],
    buildId: build.id,
    cells,
    engineChecks: [],
  };
  vi.mocked(readCommunityMatrix).mockResolvedValue(matrix);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const buttons = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
  const rowNames = () =>
    Array.from(host.querySelectorAll('th[scope="row"]')).map(
      (row) => row.textContent,
    );
  try {
    await act(async () =>
      root.render(<CommunityCompatibility context={context} />),
    );
    expect(rowNames().filter((name) => name?.includes("B205"))).toEqual([
      "USRP B205mini-i",
    ]);
    expect(rowNames()).toContain("USRP · unknown variant");
    const reception = buttons().find(
      (button) =>
        button.getAttribute("aria-label") ===
        "USRP B205mini-i · ADS-B 1090: Setup reports",
    )!;
    expect(reception.textContent).toBe("2 setupsSetup reports");
    await act(async () => reception.click());
    expect(
      host.querySelectorAll(".community-details .community-case"),
    ).toHaveLength(2);
    await act(async () =>
      buttons()
        .find((button) => button.textContent === "Platform compatibility")!
        .click(),
    );
    expect(rowNames().filter((name) => name?.includes("B205"))).toEqual([
      "USRP B205mini-i",
    ]);
    expect(
      buttons().find(
        (button) =>
          button.getAttribute("aria-label") ===
          "USRP B205mini-i · Chrome 154 / Linux: Setup reports",
      )?.textContent,
    ).toBe("2 setupsSetup reports");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
