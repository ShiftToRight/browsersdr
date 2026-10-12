// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommunityCompatibility } from "./CommunityCompatibility";
import { readCommunityMatrix } from "../diagnostics/communityReports";
import type { CompatibilityReportContext } from "../diagnostics/compatibilityTypes";
vi.mock("../diagnostics/communityReports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diagnostics/communityReports")>()),
  readCommunityMatrix: vi.fn(),
}));
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
