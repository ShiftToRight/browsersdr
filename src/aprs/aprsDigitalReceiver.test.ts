import { describe, expect, it, vi } from "vitest";
import type {
  DigitalPublication,
  DigitalWorkerInput,
  DigitalWorkerOutput,
  DigitalWorkerPort,
} from "../digital";
import { defaultAprsConfiguration } from "./settings";
import { AprsReceiver } from "./aprsReceiver";
import { AprsDigitalReceiver } from "./aprsDigitalReceiver";
import type { AprsEvent, AprsSnapshot } from "./types";

class FakeWorker implements DigitalWorkerPort<AprsSnapshot, AprsEvent> {
  onmessage:
    | ((
        event: MessageEvent<DigitalWorkerOutput<AprsSnapshot, AprsEvent>>,
      ) => void)
    | null = null;
  onerror: OnErrorEventHandler = null;
  readonly messages: DigitalWorkerInput<
    ReturnType<typeof defaultAprsConfiguration>
  >[] = [];
  readonly terminate = vi.fn();
  postMessage(message: unknown): void {
    this.messages.push(
      message as DigitalWorkerInput<
        ReturnType<typeof defaultAprsConfiguration>
      >,
    );
  }
  emit(message: DigitalWorkerOutput<AprsSnapshot, AprsEvent>): void {
    this.onmessage?.({ data: message } as MessageEvent<
      DigitalWorkerOutput<AprsSnapshot, AprsEvent>
    >);
  }
}

describe("AprsDigitalReceiver integration adapter", () => {
  it("owns submitted buffers, caps the queue, reports drops and rejects stale publications", () => {
    const worker = new FakeWorker(),
      updates = vi.fn();
    const receiver = new AprsDigitalReceiver(updates, vi.fn(), () => worker);
    receiver.configureSession(defaultAprsConfiguration(1_024_000, 7, 12_000));
    receiver.configure(1_024_000, 12_000);
    const sourceI = Float32Array.of(0.25, 0.5),
      sourceQ = Float32Array.of(-0.25, -0.5);
    for (let index = 0; index < 9; index++)
      receiver.receiveSamples({
        I: sourceI,
        Q: sourceQ,
        frequency: 100_000_000,
      });
    const samples = worker.messages.find(
      (message) => message.type === "samples",
    );
    expect(samples?.type).toBe("samples");
    if (samples?.type === "samples") {
      expect(samples.I).not.toBe(sourceI);
      expect(samples.Q).not.toBe(sourceQ);
      expect(samples.firstSampleIndex).toBe(0);
    }
    expect(Array.from(sourceI)).toEqual([0.25, 0.5]);
    expect(receiver.diagnostics).toMatchObject({
      queuedBlocks: 8,
      droppedInputBlocks: 1,
      droppedInputSamples: 2,
    });
    const publication: DigitalPublication<AprsSnapshot> = {
      sequence: 1,
      provenance: {
        generation: 6,
        firstInputSampleIndex: 0,
        lastInputSampleIndex: 1,
        actualInputSampleRateHz: 1_024_000,
        selectedChannelOffsetHz: 12_000,
      },
      value: new AprsReceiverForSnapshot().snapshot().value,
    };
    worker.emit({ type: "snapshot", generation: 6, publication });
    expect(updates).not.toHaveBeenCalled();
    expect(receiver.diagnostics.staleResults).toBe(1);
    expect(() =>
      receiver.configureSession({
        ...defaultAprsConfiguration(1_024_000, 8),
        outputSampleRateHz: 44_100,
      }),
    ).toThrow();
    expect(receiver.diagnostics.generation).toBe(7);
    receiver.reset({ reason: "source-gap", missingInputSamples: 100 });
    const first = worker.messages.find((message) => message.type === "samples");
    if (first?.type === "samples")
      worker.emit({
        type: "consumed",
        generation: 7,
        sequence: first.sequence,
        I: first.I,
        Q: first.Q,
      });
    receiver.receiveSamples({ I: sourceI, Q: sourceQ, frequency: 100_000_000 });
    const last = worker.messages
      .filter((message) => message.type === "samples")
      .at(-1);
    expect(last?.type === "samples" ? last.firstSampleIndex : -1).toBe(118);
    receiver.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

class AprsReceiverForSnapshot extends AprsReceiver {
  constructor() {
    super();
    this.configure(defaultAprsConfiguration(1_024_000, 6, 12_000));
  }
}
