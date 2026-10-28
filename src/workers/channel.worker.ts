import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import { decodeUsrpB205Sc16Into } from "../radio/usrpB205RxVrt";
import {
  CHANNEL_MAX_SAMPLES,
  WidebandChannelFilter,
  type ChannelWorkerInput,
  type ChannelWorkerOutput,
} from "../radio/widebandChannel";
import { createWasmChannel, warmChannelFilter } from "../radio/wasmChannel";
import { isAirspyRate } from "../radio/airspySettings";
import { AirspyChannelFilter } from "../radio/airspyChannel";
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
let warmedNative: import("../radio/widebandChannel").NativeChannelEncoding | undefined;
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
          filter = isAirspyRate(nextRate) ? new AirspyChannelFilter(nextRate) : await createWasmChannel(nextRate);
          rate = nextRate;
        }
        filter.reset(message.offsetHz);
        generation = message.generation;
        const native = message.native ?? false;
        if (warmedRate !== rate || warmedNative !== native) {
          warmChannelFilter(filter, rate, message.offsetHz, native);
          warmedRate = rate;
          warmedNative = native;
        }
        self.postMessage({
          type: "ready",
          generation,
        } satisfies ChannelWorkerOutput);
      } else {
        const before = performance.now();
        let count = 0;
        if (message.generation === generation) {
          if (message.type === "ci8" || message.type === "sc16" || message.type === "usrp-sc16") {
            if (
              message.bytes.length !==
              message.inputCount * (message.type === "ci8" ? 2 : 4)
            )
              throw new Error("Invalid native channel count.");
            const nativeProcess = message.type === "ci8"
              ? filter.processCi8
              : message.type === "sc16"
                ? filter.processSc16
                : undefined;
            if (nativeProcess)
              count = nativeProcess.call(
                filter,
                message.bytes,
                message.I,
                message.Q,
              );
            else {
              if (!ci8Scratch || ci8Scratch[0].length < message.inputCount)
                ci8Scratch = [
                  new Float32Array(message.inputCount),
                  new Float32Array(message.inputCount),
                ];
              const length =
                message.type === "ci8"
                  ? decodeCi8Into(message.bytes, ...ci8Scratch)
                  : message.type === "sc16"
                    ? decodeSc16Q11Into(message.bytes, ...ci8Scratch)
                    : decodeUsrpB205Sc16Into(message.bytes, ...ci8Scratch);
              if (message.type === "usrp-sc16") {
                for (let offset = 0; offset < length; offset += CHANNEL_MAX_SAMPLES) {
                  const end = Math.min(length, offset + CHANNEL_MAX_SAMPLES);
                  const I = ci8Scratch[0].subarray(offset, end);
                  const Q = ci8Scratch[1].subarray(offset, end);
                  const produced = filter.process(I, Q);
                  message.I.set(I.subarray(0, produced), count);
                  message.Q.set(Q.subarray(0, produced), count);
                  count += produced;
                }
              } else {
                count = filter.process(
                  ci8Scratch[0].subarray(0, length),
                  ci8Scratch[1].subarray(0, length),
                );
                message.I.set(ci8Scratch[0].subarray(0, count));
                message.Q.set(ci8Scratch[1].subarray(0, count));
              }
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
