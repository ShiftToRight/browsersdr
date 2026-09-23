// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import {
  formatControlDisabled,
  RecordingExportCoordinator,
  RecordingFormatLatch,
  triggerRecordingDownloads,
} from "./recordingExport";

describe("recording export lifecycle", () => {
  it("captures the selected format for a segment and locks the control while recording", () => {
    const latch = new RecordingFormatLatch();
    latch.begin("sigmf");
    expect(latch.locked).toBe(true);
    expect(formatControlDisabled({ state: "recording", bytes: 0, maxBytes: 10, sampleCount: 0 }, false)).toBe(true);
    expect(latch.complete("browsersdr")).toBe("sigmf");
    expect(latch.locked).toBe(false);
  });

  it("prevents a duplicate export while hashing", async () => {
    const coordinator = new RecordingExportCoordinator();
    const recording = createDeterministicRecordingFixture(128);
    const downloads = vi.fn();
    const first = coordinator.export(recording, "sigmf", downloads);
    const duplicate = await coordinator.export(recording, "sigmf", downloads);
    expect(duplicate.status).toBe("busy");
    expect((await first).status).toBe("success");
    expect(downloads).toHaveBeenCalledTimes(1);
  });

  it("retains a failed export and retries the same format successfully", async () => {
    const coordinator = new RecordingExportCoordinator();
    const recording = createDeterministicRecordingFixture(64);
    const failed = await coordinator.export(recording, "sigmf", () => { throw new Error("Downloads blocked"); });
    expect(failed).toMatchObject({ status: "failure", error: { message: "Downloads blocked" } });
    expect(coordinator.hasRetry).toBe(true);
    const download = vi.fn();
    const retried = await coordinator.retry(download);
    expect(retried.status).toBe("success");
    expect(download.mock.calls[0]?.[0].format).toBe("sigmf");
    expect(coordinator.hasRetry).toBe(false);
  });

  it("prepares both object URLs before dispatching exactly two paired downloads and then revokes them", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:data").mockReturnValueOnce("blob:meta");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    triggerRecordingDownloads({
      format: "sigmf",
      basename: "safe",
      sampleCount: 1,
      files: [
        { name: "safe.sigmf-data", contents: new Uint8Array([1, 2]), type: "application/octet-stream" },
        { name: "safe.sigmf-meta", contents: "{}\n", type: "application/json" },
      ],
    });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
