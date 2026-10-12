import {
  validateRecordingMetadata,
  type IqRecording,
  type IqRecordingMetadata,
} from "./iqRecording";
import {
  RECORDING_WRITE_QUEUE_MAX_BYTES,
  STREAMING_RECORDING_MAX_BYTES,
} from "./recordingSpool";

const DIRECTORY = "browsersdr-library-v1";
const LOCK_PREFIX = "browsersdr-library:";
const CHUNK_BYTES = 4 * 1024 * 1024;
type Manifest = {
  version: 1;
  id: string;
  state: "capturing" | "ready";
  chunks: number[];
  metadata: IqRecordingMetadata;
};
export type LibraryEntry = {
  id: string;
  state: "ready" | "interrupted" | "unrecoverable" | "in-use";
  bytes: number;
  metadata?: IqRecordingMetadata;
  error?: string;
};
async function directory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(
    DIRECTORY,
    { create: true },
  );
}
async function writeJson(dir: FileSystemDirectoryHandle, manifest: Manifest) {
  const handle = await dir.getFileHandle("manifest.json", { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(JSON.stringify(manifest));
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
}
async function readManifest(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<Manifest> {
  const file = await (await dir.getFileHandle("manifest.json")).getFile();
  if (file.size > 1024 * 1024)
    throw new Error("Recording manifest is too large.");
  const manifest = JSON.parse(await file.text()) as Manifest;
  if (
    manifest.version !== 1 ||
    manifest.id !== id ||
    !["capturing", "ready"].includes(manifest.state) ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length > 65536 ||
    manifest.chunks.some(
      (n) => !Number.isSafeInteger(n) || n <= 0 || n > CHUNK_BYTES,
    )
  )
    throw new Error("Invalid recording manifest.");
  const bytes = manifest.chunks.reduce((sum, n) => sum + n, 0);
  manifest.metadata = validateRecordingMetadata(
    manifest.metadata,
    bytes,
    STREAMING_RECORDING_MAX_BYTES,
  );
  return manifest;
}
async function readChunks(
  dir: FileSystemDirectoryHandle,
  manifest: Manifest,
): Promise<Blob> {
  const files: Blob[] = [];
  for (let i = 0; i < manifest.chunks.length; i++) {
    const file = await (await dir.getFileHandle(i + ".iq")).getFile();
    if (file.size !== manifest.chunks[i])
      throw new Error("Committed recording chunk is missing or truncated.");
    files.push(file);
  }
  return new Blob(files, { type: "application/octet-stream" });
}
function validId(id: string) {
  if (!/^capture-[a-zA-Z0-9-]+$/.test(id))
    throw new Error("Invalid recording ID.");
}

/** Immutable chunks committed before a manifest-last checkpoint. One bounded write queue. */
export class DurableRecordingSpool {
  readonly id = "capture-" + crypto.randomUUID();
  private readonly opened: Promise<FileSystemDirectoryHandle>;
  private releaseLock?: () => void;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private queuedBytes = 0;
  private committed = 0;
  private chunks: number[] = [];
  private failure?: Error;
  private tail: Promise<void> = Promise.resolve();
  private pumping = false;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private finishing = false;
  private finished?: Promise<Blob>;
  constructor(private readonly metadata: () => IqRecordingMetadata) {
    this.opened = new Promise<FileSystemDirectoryHandle>((resolve, reject) => {
      void navigator.locks
        .request(LOCK_PREFIX + this.id, async () => {
          const held = new Promise<void>((release) => {
            this.releaseLock = release;
          });
          try {
            resolve(
              await (
                await directory()
              ).getDirectoryHandle(this.id, { create: true }),
            );
            await held;
          } catch (error) {
            reject(error);
          }
        })
        .catch(reject);
    });
    void this.opened.catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.releaseLock?.();
    });
  }
  get status() {
    return { queuedBytes: this.queuedBytes, failed: !!this.failure };
  }
  append(input: ArrayBuffer | Uint8Array) {
    return this.appendOwned(
      Uint8Array.from(
        input instanceof Uint8Array ? input : new Uint8Array(input),
      ),
    );
  }
  appendOwned(input: Uint8Array<ArrayBuffer>): boolean {
    if (
      this.finishing ||
      this.failure ||
      this.queuedBytes + input.length > RECORDING_WRITE_QUEUE_MAX_BYTES
    )
      return false;
    if (!input.length) return true;
    this.queue.push(input);
    this.queuedBytes += input.length;
    if (this.queuedBytes >= CHUNK_BYTES) this.startPump();
    else if (!this.checkpointTimer && !this.pumping)
      this.checkpointTimer = setTimeout(() => {
        this.checkpointTimer = undefined;
        this.startPump();
      }, 250);
    return true;
  }
  private startPump(): void {
    if (this.pumping || this.failure || !this.queue.length) return;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.pumping = true;
    this.tail = this.pump()
      .catch((error) => {
        this.failure =
          error instanceof Error ? error : new Error(String(error));
        this.queue = [];
        this.queuedBytes = 0;
      })
      .finally(() => {
        this.pumping = false;
      });
  }
  private snapshot(state: Manifest["state"]): Manifest {
    const source = this.metadata();
    const sampleCount = this.committed / source.bytesPerComplexSample;
    const metadata = {
      ...source,
      sampleCount,
      durationSeconds: sampleCount / source.sampleRateHz,
      knownGaps: source.knownGaps.filter(
        (gap) => gap.afterSample <= sampleCount,
      ),
    };
    return {
      version: 1,
      id: this.id,
      state,
      chunks: [...this.chunks],
      metadata,
    };
  }
  private async pump() {
    const dir = await this.opened;
    while (this.queue.length) {
      const batch: Uint8Array<ArrayBuffer>[] = [];
      let length = 0;
      while (this.queue.length && length < CHUNK_BYTES) {
        const first = this.queue[0]!;
        const take = Math.min(first.length, CHUNK_BYTES - length);
        batch.push(first.subarray(0, take));
        length += take;
        if (take === first.length) this.queue.shift();
        else this.queue[0] = first.subarray(take);
      }
      const stream = await (
        await dir.getFileHandle(this.chunks.length + ".iq", { create: true })
      ).createWritable();
      try {
        await stream.write(new Blob(batch));
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => undefined);
        throw error;
      }
      this.committed += length;
      this.chunks.push(length);
      await writeJson(dir, this.snapshot("capturing"));
      this.queuedBytes -= length;
    }
  }
  finish(expectedBytes: number): Promise<Blob> {
    if (this.finished) return this.finished;
    this.finishing = true;
    this.startPump();
    this.finished = (async () => {
      await this.tail;
      if (this.failure) throw this.failure;
      if (this.committed !== expectedBytes)
        throw new Error("Durable recording committed only a partial prefix.");
      const dir = await this.opened;
      const manifest = this.snapshot("ready");
      validateRecordingMetadata(
        manifest.metadata,
        expectedBytes,
        STREAMING_RECORDING_MAX_BYTES,
      );
      await writeJson(dir, manifest);
      return readChunks(dir, manifest);
    })();
    return this.finished;
  }
  /** Releasing a reader never deletes retained data. Delete is a separate user action. */
  async release() {
    clearTimeout(this.checkpointTimer);
    try {
      await this.finished;
    } catch {
      /* Recovery retains the last committed prefix. */
    }
    this.releaseLock?.();
  }
}

