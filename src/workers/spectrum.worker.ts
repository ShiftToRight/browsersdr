import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "../dsp/spectrumProtocol";
import { createAnalysisBackend, type AnalysisBackendSelection } from "../dsp/spectrumBackend";
import { FFT_SIZE } from "../dsp/spectrumMath";
import { SpectrumProcessor, spectrumWindowsPerAverage } from "../dsp/spectrumProcessor";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisWorkerInput>) => void) | null;
  postMessage(message: AnalysisWorkerOutput, transfer: Transferable[]): void;
};
let processorPromise: Promise<{ processor: SpectrumProcessor; selection: AnalysisBackendSelection }> | undefined;
let generation = 0;
let centerFrequencyHz = 0;
let sampleRateHz = 0;
let sequence = 0;

async function handleMessage(message: AnalysisWorkerInput): Promise<void> {
  if (message.type === "configure") {
    const previous = processorPromise;
    if (previous) void previous.then(({ processor }) => processor.dispose());
    generation = message.sessionGeneration;
    centerFrequencyHz = message.centerFrequencyHz;
    sampleRateHz = message.sampleRateHz;
    sequence = 0;
    processorPromise = createAnalysisBackend(message.backendPreference, FFT_SIZE, spectrumWindowsPerAverage(message.sampleRateHz))
      .then((selection) => ({ processor: new SpectrumProcessor(selection.kernel, true), selection }));
    return;
  }
  if (message.sessionGeneration !== generation) return;
  if (message.type === "stop") {
    const stopped = processorPromise;
    processorPromise = undefined;
    if (stopped) void stopped.then(({ processor }) => processor.dispose());
    generation = 0;
    return;
  }
  if (message.type === "spectrum-credit") {
    const current = processorPromise;
    if (current) (await current).processor.grantPublicationCredit();
    return;
  }

  const current = processorPromise;
  if (!current) return;
  const { processor, selection } = await current;
  if (message.sessionGeneration !== generation || current !== processorPromise) return;
  centerFrequencyHz = message.centerFrequencyHz;
  sampleRateHz = message.sampleRateHz;
  const processingStartedMs = performance.now();
  const frames = processor.accept(
    new Float32Array(message.I),
    new Float32Array(message.Q),
    performance.now(),
    message.discontinuity,
    message.droppedInputBlocks,
    message.droppedInputSamples,
  );
  const acknowledgement: AnalysisWorkerOutput = {
    type: "samples-ack",
    sessionGeneration: generation,
    processingTimeMs: performance.now() - processingStartedMs,
    backend: selection.name,
    backendStartupMs: selection.startupMs,
    ...(selection.fallbackReason ? { backendFallbackReason: selection.fallbackReason } : {}),
    I: message.I,
    Q: message.Q,
  };
  workerScope.postMessage(acknowledgement, [message.I, message.Q]);
  for (const frame of frames) {
    const frameMessage: AnalysisWorkerOutput = {
      type: "spectrum",
      sessionGeneration: generation,
      sequence: sequence++,
      timestampMs: performance.timeOrigin + performance.now(),
      sampleIndex: frame.sampleIndex,
      centerFrequencyHz,
      sampleRateHz,
      hopSamples: spectrumWindowsPerAverage(sampleRateHz) * FFT_SIZE,
      bins: frame.bins.buffer as ArrayBuffer,
      droppedFramesBefore: frame.droppedBefore,
      skippedSpectrumFramesBefore: frame.skippedSpectrumFramesBefore,
      missingSamplesBefore: frame.missingSamplesBefore,
    };
    workerScope.postMessage(frameMessage, [frame.bins.buffer]);
  }
}

workerScope.onmessage = (event) => { void handleMessage(event.data); };
