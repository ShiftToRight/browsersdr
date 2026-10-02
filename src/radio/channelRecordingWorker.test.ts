import { afterEach, expect, it, vi } from "vitest";
import { ChannelRecordingWorker, CHANNEL_RECORDING_QUEUE_MAX_BYTES, type ChannelRecordingInput, type ChannelRecordingOutput } from "./channelRecordingWorker";
import { CU8_FORMAT, IqRecorder } from "./iqRecording";
import { planChannelCapture } from "./channelRecording";

const plan = planChannelCapture({ actualSampleRateHz: 2_400_000, hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_000_000, channelBandwidthHz: 150_000, mode: "WBFM" });
class FakeWorker {
  onmessage?: (event: MessageEvent<ChannelRecordingOutput>) => void;
  onerror?: (event: ErrorEvent) => void;
  postMessage = vi.fn<(message: ChannelRecordingInput, transfers?: Transferable[]) => void>();
  terminate = vi.fn();
  emit(message: ChannelRecordingOutput) { this.onmessage?.({ data: message } as MessageEvent<ChannelRecordingOutput>); }
}
it("copies borrowed input, bounds the queue and drains accepted output before finishing", async () => {
  const port = new FakeWorker(), output = vi.fn();
  const worker = new ChannelRecordingWorker(plan, CU8_FORMAT, 2, output, () => port as unknown as Worker);
  const input = Uint8Array.of(1, 2, 3, 4);
  expect(worker.appendBytes(input, 1)).toBe(true);
  input.fill(0);
  const sent = port.postMessage.mock.calls.at(-1)![0];
  expect(sent).toMatchObject({ type: "bytes", bytes: Uint8Array.of(1, 2, 3, 4), outputLimit: 1 });
  expect(worker.appendBytes(new Uint8Array(CHANNEL_RECORDING_QUEUE_MAX_BYTES), 1)).toBe(false);
  let settled = false;
  const done = worker.finish().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  port.emit({ type: "bytes", bytes: Uint8Array.of(5, 6) });
  port.emit({ type: "consumed", inputBytes: 4 });
  port.emit({ type: "finished" });
  await done;
  expect(output).toHaveBeenCalledWith(Uint8Array.of(5, 6));
  expect(port.terminate).toHaveBeenCalledOnce();
  expect(worker.appendBytes(input, 1)).toBe(false);
});
it("rejects finalization after a worker or storage callback failure", async () => {
  const port = new FakeWorker();
  const worker = new ChannelRecordingWorker(plan, CU8_FORMAT, 2, () => { throw new Error("storage queue full"); }, () => port as unknown as Worker);
  port.emit({ type: "bytes", bytes: Uint8Array.of(1, 2) });
  expect(worker.failed).toBe(true);
  await expect(worker.finish()).rejects.toThrow("storage queue full");
  expect(port.terminate).toHaveBeenCalledOnce();
});

afterEach(() => vi.unstubAllGlobals());
it("discloses an early processing-queue stop and excludes rejected input from export", async () => {
  const port = new FakeWorker();
  vi.stubGlobal("Worker", class { constructor() { return port; } });
  const recorder = new IqRecorder({ source: "rtl-sdr", sessionGeneration: 1,
    requestedSampleRateHz: 2_400_000, actualSampleRateHz: 2_400_000,
    hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_000_000,
    mode: "WBFM", channelBandwidthHz: 150_000, squelch: 0, gainDb: null,
    sampleFormat: "planar-f32-iq-normalized" }, undefined, undefined, undefined, undefined,
    CU8_FORMAT, "memory", { captureCurrentChannel: true });
  recorder.appendCu8(new Uint8Array(CHANNEL_RECORDING_QUEUE_MAX_BYTES + 2));
  expect(recorder.status()).toMatchObject({ state: "capacity-reached", sampleCount: 0 });
  const recording = recorder.finish();
  expect(recording.metadata.captureWarning).toContain("channel processing could not keep up");
  port.emit({ type: "finished" });
  expect((await recording.dataBlob!)!.size).toBe(0);
});
