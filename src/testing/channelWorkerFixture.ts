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
    else output = { ...input, count: input.generation === this.generation ? this.filter.process(input.I, input.Q) : 0 };
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data: output }));
  }
  terminate(): void { this.closed = true; this.pending.length = 0; }
}
