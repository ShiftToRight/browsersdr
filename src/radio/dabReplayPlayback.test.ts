import { afterEach, expect, it, vi } from "vitest";
import { createDabReplayPlayback } from "./dabReplayPlayback";
import { makeSuperframe } from "../testing/dabPlusFixture";
import type { DabWebCodecsBindings } from "../dab/dabAudio";
import type { DabWorkerOutput } from "../dab/dabEnsembleWorker";
import type { ReceiverBackendEvents } from "./receiverController";

afterEach(() => vi.unstubAllGlobals());
it("routes valid DAB+ logical frames through AAC decoding to scheduled PCM and drains audio at EOF", async () => {
  class FakeWorker {
    onmessage?: (event: MessageEvent<DabWorkerOutput>) => void;
    postMessage() {}
    terminate() {}
    static instances: FakeWorker[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    emit(message: DabWorkerOutput) {
      this.onmessage?.({ data: message } as MessageEvent<DabWorkerOutput>);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const start = vi.fn();
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource: () => {
      const source = {
        connect() {},
        disconnect() {},
        stop() {},
        onended: () => {},
        start: () => {
          start();
          queueMicrotask(() => source.onended());
        },
      };
      return source;
    },
  } as unknown as AudioContext;
  const decode = vi.fn();
  const bindings = {
    available: () => true,
    isConfigSupported: async (config: AudioDecoderConfig) => ({
      supported: true,
      config,
    }),
    createChunk: (chunk: unknown) => chunk,
    createDecoder: ({ output }: { output: (data: unknown) => void }) => ({
      state: "configured",
      configure() {},
      reset() {},
      close() {},
      flush: async () => undefined,
      decode: () => {
        decode();
        output({
          numberOfChannels: 2,
          numberOfFrames: 960,
          sampleRate: 48_000,
          copyTo: (destination: Float32Array) => destination.fill(0.25),
          close() {},
        });
      },
    }),
  } as unknown as DabWebCodecsBindings;
  const dabChanged = vi.fn(),
    runtimeError = vi.fn();
  const events = {
    dabChanged,
    runtimeError,
  } as unknown as ReceiverBackendEvents;
  const playback = createDabReplayPlayback(context, events, 0.5, bindings);
  const port = FakeWorker.instances[0]!;
  port.emit({ type: "ready" });
  const frame = makeSuperframe();
  for (let offset = 0; offset < frame.length; offset += 24)
    port.emit({
      type: "logical-frame",
      generation: 0,
      data: frame.slice(offset, offset + 24),
    });
  await playback.flush();
  expect(decode).toHaveBeenCalledTimes(3);
  expect(start).toHaveBeenCalledTimes(3);
  expect(dabChanged.mock.calls.at(-1)?.[0]).toMatchObject({
    superframeCount: 1,
    accessUnitCount: 3,
    decodedAudioSeconds: 0.06,
  });
  expect(runtimeError).not.toHaveBeenCalled();
  playback.close();
});
