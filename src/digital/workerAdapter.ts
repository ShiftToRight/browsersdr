import {
  DIGITAL_MAX_SNAPSHOT_BYTES,
  type DigitalDecoderConfiguration,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalPublication,
  validateDigitalConfiguration,
  validateDigitalInputBlock,
} from "./contracts";

export const DIGITAL_WORKER_DEFAULT_QUEUE_BLOCKS = 8;

export type DigitalWorkerInput<
  TConfiguration extends DigitalDecoderConfiguration,
> =
  | { type: "configure"; configuration: TConfiguration }
  | { type: "reset"; generation: number; discontinuity: DigitalDiscontinuity }
  | {
      type: "samples";
      generation: number;
      sequence: number;
      firstSampleIndex: number;
      discontinuityBefore?: DigitalDiscontinuity;
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
    }
  | { type: "flush"; generation: number; sequence: number }
  | { type: "dispose" };

export type DigitalWorkerOutput<TSnapshot, TEvent> =
  | { type: "ready"; generation: number }
  | { type: "flushed"; generation: number; sequence: number }
  | {
      type: "consumed";
      generation: number;
      sequence: number;
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
    }
  | {
      type: "snapshot";
      generation: number;
      publication: DigitalPublication<TSnapshot>;
    }
  | {
      type: "event";
      generation: number;
      publication: DigitalPublication<TEvent>;
    }
  | { type: "error"; generation: number; message: string };

export type DigitalWorkerPort<TSnapshot, TEvent> = Pick<
  Worker,
  "terminate" | "onerror"
