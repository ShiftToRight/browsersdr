import { SignalCenterEstimator } from "../dsp/signalCenter";
import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import { decodeUsrpB205Sc16Into } from "../radio/usrpB205RxVrt";
import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "../dsp/spectrumProtocol";
import { createAnalysisBackend, type AnalysisBackendSelection } from "../dsp/spectrumBackend";
import { FFT_SIZE } from "../dsp/spectrumMath";
import { SpectrumProcessor, spectrumWindowsPerAverage } from "../dsp/spectrumProcessor";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisWorkerInput>) => void) | null;
  postMessage(message: AnalysisWorkerOutput, transfer: Transferable[]): void;
};
let processorPromise: Promise<{ processor: SpectrumProcessor; selection: AnalysisBackendSelection }> | undefined;
let centerMeasurement: { estimator: SignalCenterEstimator; requestId: number; minimumSampleIndex: number } | undefined;
let generation = 0;
let centerFrequencyHz = 0;
let sampleRateHz = 0;
let sequence = 0;
let ci8Scratch: [Float32Array, Float32Array] | undefined;

async function handleMessage(message: AnalysisWorkerInput): Promise<void> {
  if (message.type === "configure") {
    centerMeasurement = undefined;
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
  if (message.type === "center-start") {
    centerMeasurement = { estimator: new SignalCenterEstimator(message.metadata), requestId: message.requestId, minimumSampleIndex: message.minimumSampleIndex };
    return;
  }
  if (message.type === "center-cancel") {
    if (centerMeasurement?.requestId === message.requestId) centerMeasurement = undefined;
    return;
  }
  if (message.type === "stop") {
    centerMeasurement = undefined;
    const stopped = processorPromise;
    processorPromise = undefined;
    if (stopped) void stopped.then(({ processor }) => processor.dispose());
    generation = 0;
    return;
  }
  if (message.type === "spectrum-credit") {
    const current = processorPromise;
    if (current) (await current).processor.grantPublicationCredit(message.credits);
    return;
  }

  const current = processorPromise;
  if (!current) return;
  const { processor, selection } = await current;
  if (message.sessionGeneration !== generation || current !== processorPromise) return;
  centerFrequencyHz = message.centerFrequencyHz;
  sampleRateHz = message.sampleRateHz;
  const processingStartedMs = performance.now();
  let I: Float32Array, Q: Float32Array;
  if (message.type === "samples-ci8" || message.type === "samples-sc16" || message.type === "samples-usrp-sc16") {
    const bytes = new Uint8Array(message.bytes);
    const sampleCount = bytes.byteLength / (message.type === "samples-ci8" ? 2 : 4);
    if (!ci8Scratch || ci8Scratch[0].length < sampleCount)
      ci8Scratch = [new Float32Array(sampleCount), new Float32Array(sampleCount)];
    const count = message.type === "samples-ci8"
      ? decodeCi8Into(bytes, ...ci8Scratch)
      : message.type === "samples-sc16"
        ? decodeSc16Q11Into(bytes, ...ci8Scratch)
        : decodeUsrpB205Sc16Into(bytes, ...ci8Scratch);
    I = ci8Scratch[0].subarray(0, count); Q = ci8Scratch[1].subarray(0, count);
  } else { I = new Float32Array(message.I); Q = new Float32Array(message.Q); }
  const measurement = centerMeasurement;
  if (measurement) {
    const start = message.sampleIndex;
    const skip = start === undefined ? I.length : Math.max(0, measurement.minimumSampleIndex - start);
    if (skip < I.length) {
      const mismatch = message.centerFrequencyHz !== measurement.estimator.metadata.hardwareCenterFrequencyHz || message.sampleRateHz !== measurement.estimator.metadata.actualSampleRateHz;
      const result = measurement.estimator.accept(I.subarray(skip), Q.subarray(skip), message.discontinuity || mismatch);
      if (result) {
        centerMeasurement = undefined;
        workerScope.postMessage({ type: "center-result", sessionGeneration: generation, requestId: measurement.requestId, result }, []);
      }
    }
  }
  const frames = processor.accept(
    I, Q,
    performance.now(),
    message.discontinuity,
    message.droppedInputBlocks,
    message.droppedInputSamples,
  );
  const acknowledgement: AnalysisWorkerOutput = {
    ...(message.type === "samples-ci8" ? { type: "samples-ci8-ack" as const, bytes: message.bytes }
      : message.type === "samples-sc16" ? { type: "samples-sc16-ack" as const, bytes: message.bytes }
      : message.type === "samples-usrp-sc16" ? { type: "samples-usrp-sc16-ack" as const, bytes: message.bytes }
      : { type: "samples-ack" as const, I: message.I, Q: message.Q }),
    sessionGeneration: generation,
    processingTimeMs: performance.now() - processingStartedMs,
    backend: selection.name,
    backendStartupMs: selection.startupMs,
    ...(selection.fallbackReason ? { backendFallbackReason: selection.fallbackReason } : {}),
  };
  workerScope.postMessage(acknowledgement, message.type === "samples" ? [message.I, message.Q] : [message.bytes]);
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
