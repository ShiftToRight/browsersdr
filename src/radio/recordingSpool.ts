export const STREAMING_RECORDING_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const RECORDING_WRITE_QUEUE_MAX_BYTES = 64 * 1024 * 1024;

type OpfsStorageManager = StorageManager & {
  getDirectory?(): Promise<FileSystemDirectoryHandle>;
};

export function opfsRecordingAvailable(): boolean {
  return typeof navigator !== "undefined" &&
    typeof (navigator.storage as OpfsStorageManager | undefined)?.getDirectory ===
      "function";
}

export interface RecordingSpoolStatus {
  queuedBytes: number;
  failed: boolean;
}

export interface RecordingSpoolOptions {
  root?: Promise<FileSystemDirectoryHandle>;
  queueMaxBytes?: number;
  filename?: string;
}

/**
 * Incremental browser-storage sink. Capture callbacks only make one owned copy
 * and enqueue it; OPFS writes are serialized without retaining the complete
 * recording in JavaScript memory.
 */
export class OpfsRecordingSpool {
  private readonly queueMaxBytes: number;
  private readonly filename: string;
  private readonly opened: Promise<{
    root: FileSystemDirectoryHandle;
    writable: FileSystemWritableFileStream;
  }>;
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private failure?: Error;
  private finishing = false;
  private finished?: Promise<Blob>;
  private released?: Promise<void>;
  private releaseLock?: () => void;

  constructor(options: RecordingSpoolOptions = {}) {
    this.queueMaxBytes =
      options.queueMaxBytes ?? RECORDING_WRITE_QUEUE_MAX_BYTES;
    this.filename =
      options.filename ??
      `capture-${Date.now()}-${crypto.randomUUID()}.iq.tmp`;
    const root =
      options.root ??
      (navigator.storage as OpfsStorageManager).getDirectory!();
    const lockReady = new Promise<void>((resolve, reject) => {
      if (!navigator.locks) { resolve(); return; }
      const held = new Promise<void>(release => { this.releaseLock = release; });
      void navigator.locks.request(RECORDING_LOCK_PREFIX + this.filename, async () => {
        resolve();
        await held;
      }).catch(reject);
    });
    this.opened = Promise.all([root, lockReady]).then(async ([directory]) => {
      const captures = await directory.getDirectoryHandle(
        "browsersdr-recordings",
        { create: true },
      );
      const handle = await captures.getFileHandle(this.filename, {
        create: true,
      });
      return {
        root: captures,
        writable: await handle.createWritable({ keepExistingData: false }),
      };
    });
    // Install the rejection handler immediately, before the first USB callback.
    void this.opened.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error("Browser recording storage could not open.");
      this.releaseLock?.();
    });
  }

  get status(): RecordingSpoolStatus {
    return { queuedBytes: this.queuedBytes, failed: Boolean(this.failure) };
  }

  append(input: ArrayBuffer | Uint8Array): boolean {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    return this.enqueue(Uint8Array.from(source));
  }

  /** Enqueue an allocation owned exclusively by the recorder. */
  appendOwned(input: Uint8Array<ArrayBuffer>): boolean {
    return this.enqueue(input);
  }

  private enqueue(owned: Uint8Array<ArrayBuffer>): boolean {
    if (this.finishing || this.failure) return false;
    if (this.queuedBytes + owned.byteLength > this.queueMaxBytes) return false;
    this.queuedBytes += owned.byteLength;
    this.tail = this.tail
      .then(async () => {
        if (this.failure) return;
        const { writable } = await this.opened;
        await writable.write(owned);
      })
      .catch((error: unknown) => {
        this.failure =
          error instanceof Error
            ? error
            : new Error("Browser recording storage write failed.");
      })
      .finally(() => {
        this.queuedBytes -= owned.byteLength;
      });
    return true;
  }

  finish(expectedBytes: number): Promise<Blob> {
    if (this.finished) return this.finished;
    this.finishing = true;
    this.finished = (async () => {
      let root: FileSystemDirectoryHandle | undefined;
      try {
        await this.tail;
        const opened = await this.opened;
        root = opened.root;
        if (this.failure) throw this.failure;
        await opened.writable.close();
        const handle = await root.getFileHandle(this.filename);
        const file = await handle.getFile();
        if (file.size !== expectedBytes)
          throw new Error(
            `Browser recording storage committed ${file.size}/${expectedBytes} bytes.`,
          );
        // Keep the OPFS entry while consumers retain this File. Chromium can
        // expose the File as a Blob but still read its bytes lazily when a
        // download begins; removing the entry here makes large downloads fail
        // even though small metadata sidecars succeed.
        return file;
      } catch (error) {
        try {
          const opened = await this.opened;
          await opened.writable.abort().catch(() => undefined);
          await root?.removeEntry(this.filename);
        } catch {
          // Best-effort cleanup; preserve the original storage failure.
        }
        throw error;
      }
    })();
    return this.finished;
  }

  /** Remove the retained OPFS entry after its Blob consumers are finished. */
  release(): Promise<void> {
    if (this.released) return this.released;
    this.released = (async () => {
      try {
        await this.finished;
      } catch {
        // finish() already attempted best-effort cleanup on failure.
      }
      try {
        const opened = await this.opened;
        try {
          await opened.writable.close();
        } catch {
          // It is normally already closed by finish().
        }
        await opened.root.removeEntry(this.filename);
      } catch {
        // Release is best-effort; capture/export failures retain their own
        // actionable error instead of being replaced by cleanup noise.
      } finally { this.releaseLock?.(); }
    })();
    return this.released;
  }
}

const RECORDING_LOCK_PREFIX = "browsersdr-recording:";

/** Stale files have no recoverable metadata. Never remove a capture owned by another tab. */
export async function cleanupAbandonedRecordings(): Promise<void> {
  if (!opfsRecordingAvailable() || !navigator.locks) return;
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("browsersdr-recordings", { create: true });
  const iterable = directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  for await (const [name, handle] of iterable.entries()) {
    if (handle.kind !== "file" || !/^capture-.*\.iq\.tmp$/.test(name)) continue;
    await navigator.locks.request(RECORDING_LOCK_PREFIX + name, { ifAvailable: true }, async lock => {
      if (lock) {
        try { await directory.removeEntry(name); }
        catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
      }
    });
  }
}

let storageUnavailable = false;
export function recordingStorageUsable(): boolean {
  return !storageUnavailable && opfsRecordingAvailable();
}

/** Test creation and writing before acquisition, falling back to the bounded memory recorder. */
export async function prepareRecordingStorage(): Promise<"opfs" | "memory"> {
  if (!recordingStorageUsable() || !navigator.locks) return "memory";
  let root: FileSystemDirectoryHandle | undefined;
  let stream: FileSystemWritableFileStream | undefined;
  const filename = `probe-${crypto.randomUUID()}`;
  try {
    root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(filename, { create: true });
    stream = await file.createWritable();
    await stream.write(new Uint8Array([0]));
    await stream.close();
    stream = undefined;
    return "opfs";
  } catch {
    await stream?.abort().catch(() => undefined);
    storageUnavailable = true;
    return "memory";
  } finally {
    await root?.removeEntry(filename).catch(() => undefined);
  }
}