> & {
  onmessage:
    | ((event: MessageEvent<DigitalWorkerOutput<TSnapshot, TEvent>>) => void)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export interface DigitalWorkerAdapterCallbacks<TSnapshot, TEvent> {
  /** Ownership of these buffers returns to the caller here. */
  consumed?(I: Float32Array<ArrayBuffer>, Q: Float32Array<ArrayBuffer>): void;
  snapshot?(publication: DigitalPublication<TSnapshot>): void;
  event?(publication: DigitalPublication<TEvent>): void;
  dropped?(discontinuity: DigitalDiscontinuity): void;
  error?(error: Error): void;
}

export interface DigitalWorkerAdapterDiagnostics {
  generation: number;
  queuedBlocks: number;
  queueCapacityBlocks: number;
  peakQueuedBlocks: number;
  droppedInputBlocks: number;
  droppedInputSamples: number;
  staleResults: number;
}

/** Main-thread endpoint. submitOwned transfers input only when it returns true. */
export class BoundedDigitalWorkerAdapter<
  TConfiguration extends DigitalDecoderConfiguration,
  TSnapshot,
  TEvent,
> {
  private generation = -1;
  private sequence = 0;
  private readonly inFlight = new Set<string>();
  private peakQueuedBlocks = 0;
  private droppedInputBlocks = 0;
  private droppedInputSamples = 0;
  private staleResults = 0;
  private pendingDiscontinuity?: DigitalDiscontinuity;
  private closed = false;
  private readyGeneration = -1;
  private readonly readiness = new Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly flushes = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly worker: DigitalWorkerPort<TSnapshot, TEvent>,
    private readonly callbacks: DigitalWorkerAdapterCallbacks<
      TSnapshot,
      TEvent
    > = {},
    private readonly queueCapacityBlocks = DIGITAL_WORKER_DEFAULT_QUEUE_BLOCKS,
    private readonly maximumResultBytes = DIGITAL_MAX_SNAPSHOT_BYTES,
  ) {
    if (!Number.isInteger(queueCapacityBlocks) || queueCapacityBlocks < 1)
      throw new Error(
        "Digital worker queue capacity must be a positive integer.",
      );
    if (!Number.isSafeInteger(maximumResultBytes) || maximumResultBytes < 1)
      throw new Error(
        "Digital worker result limit must be a positive integer.",
      );
    worker.onerror = () =>
      callbacks.error?.(new Error("Digital decoder worker failed."));
    worker.onmessage = (event) => this.handle(event.data);
  }

  get diagnostics(): DigitalWorkerAdapterDiagnostics {
    return {
      generation: this.generation,
      queuedBlocks: this.inFlight.size,
      queueCapacityBlocks: this.queueCapacityBlocks,
      peakQueuedBlocks: this.peakQueuedBlocks,
      droppedInputBlocks: this.droppedInputBlocks,
      droppedInputSamples: this.droppedInputSamples,
      staleResults: this.staleResults,
    };
  }

  configure(configuration: TConfiguration): void {
    this.requireOpen();
    validateDigitalConfiguration(configuration);
    this.readyGeneration = -1;
    for (const waiter of this.readiness) { clearTimeout(waiter.timer); waiter.reject(new Error("Digital configuration changed before readiness.")); }
    this.readiness.clear();
    this.generation = configuration.generation;
    this.pendingDiscontinuity = undefined;
    this.worker.postMessage({
      type: "configure",
      configuration,
    } satisfies DigitalWorkerInput<TConfiguration>);
  }

  /**
   * On true, ownership of both buffers moved to the worker until `consumed`.
   * On false, ownership stays with the caller and the next accepted block carries a gap.
   */
  submitOwned(block: DigitalInputBlock): boolean {
    this.requireOpen();
    validateDigitalInputBlock(block);
    if (block.generation !== this.generation) return false;
    if (this.inFlight.size >= this.queueCapacityBlocks) {
      this.droppedInputBlocks++;
      this.droppedInputSamples += block.I.length;
      const pending = this.pendingDiscontinuity;
      this.pendingDiscontinuity = {
        reason: "queue-overflow",
        missingInputSamples:
          (pending?.missingInputSamples ?? 0) + block.I.length,
        droppedInputBlocks: (pending?.droppedInputBlocks ?? 0) + 1,
      };
      this.callbacks.dropped?.(this.pendingDiscontinuity);
      return false;
    }
    if (
      !(block.I.buffer instanceof ArrayBuffer) ||
      !(block.Q.buffer instanceof ArrayBuffer)
    )
      throw new Error(
        "Digital worker input requires transferable ArrayBuffer-backed I/Q.",
      );
    const sequence = this.sequence++;
    this.inFlight.add(key(block.generation, sequence));
    this.peakQueuedBlocks = Math.max(this.peakQueuedBlocks, this.inFlight.size);
    const discontinuityBefore = mergeDiscontinuities(
      this.pendingDiscontinuity,
      block.discontinuityBefore,
    );
    this.pendingDiscontinuity = undefined;
    const message: DigitalWorkerInput<TConfiguration> = {
      type: "samples",
      generation: block.generation,
      sequence,
      firstSampleIndex: block.firstSampleIndex,
      ...(discontinuityBefore ? { discontinuityBefore } : {}),
      I: block.I as Float32Array<ArrayBuffer>,
      Q: block.Q as Float32Array<ArrayBuffer>,
    };
    this.worker.postMessage(message, [block.I.buffer, block.Q.buffer]);
    return true;
  }

  reset(
    discontinuity: DigitalDiscontinuity = {
      reason: "reset",
      missingInputSamples: null,
    },
  ): void {
    this.requireOpen();
    this.pendingDiscontinuity = undefined;
    this.worker.postMessage({
      type: "reset",
      generation: this.generation,
      discontinuity,
    } satisfies DigitalWorkerInput<TConfiguration>);
  }

  /** Await validated worker configuration before acquisition starts. */
  whenReady(): Promise<void> {
    this.requireOpen();
    if (this.readyGeneration === this.generation) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.readiness.delete(waiter); reject(new Error("Digital decoder configuration timed out.")); }, 3_000) };
      this.readiness.add(waiter);
    });
  }

  /** Ordered end-of-input barrier; snapshots arrive before acknowledgement. */
  flush(): Promise<void> {
    this.requireOpen();
    const sequence = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.flushes.delete(sequence); reject(new Error("Digital decoder flush timed out.")); }, 3_000);
      this.flushes.set(sequence, { resolve, reject, timer });
      this.worker.postMessage({ type: "flush", generation: this.generation, sequence } satisfies DigitalWorkerInput<TConfiguration>);
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.readiness) { clearTimeout(waiter.timer); waiter.reject(new Error("Digital decoder was disposed before readiness.")); }
    this.readiness.clear();
    for (const waiter of this.flushes.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Digital decoder was disposed before flush.")); }
    this.flushes.clear();
    this.worker.postMessage({
      type: "dispose",
    } satisfies DigitalWorkerInput<TConfiguration>);
    this.worker.terminate();
    this.inFlight.clear();
  }

  private handle(message: DigitalWorkerOutput<TSnapshot, TEvent>): void {
    if (this.closed) return;
    if (message.type === "consumed") {
      this.inFlight.delete(key(message.generation, message.sequence));
      this.callbacks.consumed?.(message.I, message.Q);
      return;
    }
    if (
      message.generation !== this.generation ||
      ("publication" in message &&
        message.publication.provenance.generation !== this.generation)
    ) {
      this.staleResults++;
      return;
    }
    if (message.type === "error") {
      for (const waiter of this.readiness) { clearTimeout(waiter.timer); waiter.reject(new Error(message.message)); }
      this.readiness.clear();
      this.callbacks.error?.(new Error(message.message));
      return;
    }
    if (message.type === "flushed") {
      const waiter = this.flushes.get(message.sequence);
      if (waiter) { clearTimeout(waiter.timer); this.flushes.delete(message.sequence); waiter.resolve(); }
      return;
    }
    if (message.type === "ready") {
      this.readyGeneration = message.generation;
      for (const waiter of this.readiness) { clearTimeout(waiter.timer); waiter.resolve(); }
      this.readiness.clear();
      return;
    }
    if (
      estimatePayloadBytes(message.publication.value) > this.maximumResultBytes
    ) {
      this.callbacks.error?.(
        new Error("Digital worker result exceeded its bounded payload limit."),
      );
      return;
    }
    if (message.type === "snapshot")
      this.callbacks.snapshot?.(message.publication);
    else this.callbacks.event?.(message.publication);
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Digital worker adapter is disposed.");
  }
}

function key(generation: number, sequence: number): string {
  return `${generation}:${sequence}`;
}

function mergeDiscontinuities(
  first?: DigitalDiscontinuity,
  second?: DigitalDiscontinuity,
): DigitalDiscontinuity | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    reason: first.reason,
    missingInputSamples:
      first.missingInputSamples === null || second.missingInputSamples === null
        ? null
        : first.missingInputSamples + second.missingInputSamples,
    droppedInputBlocks:
      (first.droppedInputBlocks ?? 0) + (second.droppedInputBlocks ?? 0),
  };
}

function estimatePayloadBytes(
  value: unknown,
  seen = new Set<object>(),
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value !== "object") return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value))
    return value.reduce(
      (sum, item) => sum + estimatePayloadBytes(item, seen),
      0,
    );
  return Object.entries(value).reduce(
    (sum, [name, item]) =>
      sum + name.length * 2 + estimatePayloadBytes(item, seen),
    0,
  );
}
