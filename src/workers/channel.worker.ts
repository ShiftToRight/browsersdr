import { WidebandChannelFilter, type ChannelWorkerInput, type ChannelWorkerOutput } from "../radio/widebandChannel";
import { createWasmChannel } from "../radio/wasmChannel";
let filter: { reset(offset: number): void; process(I: Float32Array, Q: Float32Array): number; dispose?(): void } = new WidebandChannelFilter();
let generation = -1;
let rate = 4_800_000;
let warmedRate = 0;
// Serialize async module loading with control and bounded sample messages.
let tasks = Promise.resolve();
self.onmessage = (event: MessageEvent<ChannelWorkerInput>) => {
  const message = event.data;
  tasks = tasks.then(async () => {
    if (message.type === "configure") {
      const nextRate = message.sampleRateHz ?? 4_800_000;
      if (nextRate !== rate) {
        filter.dispose?.();
        filter = nextRate === 9_600_000 ? await createWasmChannel() : new WidebandChannelFilter(0, nextRate);
        rate = nextRate;
      }
      filter.reset(message.offsetHz); generation = message.generation;
      if (warmedRate !== rate) {
        const I = new Float32Array(32768), Q = new Float32Array(32768);
        for (let block = 0; block < 16; block++) filter.process(I, Q);
        filter.reset(message.offsetHz); warmedRate = rate;
      }
      self.postMessage({ type: "ready", generation } satisfies ChannelWorkerOutput);
    } else {
      const count = message.generation === generation ? filter.process(message.I, message.Q) : 0;
      self.postMessage({ ...message, count } satisfies ChannelWorkerOutput, { transfer: [message.I.buffer, message.Q.buffer] });
    }
  }).catch(error => { self.postMessage({ type: "error", message: String(error) } satisfies ChannelWorkerOutput); });
};
