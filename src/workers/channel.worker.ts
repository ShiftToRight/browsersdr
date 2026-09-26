import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import {
  WidebandChannelFilter,
  type ChannelWorkerInput,
  type ChannelWorkerOutput,
} from "../radio/widebandChannel";
import { createWasmChannel } from "../radio/wasmChannel";
let filter: {
  reset(offset: number): void;
  process(I: Float32Array, Q: Float32Array): number;
  processCi8?(bytes: Uint8Array, I: Float32Array, Q: Float32Array): number;
  processSc16?(bytes: Uint8Array, I: Float32Array, Q: Float32Array): number;
  dispose?(): void;
} = new WidebandChannelFilter();
let generation = -1;
// Zero forces the first configure message through the optimized WASM path.
// Starting at 4.8 MHz made that rate accidentally retain the much slower JS
// reference filter while the higher rates used the intended implementation.
let rate = 0;
let warmedRate = 0;
// Serialize async module loading with control and bounded sample messages.
let tasks = Promise.resolve();
let ci8Scratch: [Float32Array, Float32Array] | undefined;
self.onmessage = (event: MessageEvent<ChannelWorkerInput>) => {
  const message = event.data;
  tasks = tasks
    .then(async () => {
      if (message.type === "configure") {
        const nextRate = message.sampleRateHz ?? 4_800_000;
        if (nextRate !== rate) {
          filter.dispose?.();
          filter = await createWasmChannel(nextRate);
          rate = nextRate;
        }
        filter.reset(message.offsetHz);
        generation = message.generation;
        if (warmedRate !== rate) {
          const I = new Float32Array(32768),
            Q = new Float32Array(32768);
          // Exercise the translated path before high-rate RX, allowing browser WASM
          // tiering to finish without consuming acquisition queue headroom.
          if (rate === 19_200_000) filter.reset(1_000_000);
          for (let block = 0; block < (rate === 19_200_000 ? 128 : 16); block++)
            filter.process(I, Q);
          filter.reset(message.offsetHz);
          warmedRate = rate;
        }
        self.postMessage({
          type: "ready",
          generation,
        } satisfies ChannelWorkerOutput);
      } else {
        const before = performance.now();
        let count = 0;
        if (message.generation === generation) {
          if (message.type === "ci8" || message.type === "sc16") {
            if (
              message.bytes.length !==
              message.inputCount * (message.type === "ci8" ? 2 : 4)
            )
              throw new Error("Invalid native channel count.");
            const nativeProcess =
              message.type === "ci8" ? filter.processCi8 : filter.processSc16;
            if (nativeProcess)
              count = nativeProcess.call(
                filter,
                message.bytes,
                message.I,
                message.Q,
              );
            else {
              ci8Scratch ??= [new Float32Array(32768), new Float32Array(32768)];
              const length =
                message.type === "ci8"
                  ? decodeCi8Into(message.bytes, ...ci8Scratch)
                  : decodeSc16Q11Into(message.bytes, ...ci8Scratch);
              count = filter.process(
                ci8Scratch[0].subarray(0, length),
                ci8Scratch[1].subarray(0, length),
              );
              message.I.set(ci8Scratch[0].subarray(0, count));
              message.Q.set(ci8Scratch[1].subarray(0, count));
            }
          } else count = filter.process(message.I, message.Q);
        }
        self.postMessage(
          {
            ...message,
            count,
            processingMs: performance.now() - before,
          } satisfies ChannelWorkerOutput,
          {
            transfer:
              message.type === "samples"
                ? [message.I.buffer, message.Q.buffer]
                : [message.bytes.buffer, message.I.buffer, message.Q.buffer],
          },
        );
      }
    })
    .catch((error) => {
      self.postMessage({
        type: "error",
        message: String(error),
      } satisfies ChannelWorkerOutput);
    });
};
