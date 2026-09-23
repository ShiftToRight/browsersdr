import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "./spectrumProtocol";
import { AnalysisPipeline } from "./analysisPipeline";

class FakeWorker {
  onmessage: ((event: MessageEvent<AnalysisWorkerOutput>) => void) | null = null;
  readonly sent: AnalysisWorkerInput[] = [];
  postMessage(message: AnalysisWorkerInput): void { this.sent.push(message); }
  terminate(): void {}
  emit(message: AnalysisWorkerOutput): void { this.onmessage?.({ data: message } as MessageEvent<AnalysisWorkerOutput>); }
}

const METADATA = {
  source: "synthetic" as const,
  sessionGeneration: 7,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_125_000,
  mode: "WBFM" as const,
  channelBandwidthHz: 150_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("AnalysisPipeline credits", () => {
  it("feeds the GPU tap independently of worker credits and forwards only source gaps", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const received: { discontinuity: boolean; missingSamples: number }[] = [];
    const detach = pipeline.attachGpuTap(block => received.push({ discontinuity: block.discontinuity, missingSamples: block.missingSamples }));
    const receiver = pipeline.begin(METADATA);
    const block = { I: new Float32Array(8), Q: new Float32Array(8), frequency: 100_000_000 };
    receiver.receiveSamples(block);
    receiver.receiveSamples(block);
    pipeline.markDiscontinuity(123);
    receiver.receiveSamples(block);
    receiver.receiveSamples(block);
    expect(received).toEqual([
      { discontinuity: false, missingSamples: 0 }, { discontinuity: false, missingSamples: 0 },
      { discontinuity: true, missingSamples: 123 }, { discontinuity: false, missingSamples: 0 },
    ]);
    expect(worker.sent.filter(message => message.type === "samples")).toHaveLength(1);
    detach();
    receiver.receiveSamples(block);
    expect(received).toHaveLength(4);
  });
  it("rejects old source callbacks even after a new source begins", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const old = pipeline.begin(METADATA);
    pipeline.stop();
    pipeline.begin({ ...METADATA, sessionGeneration: 8 });
    old.setSampleRate(42);
    old.receiveSamples({ I: new Float32Array(8), Q: new Float32Array(8), frequency: 1 });
    expect(worker.sent.filter((message) => message.type === "samples")).toHaveLength(0);
    expect(pipeline.getDiagnostics().receivedComplexSamples).toBe(0);
  });

  it("keeps recorded gap lengths on the analysis source clock", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    pipeline.markDiscontinuity(400);
    receiver.receiveSamples({ I: new Float32Array(8), Q: new Float32Array(8), frequency: 100_000_000 });
    expect(worker.sent.find((message) => message.type === "samples")).toMatchObject({ discontinuity: true, droppedInputSamples: 400 });
  });
  it("allows one input message and marks skipped input as a discontinuity", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    const block = { I: new Float32Array(8), Q: new Float32Array(8), frequency: 100_000_000 };
    receiver.receiveSamples(block);
    receiver.receiveSamples(block);
    expect(worker.sent.filter((message) => message.type === "samples")).toHaveLength(1);
    const first = worker.sent.find((message) => message.type === "samples");
    if (!first || first.type !== "samples") throw new Error("Missing sample message");
    worker.emit({ type: "samples-ack", sessionGeneration: 7, processingTimeMs: 1.25, backend: "WebAssembly · RustFFT", backendStartupMs: 2, I: first.I, Q: first.Q });
    receiver.receiveSamples(block);
    const samples = worker.sent.filter((message) => message.type === "samples");
    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({ discontinuity: true, droppedInputBlocks: 1 });
    expect(pipeline.getDiagnostics()).toMatchObject({
      receivedComplexSamples: 24,
      receivedBytes: null,
      processedBlocks: 1,
      processingTimeAverageMs: 1.25,
      skippedInputBlocks: 1,
      skippedInputSamples: 8,
      knownApplicationDiscontinuities: 1,
      analysisBackend: "WebAssembly · RustFFT",
      backendStartupMs: 2,
    });
  });

  it("does not return spectrum credit until the animation consumer runs", () => {
    const worker = new FakeWorker();
    let animationCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationCallback = callback; return 1; });
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    pipeline.begin(METADATA);
    const listener = vi.fn();
    pipeline.subscribe(listener);
    worker.emit({
      type: "spectrum", sessionGeneration: 7, sequence: 0, timestampMs: 1,
      centerFrequencyHz: 100_000_000, sampleRateHz: 1_024_000, sampleIndex: 16_384,
      bins: new Float32Array(4096).buffer, droppedFramesBefore: 0, skippedSpectrumFramesBefore: 0,
    });
    expect(worker.sent.some((message) => message.type === "spectrum-credit")).toBe(false);
    animationCallback?.(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(worker.sent.some((message) => message.type === "spectrum-credit")).toBe(true);
  });

  it("rejects stale worker frames after a retune generation", () => {
    const worker = new FakeWorker();
    let animationCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationCallback = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    pipeline.begin(METADATA);
    const listener = vi.fn();
    pipeline.subscribe(listener);
    pipeline.retune({ ...METADATA, sessionGeneration: 8, hardwareCenterFrequencyHz: 101_000_000 });
    worker.emit({ type: "spectrum", sessionGeneration: 7, sequence: 4, timestampMs: 2, sampleIndex: 16_384, centerFrequencyHz: 100_000_000, sampleRateHz: 1_024_000, bins: new Float32Array(4096).buffer, droppedFramesBefore: 0, skippedSpectrumFramesBefore: 0 });
    animationCallback?.(3);
    expect(listener).not.toHaveBeenCalled();
    worker.emit({ type: "spectrum", sessionGeneration: 8, sequence: 0, timestampMs: 3, sampleIndex: 16_384, centerFrequencyHz: 101_000_000, sampleRateHz: 1_024_000, bins: new Float32Array(4096).buffer, droppedFramesBefore: 0, skippedSpectrumFramesBefore: 0 });
    animationCallback?.(4);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