export async function listRecordings(): Promise<LibraryEntry[]> {
  if (!navigator.storage?.getDirectory || !navigator.locks) return [];
  const root = await directory();
  const entries: LibraryEntry[] = [];
  for await (const [id, handle] of (
    root as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    }
  ).entries()) {
    if (handle.kind !== "directory" || !/^capture-[a-zA-Z0-9-]+$/.test(id))
      continue;
    await navigator.locks.request(
      LOCK_PREFIX + id,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          entries.push({ id, state: "in-use", bytes: 0 });
          return;
        }
        try {
          const dir = await root.getDirectoryHandle(id);
          const manifest = await readManifest(dir, id);
          const data = await readChunks(dir, manifest);
          entries.push({
            id,
            state: manifest.state === "ready" ? "ready" : "interrupted",
            bytes: data.size,
            metadata: manifest.metadata,
          });
        } catch (error) {
          entries.push({
            id,
            state: "unrecoverable",
            bytes: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  }
  return entries;
}
export async function openRecording(id: string): Promise<IqRecording> {
  validId(id);
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(LOCK_PREFIX + id, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new Error("Recording is in use by another tab or reader."));
          return;
        }
        let release!: () => void;
        const held = new Promise<void>((done) => {
          release = done;
        });
        try {
          const dir = await (await directory()).getDirectoryHandle(id);
          const manifest = await readManifest(dir, id);
          const dataBlob = await readChunks(dir, manifest);
          const metadata = structuredClone(manifest.metadata);
          if (manifest.state !== "ready") {
            metadata.stopReason = "source-stop";
            metadata.captureWarning =
              "Interrupted capture: recovered only the committed prefix. The uncommitted tail and its duration are unknown.";
            metadata.knownGaps.push({
              afterSample: metadata.sampleCount,
              missingSamples: null,
              reason: "Capture interrupted; uncommitted tail unknown",
            });
          }
          resolve({
            data: new Uint8Array(),
            dataBlob,
            metadata,
            libraryId: id,
            releaseData: async () => release(),
          });
          await held;
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}
export async function deleteRecording(id: string): Promise<void> {
  validId(id);
  await navigator.locks.request(
    LOCK_PREFIX + id,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          "Recording is in use; close its readers before deleting.",
        );
      await (await directory()).removeEntry(id, { recursive: true });
    },
  );
}
