// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { parseRecording } from "./iqRecording";
import {
  createRecordingArchive, formatControlDisabled, prepareRecordingExport,
  RecordingExportCoordinator, RecordingFormatLatch, triggerRecordingDownloads,
} from "./recordingExport";

/** Minimal independent ZIP store reader used only to verify fflate output. */
function readStoredZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= archive.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (method !== 0) throw new Error("Expected an uncompressed ZIP entry");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLength));
    files.set(name, archive.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return files;
}

describe("recording export lifecycle", () => {
  it("captures the selected format for a segment and locks the control while recording", () => {
    const latch = new RecordingFormatLatch();
    latch.begin("sigmf");
    expect(latch.locked).toBe(true);
    expect(formatControlDisabled({ state: "recording", bytes: 0, maxBytes: 10, sampleCount: 0 }, false)).toBe(true);
    expect(latch.complete("browsersdr")).toBe("sigmf");
  });

  it.each(["browsersdr", "sigmf"] as const)("creates a matching %s archive readable without fflate", async (format) => {
    const recording = createDeterministicRecordingFixture(4096);
    const prepared = await prepareRecordingExport(recording, format);
    const archive = createRecordingArchive(prepared);
    const files = readStoredZip(archive.contents as Uint8Array);
    expect([...files.keys()]).toEqual(prepared.files.map((file) => file.name));
    expect(files.get(prepared.files[0].name)).toEqual(recording.data);
    const metadataText = new TextDecoder().decode(files.get(prepared.files[1].name));
    if (format === "browsersdr") {
      expect(parseRecording(metadataText, files.get(prepared.files[0].name)!)).toEqual(recording);
    } else {
      const metadata = JSON.parse(metadataText) as { global: Record<string, unknown>; captures: unknown[]; annotations: unknown[] };
      expect(metadata.global).toMatchObject({ "core:datatype": "cu8", "core:version": "1.2.6", "core:sample_rate": recording.metadata.sampleRateHz });
      expect(metadata.global["core:sha512"]).toMatch(/^[a-f0-9]{128}$/);
      expect(metadata.captures.length).toBeGreaterThan(0);
      expect(metadata.annotations.length).toBeGreaterThan(0);
    }
  });

  it("deduplicates completion and never overwrites an unrequested prepared capture", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new RecordingExportCoordinator(async (recording, format) => { await gate; return prepareRecordingExport(recording, format); });
    const firstRecording = createDeterministicRecordingFixture(128);
    const first = coordinator.retain(firstRecording, "sigmf");
    expect((await coordinator.retain(firstRecording, "sigmf")).status).toBe("duplicate");
    expect((await coordinator.retain(createDeterministicRecordingFixture(64), "browsersdr")).status).toBe("busy");
    release();
    expect((await first).status).toBe("prepared");
    expect((await coordinator.retain(createDeterministicRecordingFixture(64), "browsersdr")).status).toBe("blocked");
  });

  it("retains preparation failures for retry", async () => {
    const realPrepare = prepareRecordingExport;
    const prepare = vi.fn().mockRejectedValueOnce(new Error("Hash failed")).mockImplementation(realPrepare);
    const coordinator = new RecordingExportCoordinator(prepare);
    expect(await coordinator.retain(createDeterministicRecordingFixture(64), "sigmf")).toMatchObject({ status: "failure" });
    expect(coordinator.getSnapshot()).toMatchObject({ status: "retry-available", error: "Hash failed" });
    expect((await coordinator.retryPreparation()).status).toBe("prepared");
  });

  it("keeps prepared bytes after repeated download requests and labels requests truthfully", async () => {
    const coordinator = new RecordingExportCoordinator();
    const recording = createDeterministicRecordingFixture(64);
    await coordinator.retain(recording, "browsersdr");
    const download = vi.fn();
    expect(coordinator.requestDownload("archive", download)).toMatchObject({ status: "download-requested", kind: "archive" });
    expect(coordinator.requestDownload("archive", download)).toMatchObject({ status: "download-requested" });
    expect(download).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toMatchObject({ status: "download-requested", downloadRequests: 2, sampleCount: recording.metadata.sampleCount });
    expect(coordinator.getSnapshot().retainedBytes).toBeGreaterThan(recording.data.byteLength);
  });

  it("allows disclosed replacement only after a download was requested, and supports discard", async () => {
    const coordinator = new RecordingExportCoordinator();
    await coordinator.retain(createDeterministicRecordingFixture(64), "browsersdr");
    coordinator.requestDownload("separate", undefined, vi.fn());
    expect((await coordinator.retain(createDeterministicRecordingFixture(32), "sigmf")).status).toBe("prepared");
    coordinator.discard();
    expect(coordinator.getSnapshot()).toEqual({ status: "discarded", retainedBytes: 0, downloadRequests: 0 });
  });

  it("prepares both object URLs before requesting two compatible downloads", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:data").mockReturnValueOnce("blob:meta");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    triggerRecordingDownloads({ format: "sigmf", basename: "safe", sampleCount: 1, files: [
      { name: "safe.sigmf-data", contents: new Uint8Array([1, 2]), type: "application/octet-stream" },
      { name: "safe.sigmf-meta", contents: "{}\n", type: "application/json" },
    ] });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks(); vi.useRealTimers();
  });
});
