import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAbandonedRecordings, prepareRecordingStorage, OpfsRecordingSpool } from "./recordingSpool";

function fakeOpfs(writeGate?: Promise<void>) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let removed = false;
  const file = {
    createWritable: async () => ({
      write: async (value: Uint8Array<ArrayBuffer>) => {
        await writeGate;
        chunks.push(Uint8Array.from(value));
      },
      close: async () => undefined,
    }),
    getFile: async () => new Blob(chunks),
  };
  const captures = {
    getFileHandle: async () => file,
    removeEntry: async () => { removed = true; },
  };
  const root = {
    getDirectoryHandle: async () => captures,
  };
  return {
    root: Promise.resolve(root as unknown as FileSystemDirectoryHandle),
    chunks,
    removed: () => removed,
  };
}

describe("OPFS recording spool", () => {
  it("writes ordered chunks and returns an immutable Blob snapshot", async () => {
    const opfs = fakeOpfs();
    const spool = new OpfsRecordingSpool({ root: opfs.root, filename: "capture.iq" });
    expect(spool.append(new Uint8Array([1, 2]))).toBe(true);
    expect(spool.append(new Uint8Array([3, 4]))).toBe(true);
    const result = await spool.finish(4);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(opfs.removed()).toBe(false);
    await spool.release();
    expect(opfs.removed()).toBe(true);
  });

  it("rejects new blocks when the bounded write queue is temporarily full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opfs = fakeOpfs(gate);
    const spool = new OpfsRecordingSpool({ root: opfs.root, queueMaxBytes: 4 });
    expect(spool.append(new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(spool.append(new Uint8Array([5, 6]))).toBe(false);
    release();
    expect((await spool.finish(4)).size).toBe(4);
  });
});


afterEach(() => vi.unstubAllGlobals());
it("handles storage-open rejection before the first input without an unhandled rejection", async () => {
  const spool = new OpfsRecordingSpool({ root: Promise.reject(new DOMException("quota", "QuotaExceededError")) });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(spool.status.failed).toBe(true);
  await expect(spool.finish(0)).rejects.toThrow("quota");
  await spool.release();
});
it("removes orphaned files while preserving captures locked by another tab", async () => {
  const removed: string[] = [];
  const directory = {
    async *entries() { yield ["capture-old.iq.tmp", { kind: "file" }]; yield ["capture-active.iq.tmp", { kind: "file" }]; yield ["other-file", { kind: "file" }]; },
    removeEntry: async (name: string) => { removed.push(name); },
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    locks: { request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => callback(name.endsWith("capture-active.iq.tmp") ? null : {}) },
  });
  await cleanupAbandonedRecordings();
  expect(removed).toEqual(["capture-old.iq.tmp"]);
});
it("checks OPFS writability before choosing the memory fallback", async () => {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new DOMException("quota", "QuotaExceededError"); } } });
  await expect(prepareRecordingStorage()).resolves.toBe("memory");
});
