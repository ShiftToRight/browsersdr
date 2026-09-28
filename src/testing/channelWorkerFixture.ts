import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import { decodeUsrpB205Sc16Into } from "../radio/usrpB205RxVrt";
import { CHANNEL_MAX_SAMPLES, WidebandChannelFilter, type ChannelWorkerInput, type ChannelWorkerOutput, type ChannelWorkerPort } from "../radio/widebandChannel";
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
    else if (input.type === "ci8" || input.type === "sc16" || input.type === "usrp-sc16") {
      const I = new Float32Array(input.inputCount), Q = new Float32Array(input.inputCount);
      if (input.type === "ci8") decodeCi8Into(input.bytes, I, Q);
      else if (input.type === "sc16") decodeSc16Q11Into(input.bytes, I, Q);
      else decodeUsrpB205Sc16Into(input.bytes, I, Q);
      let count = 0;
      if (input.generation === this.generation) {
        for (let offset = 0; offset < input.inputCount; offset += CHANNEL_MAX_SAMPLES) {
          const end = Math.min(input.inputCount, offset + CHANNEL_MAX_SAMPLES);
          const chunkI = I.subarray(offset, end), chunkQ = Q.subarray(offset, end);
          const produced = this.filter.process(chunkI, chunkQ);
          input.I.set(chunkI.subarray(0, produced), count);
          input.Q.set(chunkQ.subarray(0, produced), count);
          count += produced;
        }
      }
      output = { ...input, count };
    }
    else output = { ...input, count: input.generation === this.generation ? this.filter.process(input.I, input.Q) : 0 };
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data: output }));
  }
  terminate(): void { this.closed = true; this.pending.length = 0; }
}
