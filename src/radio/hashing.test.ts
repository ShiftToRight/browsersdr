import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { hashChunks, HASH_CHUNK_BYTES } from "./hashing";
afterEach(() => vi.unstubAllGlobals());
it("preserves exact whole/part digests across partial chunks and yields to cancellation", async () => {
  const input = new Uint8Array(HASH_CHUNK_BYTES * 2 + 17).fill(93);
  const progress: number[] = [];
  let heartbeat = false;
  setTimeout(() => {
    heartbeat = true;
  }, 0);
  const result = await hashChunks(
    input.length,
    async (a, b) => input.subarray(a, b),
    "sha256",
    HASH_CHUNK_BYTES + 7,
    undefined,
    (n) => progress.push(n),
  );
  expect(result.digest).toBe(createHash("sha256").update(input).digest("hex"));
  expect(result.partHashes).toEqual(
    [
      input.subarray(0, HASH_CHUNK_BYTES + 7),
      input.subarray(HASH_CHUNK_BYTES + 7, 2 * (HASH_CHUNK_BYTES + 7)),
      input.subarray(2 * (HASH_CHUNK_BYTES + 7)),
    ].map((part) => createHash("sha256").update(part).digest("hex")),
  );
  expect(progress.at(-1)).toBe(input.length);
  expect(heartbeat).toBe(true);
  const aborter = new AbortController();
  await expect(
    hashChunks(
      input.length,
      async (a, b) => input.subarray(a, b),
      "sha256",
      input.length,
      aborter.signal,
      () => aborter.abort(),
    ),
  ).rejects.toThrow();
});
it("terminates an unresponsive worker immediately on abort without detaching original bytes", async () => {
  const terminate = vi.fn();
  let posted: Uint8Array | undefined;
  vi.stubGlobal(
    "Worker",
    class {
      terminate = terminate;
      postMessage(input: { bytes: Uint8Array }) {
        posted = input.bytes;
      }
    },
  );
  const original = new Uint8Array([1, 2]);
  const aborter = new AbortController();
  const job = hashChunks(2, async () => original, "sha256", 2, aborter.signal);
  await Promise.resolve();
  await Promise.resolve();
  aborter.abort();
  await expect(job).rejects.toThrow();
  expect(terminate).toHaveBeenCalled();
  expect(posted).not.toBe(original);
  expect(original).toEqual(new Uint8Array([1, 2]));
});

it("cancels while file storage is stalled without waiting for a read result", async () => {
  const aborter = new AbortController();
  const job = hashChunks(
    2,
    () => new Promise<Uint8Array>(() => undefined),
    "sha256",
    2,
    aborter.signal,
  );
  aborter.abort();
  await expect(job).rejects.toThrow();
});
