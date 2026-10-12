import { fakeRecordingStorage as storage } from "../testing/fakeRecordingStorage";
import { afterEach, expect, it, vi } from "vitest";
import {
  DurableRecordingSpool,
  deleteRecording,
  listRecordings,
  openRecording,
} from "./recordingLibrary";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";

afterEach(() => vi.unstubAllGlobals());
const metadata = () => createDeterministicRecordingFixture(8).metadata;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("persists exact bytes, excludes another tab, pins readers, and deletes explicitly", async () => {
  storage();
  const spool = new DurableRecordingSpool(metadata);
  expect(spool.append(new Uint8Array([1, 2, 3, 4]))).toBe(true);
  expect(new Uint8Array(await (await spool.finish(4)).arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3, 4]),
  );
  expect((await listRecordings())[0]?.state).toBe("in-use");
  await expect(deleteRecording(spool.id)).rejects.toThrow("in use");
  await spool.release();
  await tick();
  expect((await listRecordings())[0]).toMatchObject({
    state: "ready",
    bytes: 4,
  });
  const reopened = await openRecording(spool.id);
  expect(
    new Uint8Array(await (await reopened.dataBlob!).arrayBuffer()),
  ).toEqual(new Uint8Array([1, 2, 3, 4]));
  await expect(openRecording(spool.id)).rejects.toThrow("in use");
  await reopened.releaseData?.();
  await tick();
  await deleteRecording(spool.id);
  expect(await listRecordings()).toEqual([]);
});

it("recovers only the committed prefix after interrupted writes and marks unknown tail", async () => {
  const disk = storage();
  const spool = new DurableRecordingSpool(metadata);
  spool.append(new Uint8Array([10, 11, 12, 13]));
  while (spool.status.queuedBytes) await tick();
  disk.fail("manifest.json");
  spool.append(new Uint8Array([20, 21]));
  await expect(spool.finish(6)).rejects.toThrow("quota");
  await disk.crash();
  expect((await listRecordings())[0]).toMatchObject({
    state: "interrupted",
    bytes: 4,
  });
  const recovered = await openRecording(spool.id);
  expect(
    new Uint8Array(await (await recovered.dataBlob!).arrayBuffer()),
  ).toEqual(new Uint8Array([10, 11, 12, 13]));
  expect(recovered.metadata.knownGaps.at(-1)).toMatchObject({
    afterSample: 2,
    missingSamples: null,
  });
  expect(recovered.metadata.captureWarning).toContain("committed prefix");
  await recovered.releaseData?.();
});

it("bounds queued bytes without corrupting the accepted prefix", async () => {
  storage();
  const spool = new DurableRecordingSpool(metadata);
  expect(spool.appendOwned(new Uint8Array(64 * 1024 * 1024 + 2))).toBe(false);
  expect(spool.append(new Uint8Array([1, 2]))).toBe(true);
  expect((await spool.finish(2)).size).toBe(2);
  await spool.release();
});

it("shows a missing committed chunk as unrecoverable without deleting evidence", async () => {
  const disk = storage();
  const spool = new DurableRecordingSpool(metadata);
  spool.append(new Uint8Array([1, 2]));
  await spool.finish(2);
  await spool.release();
  await tick();
  const dir = await (
    await disk.root.getDirectoryHandle("browsersdr-library-v1")
  ).getDirectoryHandle(spool.id);
  await dir.removeEntry("0.iq");
  expect((await listRecordings())[0]?.state).toBe("unrecoverable");
  await expect(openRecording(spool.id)).rejects.toThrow();
  expect(await listRecordings()).toHaveLength(1);
});
