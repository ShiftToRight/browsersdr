import { expect, it, vi } from "vitest";
import { ReplayReader } from "./replayReader";
import { parseRecording } from "./iqRecording";
import { prepareRecordingExport } from "./recordingExportFormat";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";

it("round trips an exported file larger than 32 MiB with bounded reads and arbitrary seeks", async () => {
  const bytes = new Uint8Array(40 * 1024 * 1024).fill(131);
  const blob = new Blob([bytes]);
  const wholeRead = vi
    .spyOn(blob, "arrayBuffer")
    .mockRejectedValue(new Error("whole file forbidden"));
  const slice = vi.spyOn(blob, "slice");
  const metadata = createDeterministicRecordingFixture(8).metadata;
  metadata.sampleCount = blob.size / 2;
  metadata.durationSeconds = metadata.sampleCount / metadata.sampleRateHz;
  const exported = await prepareRecordingExport(
    { data: new Uint8Array(), dataBlob: blob, metadata },
    "browsersdr",
  );
  expect(exported.files[0].contents).toBe(blob);
  const recording = parseRecording(
    String(exported.files[1].contents),
    exported.files[0].contents as Blob,
  );
  expect(recording.data.length).toBe(0);
  const reader = new ReplayReader(recording);
  for (const start of [0, 1024 * 1024 - 6, 39 * 1024 * 1024, 2]) {
    await reader.prepare(start, 16);
    expect(reader.view(start, start + 16)).toEqual(
      bytes.subarray(start, start + 16),
    );
  }
  expect(wholeRead).not.toHaveBeenCalled();
  for (const [start, end] of slice.mock.calls)
    expect(end! - start!).toBeLessThanOrEqual(1024 * 1024);
});
