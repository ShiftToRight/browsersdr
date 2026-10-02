import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { DabPlusProgrammeDecoder } from "./dabPlusSuperframe";
import type { DabEnsembleDecoder } from "./dabReceiver";
import type { DabModeIStatus } from "./dabModeI";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";

export type DabWorkerInput =
  | { type: "configure"; sampleRateHz: number }
  | { type: "reset"; generation: number }
  | { type: "select-service"; key: string; generation: number }
  | {
      type: "samples";
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
    };

export type DabWorkerOutput =
  | { type: "ready" }
  | { type: "programme-change"; generation: number }
  | { type: "logical-frame"; generation: number; data: Uint8Array<ArrayBuffer> }
  | { type: "status"; generation: number; status: DabModeIStatus }
  | {
      type: "consumed";
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
    }
  | { type: "error"; message: string };

export type DabWorkerPort = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror"
>;

/** Main-thread endpoint for the worker-owned OFDM/FIC/MSC decoder. */
export class DabEnsembleWorkerDecoder implements DabEnsembleDecoder {
  private static readonly MAX_BLOCK_SAMPLES = 32_768;
  // Cover a complete USB completion burst plus several 96 ms frames of
  // scheduling jitter. Still bounded: 16 MiB / 0.87 s at 2.4 MS/s.
  private static readonly BUFFER_SLOTS = 64;
  private readonly worker: DabWorkerPort;
  private readonly pool = Array.from(
    { length: DabEnsembleWorkerDecoder.BUFFER_SLOTS },
    () =>
      [
        new ArrayBuffer(DabEnsembleWorkerDecoder.MAX_BLOCK_SAMPLES * 4),
        new ArrayBuffer(DabEnsembleWorkerDecoder.MAX_BLOCK_SAMPLES * 4),
      ] as const,
  );
  private closed = false;
  private generation = 0;
  private stagingI?: Float32Array<ArrayBuffer>;
  private stagingQ?: Float32Array<ArrayBuffer>;
  private stagingCount = 0;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly drains = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly readyTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly programme: DabPlusProgrammeDecoder,
    private readonly onStatus: (status: DabModeIStatus) => void = () =>
      undefined,
    private readonly onError: (error: Error) => void = () => undefined,
    factory = (): DabWorkerPort =>
      new Worker(new URL("../workers/dab.worker.ts", import.meta.url), {
        type: "module",
      }),
    private readonly onProgrammeChange: () => void = () => undefined,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.readyTimer = setTimeout(
      () => this.fail(new Error("DAB decoder worker startup timed out.")),
      5_000,
    );
    this.worker = factory();
    this.worker.onerror = (event) =>
      this.fail(new Error(event.message
        ? `DAB decoder worker failed: ${event.message}`
        : "DAB decoder worker failed."));
    this.worker.onmessage = (event: MessageEvent<DabWorkerOutput>) => {
      if (this.closed) return;
      const message = event.data;
      if ("generation" in message && message.generation !== this.generation)
        return;
      if (message.type === "error") {
        this.fail(new Error(message.message));
      } else if (message.type === "ready") {
        clearTimeout(this.readyTimer);
        this.resolveReady();
      } else if (message.type === "programme-change") {
        this.programme.reset();
        this.onProgrammeChange();
      } else if (message.type === "status") {
        this.onStatus(message.status);
      } else if (message.type === "logical-frame") {
        this.programme.pushLogicalFrame(message.data);
      } else {
        this.pool.push([message.I.buffer, message.Q.buffer]);
        this.finishDrains();
      }
    };
  }

  setSampleRate(sampleRateHz: number): void {
    if (!this.closed)
      this.worker.postMessage({
        type: "configure",
        sampleRateHz,
      } satisfies DabWorkerInput);
  }

  prepare(): Promise<void> {
    return this.ready;
  }

  receiveSamples(block: SampleBlock): void {
    if (this.closed) return;
    if (block.I.length !== block.Q.length) {
      this.fail(new Error("DAB input has mismatched I/Q lengths."));
      return;
    }
    for (let offset = 0; offset < block.I.length;) {
      if (!this.ensureStaging()) return;
      const count = Math.min(
        DabEnsembleWorkerDecoder.MAX_BLOCK_SAMPLES - this.stagingCount,
        block.I.length - offset,
      );
      this.stagingI!.set(
        block.I.subarray(offset, offset + count),
        this.stagingCount,
      );
      this.stagingQ!.set(
        block.Q.subarray(offset, offset + count),
        this.stagingCount,
      );
      this.stagingCount += count;
      offset += count;
      if (this.stagingCount === DabEnsembleWorkerDecoder.MAX_BLOCK_SAMPLES)
        this.dispatchStaging();
    }
  }

  drain(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("DAB decoder worker closed."));
    if (this.stagingCount) this.dispatchStaging();
    if (this.pool.length + (this.stagingI ? 1 : 0) === DabEnsembleWorkerDecoder.BUFFER_SLOTS) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.drains.delete(waiter); reject(new Error("DAB decoder drain timed out.")); }, 15_000);
      const waiter = { resolve, reject, timer }; this.drains.add(waiter);
    });
  }
  private finishDrains(): void {
    if (this.pool.length + (this.stagingI ? 1 : 0) !== DabEnsembleWorkerDecoder.BUFFER_SLOTS) return;
    for (const waiter of this.drains) { clearTimeout(waiter.timer); waiter.resolve(); }
    this.drains.clear();
  }

  selectService(key: string): void {
    if (this.closed) return;
    this.generation += 1;
    this.programme.reset();
    this.onProgrammeChange();
    this.worker.postMessage({
      type: "select-service",
      key,
      generation: this.generation,
    } satisfies DabWorkerInput);
  }

  reset(): void {
    this.stagingCount = 0;
    this.generation += 1;
    if (!this.closed)
      this.worker.postMessage({
        type: "reset",
        generation: this.generation,
      } satisfies DabWorkerInput);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    for (const waiter of this.drains) { clearTimeout(waiter.timer); waiter.reject(new Error("DAB decoder worker closed.")); }
    this.drains.clear();
    this.rejectReady(new Error("DAB decoder worker closed."));
    this.worker.terminate();
    this.pool.length = 0;
    this.stagingI = undefined;
    this.stagingQ = undefined;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    // Preserve the failure for callers awaiting startup before close rejects it
    // with the generic cancellation error.
    this.rejectReady(error);
    defaultDiagnosticRecorder.record({
      area: "decoder",
      code: "DAB_WORKER_FAILURE",
      severity: "error",
      operation: "worker",
      error,
      autoSubmitEligible: true,
    });
    this.close();
    this.onError(error);
  }

  private ensureStaging(): boolean {
    if (this.stagingI && this.stagingQ) return true;
    const buffers = this.pool.pop();
    if (!buffers) {
      this.fail(
        new Error(
          "DAB decoding cannot sustain the input rate; its bounded worker queue is full.",
        ),
      );
      return false;
    }
    this.stagingI = new Float32Array(buffers[0]);
    this.stagingQ = new Float32Array(buffers[1]);
    return true;
  }

  private dispatchStaging(): void {
    const I = this.stagingI!.subarray(0, this.stagingCount),
      Q = this.stagingQ!.subarray(0, this.stagingCount);
    this.stagingI = undefined;
    this.stagingQ = undefined;
    this.stagingCount = 0;
    this.worker.postMessage(
      { type: "samples", I, Q } satisfies DabWorkerInput,
      [I.buffer, Q.buffer],
    );
  }
}
