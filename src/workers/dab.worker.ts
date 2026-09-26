import { DabModeIProcessor, type DabModeIStatus } from "../dab/dabModeI";
import type { DabWorkerInput, DabWorkerOutput } from "../dab/dabEnsembleWorker";

let generation = 0;
const processor = new DabModeIProcessor(
  (data) => {
    const owned = Uint8Array.from(data);
    self.postMessage(
      {
        type: "logical-frame",
        generation,
        data: owned,
      } satisfies DabWorkerOutput,
      { transfer: [owned.buffer] },
    );
  },
  (status: DabModeIStatus) =>
    self.postMessage({
      type: "status",
      generation,
      status,
    } satisfies DabWorkerOutput),
  () =>
    self.postMessage({
      type: "programme-change",
      generation,
    } satisfies DabWorkerOutput),
);
self.postMessage({ type: "ready" } satisfies DabWorkerOutput);

self.onmessage = (event: MessageEvent<DabWorkerInput>) => {
  try {
    const message = event.data;
    if (message.type === "configure")
      processor.setSampleRate(message.sampleRateHz);
    else if (message.type === "reset") {
      generation = message.generation;
      processor.reset();
    } else if (message.type === "select-service") {
      generation = message.generation;
      processor.selectService(message.key);
    } else {
      processor.push(message.I, message.Q);
      self.postMessage(
        {
          type: "consumed",
          I: message.I,
          Q: message.Q,
        } satisfies DabWorkerOutput,
        { transfer: [message.I.buffer, message.Q.buffer] },
      );
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies DabWorkerOutput);
  }
};
