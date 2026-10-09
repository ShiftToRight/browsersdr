import { describe, expect, it, vi } from "vitest";
import type { DigitalPublication } from "./contracts";
import {
  BoundedDigitalWorkerAdapter,
  type DigitalWorkerInput,
  type DigitalWorkerOutput,
  type DigitalWorkerPort,
} from "./workerAdapter";

interface Configuration {
  actualInputSampleRateHz: number;
  selectedChannelOffsetHz: number;
  generation: number;
  mode: "test";
}

class FakeWorker implements DigitalWorkerPort<
  { count: number },
  { name: string }
> {
  onmessage:
    | ((
        event: MessageEvent<
          DigitalWorkerOutput<{ count: number }, { name: string }>
        >,
      ) => void)
    | null = null;
  onerror: OnErrorEventHandler | null = null;
  readonly messages: DigitalWorkerInput<Configuration>[] = [];
  terminated = false;
  postMessage(message: DigitalWorkerInput<Configuration>): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(
    message: DigitalWorkerOutput<{ count: number }, { name: string }>,
  ): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }
}

const config = (generation: number): Configuration => ({
  actualInputSampleRateHz: 1_024_000,
  selectedChannelOffsetHz: 0,
  generation,
  mode: "test",
});

const block = (generation: number, firstSampleIndex: number, length = 4) => ({
  I: new Float32Array(length),
  Q: new Float32Array(length),
  generation,
  firstSampleIndex,
});

const publication = <T>(
  generation: number,
  value: T,
): DigitalPublication<T> => ({
  sequence: 0,
  provenance: {
    generation,
    firstInputSampleIndex: 0,
    lastInputSampleIndex: 3,
    actualInputSampleRateHz: 1_024_000,
    selectedChannelOffsetHz: 0,
  },
  value,
});

describe("BoundedDigitalWorkerAdapter", () => {
  it("caps outstanding owned inputs and reports the dropped gap on the next block", () => {
    const worker = new FakeWorker();
    const dropped = vi.fn();
    const adapter = new BoundedDigitalWorkerAdapter(worker, { dropped }, 2);
    adapter.configure(config(7));
    expect(adapter.submitOwned(block(7, 0))).toBe(true);
    expect(adapter.submitOwned(block(7, 4))).toBe(true);
    const rejected = block(7, 8, 6);
    expect(adapter.submitOwned(rejected)).toBe(false);
    expect(rejected.I.byteLength).toBe(24); // false retains caller ownership
    expect(adapter.diagnostics).toMatchObject({
      queuedBlocks: 2,
      peakQueuedBlocks: 2,
      droppedInputBlocks: 1,
      droppedInputSamples: 6,
    });
    const firstSamples = worker.messages.find(
      (message) => message.type === "samples",
    );
    if (!firstSamples || firstSamples.type !== "samples")
      throw new Error("Expected a samples message.");
    worker.reply({
      type: "consumed",
      generation: 7,
      sequence: firstSamples.sequence,
      I: new Float32Array(4),
      Q: new Float32Array(4),
    });
    expect(adapter.submitOwned(block(7, 14))).toBe(true);
    expect(worker.messages.at(-1)).toMatchObject({
      type: "samples",
      discontinuityBefore: {
        reason: "queue-overflow",
        missingInputSamples: 6,
        droppedInputBlocks: 1,
      },
    });
    expect(dropped).toHaveBeenCalledOnce();
  });

  it("rejects stale publications but accepts old consumed replies to release capacity", () => {
    const worker = new FakeWorker();
    const snapshot = vi.fn();
    const adapter = new BoundedDigitalWorkerAdapter(worker, { snapshot }, 1);
    adapter.configure(config(1));
    adapter.submitOwned(block(1, 0));
    const samples = worker.messages.at(-1)!;
    adapter.configure(config(2));
    worker.reply({
      type: "snapshot",
      generation: 1,
      publication: publication(1, { count: 1 }),
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(adapter.diagnostics.staleResults).toBe(1);
    worker.reply({
      type: "consumed",
      generation: 1,
      sequence: samples.type === "samples" ? samples.sequence : -1,
      I: new Float32Array(4),
      Q: new Float32Array(4),
    });
    expect(adapter.submitOwned(block(2, 0))).toBe(true);
    worker.reply({
      type: "snapshot",
      generation: 2,
      publication: publication(2, { count: 2 }),
    });
    expect(snapshot).toHaveBeenCalledWith(publication(2, { count: 2 }));
  });

  it("rejects oversized results and terminates idempotently", () => {
    const worker = new FakeWorker();
    const error = vi.fn();
    const adapter = new BoundedDigitalWorkerAdapter(worker, { error }, 1, 8);
    adapter.configure(config(4));
    worker.reply({
      type: "event",
      generation: 4,
      publication: publication(4, { name: "too large" }),
    });
    expect(error).toHaveBeenCalledOnce();
    adapter.dispose();
    adapter.dispose();
    expect(worker.terminated).toBe(true);
    expect(() => adapter.submitOwned(block(4, 0))).toThrow(/disposed/);
  });
});

it("orders final input flush and ignores acknowledgements from another generation", async () => {
  const worker = new FakeWorker();
  const adapter = new BoundedDigitalWorkerAdapter(worker);
  adapter.configure(config(9));
  const flushed = vi.fn();
  const barrier = adapter.flush().then(flushed);
  const message = worker.messages.at(-1)!;
  expect(message.type).toBe("flush");
  if (message.type !== "flush") throw new Error("Missing flush");
  worker.reply({ type: "flushed", generation: 8, sequence: message.sequence });
  await Promise.resolve(); expect(flushed).not.toHaveBeenCalled();
  worker.reply({ type: "flushed", generation: 9, sequence: message.sequence });
  await barrier; expect(flushed).toHaveBeenCalledOnce();
  adapter.dispose();
});
