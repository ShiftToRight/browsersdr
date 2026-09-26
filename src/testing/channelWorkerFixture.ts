import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import { WidebandChannelFilter, type ChannelWorkerInput, type ChannelWorkerOutput, type ChannelWorkerPort } from "../radio/widebandChannel";
/** Runs the actual filter with transfer/detachment and asynchronous delivery. */
export class ChannelWorkerFixture {
  onmessage: ChannelWorkerPort["onmessage"] = null;
  onerror: ChannelWorkerPort["onerror"] = null;
  private filter = new WidebandChannelFilter();
  private generation = 0;
  private closed = false;
  readonly pending: ChannelWorkerInput[] = [];
  auto = true;
  postMessage(input: ChannelWorkerInput, transfers: Transferable[] | StructuredSerializeOptions = []): void {
    this.pending.push(structuredClone(input, { transfer: Array.isArray(transfers) ? transfers : transfers.transfer ?? [] }));
    if (this.auto) queueMicrotask(() => this.flushOne());
  }
  flushOne(): void {
    if (this.closed) return;
    const input = this.pending.shift(); if (!input) return;
    let output: ChannelWorkerOutput;
    if (input.type === "configure") { this.generation = input.generation; this.filter = new WidebandChannelFilter(input.offsetHz, input.sampleRateHz); output = { type: "ready", generation: input.generation }; }
    else if (input.type === "ci8" || input.type === "sc16") {
      const I = new Float32Array(input.inputCount), Q = new Float32Array(input.inputCount);
      if (input.type === "ci8") decodeCi8Into(input.bytes, I, Q); else decodeSc16Q11Into(input.bytes, I, Q);
      const count = input.generation === this.generation ? this.filter.process(I, Q) : 0;
      input.I.set(I.subarray(0, count)); input.Q.set(Q.subarray(0, count)); output = { ...input, count };
    }
    else output = { ...input, count: input.generation === this.generation ? this.filter.process(input.I, input.Q) : 0 };
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data: output }));
  }
  terminate(): void { this.closed = true; this.pending.length = 0; }
}
