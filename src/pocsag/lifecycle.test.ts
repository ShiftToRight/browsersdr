import { it, expect, vi } from "vitest";
import { PocsagDigitalReceiver } from "./pocsagDigitalReceiver";
import { PocsagReceiver } from "./pocsagReceiver";
import { pocsagConfiguration } from "./settings";
import type { PocsagSnapshot, PocsagEvent } from "./types";
import type {
  DigitalWorkerPort,
  DigitalWorkerInput,
  DigitalWorkerOutput,
} from "../digital";
import { pocsagBits, pocsagAudio } from "./fixtures/testSignal";
import { PocsagDemodulator } from "./demodulator";
import { PocsagFramer, type FramedMessage } from "./framing";
import { defaultPocsagSettings } from "./settings";

class Port implements DigitalWorkerPort<PocsagSnapshot, PocsagEvent> {
  onmessage:
    | ((
        e: MessageEvent<DigitalWorkerOutput<PocsagSnapshot, PocsagEvent>>,
      ) => void)
    | null = null;
  onerror: OnErrorEventHandler | null = null;
  messages: DigitalWorkerInput<ReturnType<typeof pocsagConfiguration>>[] = [];
  terminate = vi.fn();
  postMessage(m: DigitalWorkerInput<ReturnType<typeof pocsagConfiguration>>) {
    this.messages.push(m);
  }
  reply(m: DigitalWorkerOutput<PocsagSnapshot, PocsagEvent>) {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}
it("POCSAG bridge awaits readiness, caps eight borrowed blocks and cancels an obsolete EOF", async () => {
  const port = new Port(),
    update = vi.fn(),
    error = vi.fn();
  const r = new PocsagDigitalReceiver(update, error, () => port);
  r.configureSession(pocsagConfiguration(undefined, 1_024_000, 3));
  let prepared = false;
  const ready = r.prepare().then(() => {
    prepared = true;
  });
  await Promise.resolve();
  expect(prepared).toBe(false);
  port.reply({ type: "ready", generation: 3 });
  await ready;
  const block = {
    I: new Float32Array(64),
    Q: new Float32Array(64),
    frequency: 440e6,
  };
  for (let i = 0; i < 10; i++) r.receiveSamples(block);
  expect(r.diagnostics).toMatchObject({
    queuedBlocks: 8,
    droppedInputBlocks: 2,
    droppedInputSamples: 128,
  });
  const first = port.messages.find((m) => m.type === "samples")!;
  if (first.type !== "samples") throw new Error("missing samples");
  expect(first.I).not.toBe(block.I);
  port.reply({
    type: "consumed",
    generation: 3,
    sequence: first.sequence,
    I: first.I,
    Q: first.Q,
  });
  r.receiveSamples(block);
  expect(port.messages.at(-1)).toMatchObject({
    type: "samples",
    discontinuityBefore: { reason: "queue-overflow", missingInputSamples: 128 },
  });
  const flushing = r.flush();
  const rejected = expect(flushing).rejects.toThrow("configuration changed");
  r.configureSession(pocsagConfiguration(undefined, 1_024_000, 4));
  await rejected;
  const core = new PocsagReceiver();
  core.configure(pocsagConfiguration(undefined, 1_024_000, 3));
  port.reply({ type: "snapshot", generation: 3, publication: core.snapshot() });
  expect(update).not.toHaveBeenCalled();
  expect(r.diagnostics.staleResults).toBe(1);
  const waiting = r.prepare();
  const disposed = expect(waiting).rejects.toThrow("disposed");
  r.dispose();
  await disposed;
  expect(port.terminate).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});
it("an erasure keeps its bit alignment and integrity separate from the framing end", () => {
  const result: FramedMessage[] = [];
  const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    result.push(m),
  );
  const bits = pocsagBits("MESSAGE WITH A DAMAGED WORD");
  // Address starts at 672, first payload at 704; damage second payload after confirmation.
  for (const n of [736, 737, 738]) bits[n] = bits[n]! ^ 1;
  bits.forEach((b, n) => f.push(b, n));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    address: 123456,
    complete: true,
    ending: "idle",
    erasures: [20],
  });
  expect(result[0]!.payloadBits.slice(20, 40)).toBe("?".repeat(20));
});
it("a message limit discards continuation until a fresh valid address", () => {
  const result: FramedMessage[] = [];
  const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    result.push(m),
  );
  const bits = pocsagBits("L".repeat(900));
  bits.forEach((b, n) => f.push(b, n));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ complete: false, ending: "limit" });
  expect(result[0]!.payloadBits).toHaveLength(128 * 20);
  pocsagBits("NEW ADDRESS", 123464).forEach((b, n) =>
    f.push(b, bits.length + n),
  );
  expect(result.at(-1)).toMatchObject({
    address: 123464,
    text: "NEW ADDRESS",
    complete: true,
  });
});
it("fixed rate/polarity and minimum transmitted preamble decode without auto assistance", () => {
  for (const rate of [512, 1200, 2400] as const) {
    const bits = pocsagBits("MINIMUM PREAMBLE").slice(64);
    const audio = pocsagAudio(bits, rate, 64000);
    const run = (
      configuredRate: 512 | 1200 | 2400,
      polarity: "normal" | "inverted",
    ) => {
      const result: FramedMessage[] = [];
      const modem = new PocsagDemodulator(
        64000,
        { ...defaultPocsagSettings(), rate: configuredRate, polarity },
        64000,
        (m) => result.push(m),
      );
      for (let n = 0; n < audio.length; n += 997)
        modem.process(audio.subarray(n, n + 997), n, 1);
      modem.flush();
      return result;
    };
    expect(run(rate, "normal")[0]).toMatchObject({
      rate,
      polarity: "normal",
      text: "MINIMUM PREAMBLE",
    });
    expect(run(rate, "inverted")).toEqual([]);
    expect(run(rate === 512 ? 1200 : 512, "normal")).toEqual([]);
  }
});

it("labels bounded raw display truncation while retaining every payload bit", () => {
  const result: FramedMessage[] = [];
  const f = new PocsagFramer(
    1200,
    { ...defaultPocsagSettings(), interpretation: "raw" },
    1,
    (m) => result.push(m),
  );
  pocsagBits("L".repeat(500)).forEach((b, n) => f.push(b, n));
  expect(result[0]).toMatchObject({ displayTruncated: true, ending: "limit" });
  expect(result[0]!.text).toHaveLength(2048);
  expect(result[0]!.payloadBits).toHaveLength(2560);
});
