import {
  HashState,
  HASH_CHUNK_BYTES,
  type HashReply,
  type HashRequest,
} from "./hashingState";
export { HASH_CHUNK_BYTES } from "./hashingState";

/** One outstanding chunk; never transfer borrowed buffers; terminate on abort. */
export async function hashChunks(
  size: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
  algorithm: HashRequest["algorithm"],
  partSize = size,
  signal?: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<{ digest: string; partHashes: string[] }> {
  signal?.throwIfAborted();
  const worker =
    typeof Worker === "undefined"
      ? undefined
      : new Worker(new URL("../workers/hashing.worker.ts", import.meta.url), {
          type: "module",
        });
  const fallback = worker ? undefined : new HashState();
  let rejectPending: ((reason: unknown) => void) | undefined;
  const abort = () => {
    worker?.terminate();
    rejectPending?.(
      signal?.reason ?? new DOMException("Cancelled", "AbortError"),
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  const request = async (input: HashRequest): Promise<HashReply> => {
    signal?.throwIfAborted();
    if (!worker) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      return fallback!.process(input);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(undefined, new Error("Hash worker timed out.")),
        30_000,
      );
      const finish = (reply?: HashReply, error?: unknown) => {
        clearTimeout(timer);
        rejectPending = undefined;
        worker.onmessage = null;
        worker.onerror = null;
        if (error) reject(error);
        else resolve(reply!);
      };
      rejectPending = (error) => finish(undefined, error);
      worker.onerror = () =>
        finish(undefined, new Error("Hash worker failed."));
      worker.onmessage = (event: MessageEvent<HashReply>) =>
        finish(
          event.data,
          event.data.error ? new Error(event.data.error) : undefined,
        );
      try {
        worker.postMessage(input, input.bytes ? [input.bytes.buffer] : []);
      } catch (error) {
        finish(undefined, error);
      }
    });
  };
  const readChunk = (start: number, end: number): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(undefined, new Error("Hash input read timed out.")),
        30_000,
      );
      const finish = (bytes?: Uint8Array, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPending = undefined;
        if (error) reject(error);
        else resolve(bytes!);
      };
      rejectPending = (error) => finish(undefined, error);
      try {
        void read(start, end).then(
          (bytes) => finish(bytes),
          (error) => finish(undefined, error),
        );
      } catch (error) {
        finish(undefined, error);
      }
    });
  try {
    const partHashes: string[] = [];
    for (let start = 0; start < size; start += partSize) {
      const end = Math.min(size, start + partSize);
      for (let offset = start; offset < end; offset += HASH_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const next = Math.min(end, offset + HASH_CHUNK_BYTES);
        const view = await readChunk(offset, next);
        if (view.length !== next - offset)
          throw new Error("Short read while hashing.");
        const reply = await request({
          algorithm,
          bytes: Uint8Array.from(view),
          endPart: algorithm === "sha256" && next === end,
        });
        if (reply.partHash) partHashes.push(reply.partHash);
        progress?.(next);
      }
    }
    return { digest: (await request({ algorithm })).digest!, partHashes };
  } finally {
    signal?.removeEventListener("abort", abort);
    worker?.terminate();
  }
}
