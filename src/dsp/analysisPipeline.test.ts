import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisWorkerInput,
  AnalysisWorkerOutput,
} from "./spectrumProtocol";
import {
  AnalysisPipeline,
  ANALYSIS_MAX_BLOCK_SAMPLES,
  ANALYSIS_DISPLAY_QUEUE_CAPACITY,
  ANALYSIS_WIDEBAND_INPUT_SLOTS,
} from "./analysisPipeline";

import { WaterfallHistory } from "../graphics/waterfallHistory";

class FakeWorker {
  onmessage: ((event: MessageEvent<AnalysisWorkerOutput>) => void) | null =
    null;
  readonly sent: AnalysisWorkerInput[] = [];
  postMessage(message: AnalysisWorkerInput): void {
    this.sent.push(message);
  }
  terminate(): void {}
  emit(message: AnalysisWorkerOutput): void {
    this.onmessage?.({ data: message } as MessageEvent<AnalysisWorkerOutput>);
  }
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
  it("buffers sixteen native-rate blocks at 4.8 MS/s before marking overflow", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin({
      ...METADATA,
      source: "hackrf",
      requestedSampleRateHz: 4_800_000,
      actualSampleRateHz: 4_800_000,
    });
    const block = {
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 100_000_000,
    };
    for (let index = 0; index <= ANALYSIS_WIDEBAND_INPUT_SLOTS; index++)
      receiver.receiveSamples(block);

    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(ANALYSIS_WIDEBAND_INPUT_SLOTS);
    expect(pipeline.getDiagnostics()).toMatchObject({
      skippedInputBlocks: 1,
      skippedInputSamples: 8,
    });
  });

  it("rejects oversized blocks before allocating a worker copy", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    const I = new Float32Array(ANALYSIS_MAX_BLOCK_SAMPLES + 1);
    receiver.receiveSamples({ I, Q: I, frequency: 100_000_000 });
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(0);
    expect(pipeline.getDiagnostics().skippedInputSamples).toBe(I.length);
  });

  it("does not let old acknowledgements grant new-generation credits", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    const block = {
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 100_000_000,
    };
    receiver.receiveSamples(block);
    const old = worker.sent.find((message) => message.type === "samples")!;
    if (old.type !== "samples") throw new Error("missing sample");
    pipeline.retune({ ...METADATA, sessionGeneration: 8 });
    for (let index = 0; index < 4; index++) receiver.receiveSamples(block);
    worker.emit({
      type: "samples-ack",
      sessionGeneration: 7,
      processingTimeMs: 1,
      backend: "JavaScript reference",
      backendStartupMs: 0,
      I: old.I,
      Q: old.Q,
    });
    receiver.receiveSamples(block);
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(5);
    expect(pipeline.getDiagnostics().skippedInputBlocks).toBe(1);
  });

  it("feeds the GPU tap independently of worker credits and forwards only source gaps", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const received: { discontinuity: boolean; missingSamples: number }[] = [];
    const detach = pipeline.attachGpuTap((block) =>
      received.push({
        discontinuity: block.discontinuity,
        missingSamples: block.missingSamples,
      }),
    );
    const receiver = pipeline.begin(METADATA);
    const block = {
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 100_000_000,
    };
    receiver.receiveSamples(block);
    receiver.receiveSamples(block);
    pipeline.markDiscontinuity(123);
    receiver.receiveSamples(block);
    receiver.receiveSamples(block);
    expect(received).toEqual([
      { discontinuity: false, missingSamples: 0 },
      { discontinuity: false, missingSamples: 0 },
      { discontinuity: true, missingSamples: 123 },
      { discontinuity: false, missingSamples: 0 },
    ]);
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(4);
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
    old.receiveSamples({
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 1,
    });
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(0);
    expect(pipeline.getDiagnostics().receivedComplexSamples).toBe(0);
  });

  it("keeps recorded gap lengths on the analysis source clock", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    pipeline.markDiscontinuity(400);
    receiver.receiveSamples({
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 100_000_000,
    });
    expect(
      worker.sent.find((message) => message.type === "samples"),
    ).toMatchObject({ discontinuity: true, droppedInputSamples: 400 });
  });
  it("absorbs a four-block burst and marks overflow as a discontinuity", () => {
    const worker = new FakeWorker();
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const receiver = pipeline.begin(METADATA);
    const block = {
      I: new Float32Array(8),
      Q: new Float32Array(8),
      frequency: 100_000_000,
    };
    for (let index = 0; index < 5; index++) receiver.receiveSamples(block);
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(4);
    const first = worker.sent.find((message) => message.type === "samples");
    if (!first || first.type !== "samples")
      throw new Error("Missing sample message");
    worker.emit({
      type: "samples-ack",
      sessionGeneration: 7,
      processingTimeMs: 1.25,
      backend: "WebAssembly · RustFFT",
      backendStartupMs: 2,
      I: first.I,
      Q: first.Q,
    });
    receiver.receiveSamples(block);
    const samples = worker.sent.filter((message) => message.type === "samples");
    expect(samples).toHaveLength(5);
    expect(samples[4]).toMatchObject({
      discontinuity: true,
      droppedInputBlocks: 1,
    });
    expect(pipeline.getDiagnostics()).toMatchObject({
      receivedComplexSamples: 48,
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

  it("delivers measurements and returns credits while display animation is withheld", () => {
    const worker = new FakeWorker();
    let animationCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationCallback = callback;
      return 1;
    });
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    pipeline.begin(METADATA);
    const listener = vi.fn();
    const measurement = vi.fn();
    pipeline.subscribe(listener);
    pipeline.subscribeMeasurements(measurement);
    worker.emit({
      type: "spectrum",
      sessionGeneration: 7,
      sequence: 0,
      timestampMs: 1,
      centerFrequencyHz: 100_000_000,
      sampleRateHz: 1_024_000,
      sampleIndex: 16_384,
      bins: new Float32Array(4096).buffer,
      droppedFramesBefore: 0,
      skippedSpectrumFramesBefore: 0,
      missingSamplesBefore: 123,
    });
    expect(measurement).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(
      worker.sent.filter((message) => message.type === "spectrum-credit"),
    ).toHaveLength(1);
    worker.emit({
      type: "spectrum",
      sessionGeneration: 7,
      sequence: 1,
      timestampMs: 2,
      centerFrequencyHz: 100_000_000,
      sampleRateHz: 1_024_000,
      sampleIndex: 32_768,
      bins: new Float32Array(4096).buffer,
      droppedFramesBefore: 0,
      skippedSpectrumFramesBefore: 0,
    });
    expect(measurement).toHaveBeenCalledTimes(2);
    expect(
      worker.sent.filter((message) => message.type === "spectrum-credit"),
    ).toHaveLength(2);
    animationCallback?.(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      sequence: 1,
      missingSamplesBefore: 123,
    });
    expect(measurement.mock.calls[1]?.[0]).toMatchObject({
      missingSamplesBefore: 0,
    });
  });

  it("rejects stale worker frames after a retune generation", () => {
    const worker = new FakeWorker();
    let animationCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    pipeline.begin(METADATA);
    const listener = vi.fn();
    pipeline.subscribe(listener);
    pipeline.retune({
      ...METADATA,
      sessionGeneration: 8,
      hardwareCenterFrequencyHz: 101_000_000,
    });
    worker.emit({
      type: "spectrum",
      sessionGeneration: 7,
      sequence: 4,
      timestampMs: 2,
      sampleIndex: 16_384,
      centerFrequencyHz: 100_000_000,
      sampleRateHz: 1_024_000,
      bins: new Float32Array(4096).buffer,
      droppedFramesBefore: 0,
      skippedSpectrumFramesBefore: 0,
    });
    animationCallback?.(3);
    expect(listener).not.toHaveBeenCalled();
    worker.emit({
      type: "spectrum",
      sessionGeneration: 8,
      sequence: 0,
      timestampMs: 3,
      sampleIndex: 16_384,
      centerFrequencyHz: 101_000_000,
      sampleRateHz: 1_024_000,
      bins: new Float32Array(4096).buffer,
      droppedFramesBefore: 0,
      skippedSpectrumFramesBefore: 0,
    });
    animationCallback?.(4);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

it.each([
  { rate: 9_600_000, slots: 16 },
  { rate: 19_200_000, slots: 16 },
])(
  "bounds $rate analysis bursts to $slots credits and rejects stale acknowledgements",
  ({ rate, slots }) => {
    const worker = new FakeWorker(),
      pipeline = new AnalysisPipeline(worker as unknown as Worker);
    const metadata = {
      ...METADATA,
      actualSampleRateHz: rate,
      requestedSampleRateHz: rate,
    };
    const receiver = pipeline.begin(metadata);
    const block = {
      I: new Float32Array(32768),
      Q: new Float32Array(32768),
      frequency: 100e6,
    };
    for (let n = 0; n < slots + 1; n++) receiver.receiveSamples(block);
    const messages = worker.sent.filter(
      (message) => message.type === "samples",
    );
    expect(messages).toHaveLength(slots);
    expect(pipeline.getDiagnostics().skippedInputBlocks).toBe(1);
    const first = messages[0]!;
    worker.emit({
      type: "samples-ack",
      sessionGeneration: 7,
      processingTimeMs: 1,
      backend: "JavaScript reference",
      backendStartupMs: 0,
      I: first.I,
      Q: first.Q,
    });
    receiver.receiveSamples(block);
    expect(
      worker.sent.filter((message) => message.type === "samples"),
    ).toHaveLength(slots + 1);
    pipeline.retune({ ...metadata, sessionGeneration: 8 });
    for (let n = 0; n < slots; n++) receiver.receiveSamples(block);
    worker.emit({
      type: "samples-ack",
      sessionGeneration: 7,
      processingTimeMs: 1,
      backend: "JavaScript reference",
      backendStartupMs: 0,
      I: first.I,
      Q: first.Q,
    });
    receiver.receiveSamples(block);
    expect(pipeline.getDiagnostics().skippedInputBlocks).toBe(1);
    pipeline.stop();
  },
);

it("keeps native bytes compact with bounded credits, exact gap lengths and stale-ack filtering", () => {
  const worker = new FakeWorker();
  const pipeline = new AnalysisPipeline(worker as unknown as Worker);
  pipeline.begin({ ...METADATA, actualSampleRateHz: 19_200_000 });
  const bytes = Uint8Array.of(128, 255, 0, 127);
  const gpu = vi.fn(),
    planar = vi.fn();
  pipeline.attachGpuTap(planar, gpu);
  for (let n = 0; n < 17; n++) pipeline.receiveCi8(bytes, 100e6, 7);
  const sent = worker.sent.filter((m) => m.type === "samples-ci8");
  expect(sent).toHaveLength(16);
  expect(new Uint8Array(sent[0]!.bytes)).toEqual(bytes);
  bytes.fill(0);
  expect([...new Uint8Array(sent[0]!.bytes)]).toEqual([128, 255, 0, 127]);
  expect(planar).not.toHaveBeenCalled();
  expect(gpu).toHaveBeenCalledTimes(17);
  worker.emit({
    type: "samples-ci8-ack",
    sessionGeneration: 7,
    bytes: sent[0]!.bytes,
    processingTimeMs: 1,
    backend: "JavaScript reference",
    backendStartupMs: 0,
  });
  pipeline.receiveCi8(bytes, 100e6, 7);
  expect(worker.sent.at(-1)).toMatchObject({
    type: "samples-ci8",
    discontinuity: true,
    droppedInputBlocks: 1,
    droppedInputSamples: 2,
  });
  pipeline.retune({
    ...METADATA,
    sessionGeneration: 8,
    actualSampleRateHz: 19_200_000,
  });
  for (let n = 0; n < 16; n++) pipeline.receiveCi8(bytes, 100e6, 8);
  worker.emit({
    type: "samples-ci8-ack",
    sessionGeneration: 7,
    bytes: sent[1]!.bytes,
    processingTimeMs: 1,
    backend: "JavaScript reference",
    backendStartupMs: 0,
  });
  pipeline.receiveCi8(bytes, 100e6, 8);
  expect(pipeline.getDiagnostics().skippedInputBlocks).toBe(1);
  pipeline.stop();
  pipeline.receiveCi8(bytes, 100e6, 8);
});

it("keeps bladeRF SC16 native through the spectrum-worker boundary", () => {
  const worker = new FakeWorker();
  const pipeline = new AnalysisPipeline(worker as unknown as Worker);
  pipeline.begin({
    ...METADATA,
    source: "bladerf",
    actualSampleRateHz: 9_600_000,
  });
  const bytes = Uint8Array.of(0, 4, 0, 252);
  pipeline.receiveSc16(bytes, 100e6, 7);
  const sent = worker.sent.find((message) => message.type === "samples-sc16");
  expect(sent).toBeDefined();
  if (!sent || sent.type !== "samples-sc16")
    throw new Error("Missing SC16 worker message");
  expect([...new Uint8Array(sent.bytes)]).toEqual([0, 4, 0, 252]);
  expect(pipeline.getDiagnostics()).toMatchObject({
    receivedComplexSamples: 1,
    receivedBytes: 4,
  });
  worker.emit({
    type: "samples-sc16-ack",
    sessionGeneration: 7,
    bytes: sent.bytes,
    processingTimeMs: 1,
    backend: "JavaScript reference",
    backendStartupMs: 0,
  });
  expect(pipeline.getDiagnostics().processedBlocks).toBe(1);
});


describe("batched waterfall delivery", () => {
  function setup() {
    const worker = new FakeWorker();
    let animationCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const pipeline = new AnalysisPipeline(worker as unknown as Worker);
    pipeline.begin(METADATA);
    const listener = vi.fn();
    pipeline.subscribe(listener);
    const emit = (sequence: number, missingSamplesBefore = 0) => worker.emit({
      type: "spectrum", sessionGeneration: 7, sequence, timestampMs: sequence * 40,
      centerFrequencyHz: 100_000_000, sampleRateHz: 4_800_000,
      sampleIndex: (sequence + 1) * 192512, hopSamples: 192512,
      bins: new Float32Array(4096).fill(sequence).buffer,
      droppedFramesBefore: 0, skippedSpectrumFramesBefore: 0, missingSamplesBefore,
    });
    return { pipeline, listener, emit, flush: () => animationCallback?.(0) };
  }

  it("keeps every row through a 120 ms rendering delay and publishes once", () => {
    const { pipeline, listener, emit, flush } = setup();
    const history = new WaterfallHistory(240);
    history.reset(7);
    emit(0); flush();
    history.append(listener.mock.calls[0]![1][0]);
    listener.mockClear();
    emit(1); emit(2); emit(3);
    expect(listener).not.toHaveBeenCalled();
    flush();
    expect(listener).toHaveBeenCalledOnce();
    const [latest, frames] = listener.mock.calls[0]!;
    expect(latest.sequence).toBe(3);
    expect(frames.map((frame: { sequence: number }) => frame.sequence)).toEqual([1, 2, 3]);
    expect(frames.flatMap((frame: Parameters<typeof history.append>[0]) => history.append(frame)).map((row: { kind: string }) => row.kind)).toEqual(["spectrum", "spectrum", "spectrum"]);
    expect(pipeline.getDiagnostics()).toMatchObject({ deliveredDisplayFrames: 4, skippedSpectrumFrames: 0 });
  });

  it("bounds the backlog and marks overflow while preserving actual sample loss", () => {
    const { pipeline, listener, emit, flush } = setup();
    const history = new WaterfallHistory(240);
    history.reset(7);
    emit(0); flush();
    history.append(listener.mock.calls[0]![1][0]);
    listener.mockClear();
    for (let sequence = 1; sequence <= ANALYSIS_DISPLAY_QUEUE_CAPACITY + 2; sequence++) emit(sequence, sequence === 1 ? 123 : 0);
    flush();
    const [latest, frames] = listener.mock.calls[0]!;
    expect(frames).toHaveLength(ANALYSIS_DISPLAY_QUEUE_CAPACITY);
    expect(frames[0]).toMatchObject({ sequence: 3, missingSamplesBefore: 123, droppedFramesBefore: 2 });
    expect(latest.sequence).toBe(ANALYSIS_DISPLAY_QUEUE_CAPACITY + 2);
    expect(history.append(frames[0]).map(row => row.kind)).toEqual(["gap", "gap", "spectrum"]);
    expect(pipeline.getDiagnostics().skippedSpectrumFrames).toBe(2);
  });

  it.each(["stop", "retune", "begin"] as const)("clears queued rows on %s", action => {
    const { pipeline, listener, emit, flush } = setup();
    emit(0); emit(1);
    if (action === "stop") pipeline.stop();
    else pipeline[action]({ ...METADATA, sessionGeneration: 8 });
    flush();
    expect(listener).not.toHaveBeenCalled();
  });
});
