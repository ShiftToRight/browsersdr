import { describe, expect, it, vi } from "vitest";
import type { DabPlusProgrammeDecoder } from "./dabPlusSuperframe";
import {
  DabEnsembleWorkerDecoder,
  type DabWorkerOutput,
  type DabWorkerPort,
} from "./dabEnsembleWorker";

class FakeWorker implements DabWorkerPort {
  onmessage:
    ((this: Worker, event: MessageEvent<DabWorkerOutput>) => unknown) | null =
    null;
  onerror: OnErrorEventHandler = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  emit(message: DabWorkerOutput): void {
    this.onmessage?.call(
      {} as Worker,
      new MessageEvent("message", { data: message }),
    );
  }
}

describe("DAB ensemble worker endpoint", () => {
  it("preserves a startup failure for prepare callers", async () => {
    const worker = new FakeWorker();
    const onError = vi.fn();
    const decoder = new DabEnsembleWorkerDecoder(
      {} as DabPlusProgrammeDecoder, undefined, onError, () => worker,
    );
    const ready = expect(decoder.prepare()).rejects.toThrow("decoder initialization failed");
    worker.emit({ type: "error", message: "decoder initialization failed" });
    await ready;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "decoder initialization failed" }));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("includes the browser error detail in startup failures", async () => {
    const worker = new FakeWorker();
    const decoder = new DabEnsembleWorkerDecoder(
      {} as DabPlusProgrammeDecoder, undefined, undefined, () => worker,
    );
    const ready = expect(decoder.prepare()).rejects.toThrow("DAB decoder worker failed: Failed to load module");
    worker.onerror?.call({} as Worker, { message: "Failed to load module" } as ErrorEvent);
    await ready;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects pending startup when explicitly closed", async () => {
    const decoder = new DabEnsembleWorkerDecoder(
      {} as DabPlusProgrammeDecoder, undefined, undefined, () => new FakeWorker(),
    );
    const ready = expect(decoder.prepare()).rejects.toThrow("DAB decoder worker closed.");
    decoder.close();
    await ready;
  });

  it("waits for readiness, batches small IQ blocks, and delivers decoded frames", async () => {
    const worker = new FakeWorker(),
      pushLogicalFrame = vi.fn(),
      programme = { pushLogicalFrame } as unknown as DabPlusProgrammeDecoder,
      decoder = new DabEnsembleWorkerDecoder(
        programme,
        undefined,
        undefined,
        () => worker,
      );
    decoder.setSampleRate(2_400_000);
    worker.emit({ type: "ready" });
    await decoder.prepare();
    expect(worker.postMessage).toHaveBeenNthCalledWith(1, {
      type: "configure",
      sampleRateHz: 2_400_000,
    });

    for (let block = 0; block < 7; block += 1)
      decoder.receiveSamples({
        I: new Float32Array(4_096).fill(block + 1),
        Q: new Float32Array(4_096).fill(-(block + 1)),
        frequency: 220_352_000,
      });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    decoder.receiveSamples({
      I: new Float32Array(4_096).fill(8),
      Q: new Float32Array(4_096).fill(-8),
      frequency: 220_352_000,
    });
    expect(worker.postMessage.mock.calls[1]?.[0]).toMatchObject({
      type: "samples",
    });
    expect(worker.postMessage.mock.calls[1]?.[0].I).toHaveLength(32_768);
    expect(worker.postMessage.mock.calls[1]?.[0].Q).toHaveLength(32_768);
    const frame = Uint8Array.of(5, 6, 7);
    worker.emit({ type: "logical-frame", generation: 0, data: frame });
    expect(pushLogicalFrame).toHaveBeenCalledWith(frame);
    decoder.reset();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "reset",
      generation: 1,
    });
    decoder.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("forwards worker status and failures", () => {
    const worker = new FakeWorker(),
      status = vi.fn(),
      error = vi.fn();
    new DabEnsembleWorkerDecoder(
      { pushLogicalFrame: vi.fn() } as unknown as DabPlusProgrammeDecoder,
      status,
      error,
      () => worker,
    );
    worker.emit({
      type: "status",
      generation: 0,
      status: {
        state: "fic",
        ficBlocks: 3,
        ficAttempts: 12,
        ficFrames: 1,
        ficFramesWithAny: 1,
        ficCompleteFrames: 0,
        ficSuccessHistogram: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ficGroupBlocks: [3, 0, 0, 0],
        logicalFrames: 0,
        fineFrequencyCorrectionHz: 12.5,
        coarseCarrierOffsetHz: 1_000,
        coarseCarrierLocked: true,
        timingStartSamples: 256,
        quadraturePolarity: "standard",
        message: "FIC synchronized",
      },
    });
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ ficBlocks: 3 }),
    );
    worker.emit({ type: "error", message: "decoder stopped" });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "decoder stopped" }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("absorbs a full 64-read USB completion burst without an unbounded queue", () => {
    const worker = new FakeWorker(),
      error = vi.fn();
    const decoder = new DabEnsembleWorkerDecoder(
      { pushLogicalFrame: vi.fn() } as unknown as DabPlusProgrammeDecoder,
      undefined,
      error,
      () => worker,
    );
    const block = {
      I: new Float32Array(16_384),
      Q: new Float32Array(16_384),
      frequency: 178_352_000,
    };
    for (let i = 0; i < 64; i += 1) decoder.receiveSamples(block);
    expect(error).not.toHaveBeenCalled();
    for (let i = 0; i < 65; i += 1) decoder.receiveSamples(block);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("bounded worker queue"),
      }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

it("rejects audio from previous selections, resets programme state and keeps consuming IQ buffers", () => {
  const worker = new FakeWorker(),
    pushLogicalFrame = vi.fn(),
    reset = vi.fn(),
    changed = vi.fn();
  const decoder = new DabEnsembleWorkerDecoder(
    { pushLogicalFrame, reset } as unknown as DabPlusProgrammeDecoder,
    undefined,
    undefined,
    () => worker,
    changed,
  );
  worker.emit({ type: "ready" });
  decoder.selectService("4660:5");
  decoder.selectService("4661:6");
  expect(worker.postMessage).toHaveBeenLastCalledWith({
    type: "select-service",
    key: "4661:6",
    generation: 2,
  });
  worker.emit({ type: "logical-frame", generation: 0, data: Uint8Array.of(1) });
  worker.emit({ type: "programme-change", generation: 1 });
  worker.emit({ type: "logical-frame", generation: 1, data: Uint8Array.of(2) });
  expect(pushLogicalFrame).not.toHaveBeenCalled();
  expect(reset).toHaveBeenCalledTimes(2);
  worker.emit({ type: "programme-change", generation: 2 });
  worker.emit({ type: "logical-frame", generation: 2, data: Uint8Array.of(3) });
  expect(reset).toHaveBeenCalledTimes(3);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(pushLogicalFrame).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(3));
  decoder.reset();
  worker.emit({ type: "logical-frame", generation: 2, data: Uint8Array.of(4) });
  expect(pushLogicalFrame).toHaveBeenCalledTimes(1);
  decoder.close();
});

it("flushes a short final block without padding and waits for worker consumption", async () => {
  const worker = new FakeWorker();
  const decoder = new DabEnsembleWorkerDecoder({} as DabPlusProgrammeDecoder, undefined, undefined, () => worker);
  worker.emit({ type: "ready" });
  decoder.receiveSamples({ I: Float32Array.of(1, 2, 3), Q: Float32Array.of(4, 5, 6), frequency: 220_352_000 });
  let drained = false;
  const completion = decoder.drain().then(() => { drained = true; });
  const message = worker.postMessage.mock.calls.at(-1)![0];
  expect(message).toMatchObject({ type: "samples", I: Float32Array.of(1, 2, 3), Q: Float32Array.of(4, 5, 6) });
  await Promise.resolve();
  expect(drained).toBe(false);
  worker.emit({ type: "consumed", I: message.I, Q: message.Q });
  await completion;
  expect(drained).toBe(true);
  decoder.close();
});
