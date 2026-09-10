import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { SourceSessionMetadata, SpectrumFrame } from "../radio/types";
import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "./spectrumProtocol";
import { analysisBackendPreference, type AnalysisBackendName, type AnalysisBackendPreference } from "./spectrumBackend";

type FrameListener = (frame: SpectrumFrame) => void;

export interface AnalysisDiagnostics {
  sessionGeneration: number;
  source: SourceSessionMetadata["source"] | null;
  receivedComplexSamples: number;
  /** RTL-SDR's verified U8 I,Q transport is two bytes per complex sample. */
  receivedBytes: number | null;
  processedBlocks: number;
  processingTimeLastMs: number | null;
  processingTimeAverageMs: number | null;
  processingTimeMaximumMs: number | null;
  skippedInputBlocks: number;
  skippedInputSamples: number;
  skippedSpectrumFrames: number;
  deliveredDisplayFrames: number;
  knownApplicationDiscontinuities: number;
  analysisBackend: AnalysisBackendName | null;
  backendStartupMs: number | null;
  backendFallbackReason: string | null;
}

const EMPTY_DIAGNOSTICS: AnalysisDiagnostics = {
  sessionGeneration: 0,
  source: null,
  receivedComplexSamples: 0,
  receivedBytes: null,
  processedBlocks: 0,
  processingTimeLastMs: null,
  processingTimeAverageMs: null,
  processingTimeMaximumMs: null,
  skippedInputBlocks: 0,
  skippedInputSamples: 0,
  skippedSpectrumFrames: 0,
  deliveredDisplayFrames: 0,
  knownApplicationDiscontinuities: 0,
  analysisBackend: null,
  backendStartupMs: null,
  backendFallbackReason: null,
};

/** Owns the analysis worker and the two one-slot queues around it. */
export class AnalysisPipeline {
  private readonly worker: Worker;
  private readonly listeners = new Set<FrameListener>();
  private generation = 0;
  private sampleRateHz = 0;
  private centerFrequencyHz = 0;
  private inputBusy = false;
  private droppedInputBlocks = 0;
  private droppedInputSamples = 0;
  private returnedBuffers?: [ArrayBuffer, ArrayBuffer];
  private pendingFrame?: SpectrumFrame;
  private animationFrame?: number;
  private diagnostics: AnalysisDiagnostics = { ...EMPTY_DIAGNOSTICS };
  private totalProcessingTimeMs = 0;
  private sourceToken?: symbol;

  constructor(
    worker = new Worker(new URL("../workers/spectrum.worker.ts", import.meta.url), { type: "module" }),
    private readonly backendPreference: AnalysisBackendPreference = analysisBackendPreference(),
  ) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<AnalysisWorkerOutput>) => this.onWorkerMessage(event.data);
  }

  begin(metadata: SourceSessionMetadata): SampleReceiver {
    const sourceToken = Symbol("analysis source");
    this.sourceToken = sourceToken;
    this.generation = metadata.sessionGeneration;
    this.sampleRateHz = metadata.actualSampleRateHz;
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.inputBusy = false;
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.pendingFrame = undefined;
    this.resetDiagnostics(metadata);
    this.post({
      type: "configure",
      sessionGeneration: this.generation,
      centerFrequencyHz: this.centerFrequencyHz,
      sampleRateHz: this.sampleRateHz,
      backendPreference: this.backendPreference,
    });
    return {
      setSampleRate: (sampleRate) => { if (this.sourceToken === sourceToken) this.sampleRateHz = sampleRate; },
      receiveSamples: (block) => { if (this.sourceToken === sourceToken) this.receiveSamples(block, this.generation); },
    };
  }

  /** Starts a new display generation while keeping the acquisition tap alive. */
  retune(metadata: SourceSessionMetadata): void {
    this.generation = metadata.sessionGeneration;
    this.sampleRateHz = metadata.actualSampleRateHz;
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.inputBusy = false;
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.returnedBuffers = undefined;
    this.pendingFrame = undefined;
    this.resetDiagnostics(metadata);
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
    this.post({
      type: "configure",
      sessionGeneration: metadata.sessionGeneration,
      centerFrequencyHz: metadata.hardwareCenterFrequencyHz,
      sampleRateHz: metadata.actualSampleRateHz,
      backendPreference: this.backendPreference,
    });
  }

  updateMetadata(metadata: SourceSessionMetadata): void {
    if (metadata.sessionGeneration !== this.generation) return;
    this.sampleRateHz = metadata.actualSampleRateHz;
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
  }

  stop(sessionGeneration = this.generation): void {
    if (sessionGeneration !== this.generation) return;
    this.post({ type: "stop", sessionGeneration });
    this.generation = 0;
    this.sourceToken = undefined;
    this.inputBusy = false;
    this.pendingFrame = undefined;
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
  }

  getDiagnostics(): AnalysisDiagnostics {
    return { ...this.diagnostics };
  }

  /** Preserve the source clock while resetting analysis across a recorded gap. */
  markDiscontinuity(missingSamples = 0): void {
    this.droppedInputBlocks += 1;
    this.droppedInputSamples += missingSamples;
    this.diagnostics.knownApplicationDiscontinuities += 1;
  }

  dispose(): void {
    this.stop();
    this.worker.terminate();
    this.listeners.clear();
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receiveSamples(block: SampleBlock, generation: number): void {
    if (generation !== this.generation) return;
    const length = Math.min(block.I.length, block.Q.length);
    this.diagnostics.receivedComplexSamples += length;
    if (this.diagnostics.receivedBytes !== null) this.diagnostics.receivedBytes += length * 2;
    if (this.inputBusy) {
      this.droppedInputBlocks += 1;
      this.droppedInputSamples += length;
      this.diagnostics.skippedInputBlocks += 1;
      this.diagnostics.skippedInputSamples += length;
      this.diagnostics.knownApplicationDiscontinuities += 1;
      return;
    }
    let I: Float32Array;
    let Q: Float32Array;
    const returned = this.returnedBuffers;
    if (returned && returned[0].byteLength === length * Float32Array.BYTES_PER_ELEMENT && returned[1].byteLength === length * Float32Array.BYTES_PER_ELEMENT) {
      I = new Float32Array(returned[0]);
      Q = new Float32Array(returned[1]);
      this.returnedBuffers = undefined;
    } else {
      I = new Float32Array(length);
      Q = new Float32Array(length);
    }
    I.set(block.I.subarray(0, length));
    Q.set(block.Q.subarray(0, length));
    const droppedInputBlocks = this.droppedInputBlocks;
    const droppedInputSamples = this.droppedInputSamples;
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.inputBusy = true;
    const message: AnalysisWorkerInput = {
      type: "samples",
      sessionGeneration: generation,
      centerFrequencyHz: block.frequency,
      sampleRateHz: this.sampleRateHz,
      discontinuity: droppedInputBlocks > 0,
      droppedInputBlocks,
      droppedInputSamples,
      I: I.buffer as ArrayBuffer,
      Q: Q.buffer as ArrayBuffer,
    };
    this.worker.postMessage(message, [I.buffer, Q.buffer]);
  }

  private onWorkerMessage(message: AnalysisWorkerOutput): void {
    if (message.sessionGeneration !== this.generation) return;
    if (message.type === "samples-ack") {
      this.returnedBuffers = [message.I, message.Q];
      this.inputBusy = false;
      this.diagnostics.processedBlocks += 1;
      this.totalProcessingTimeMs += message.processingTimeMs;
      this.diagnostics.processingTimeLastMs = message.processingTimeMs;
      this.diagnostics.processingTimeAverageMs = this.totalProcessingTimeMs / this.diagnostics.processedBlocks;
      this.diagnostics.processingTimeMaximumMs = Math.max(this.diagnostics.processingTimeMaximumMs ?? 0, message.processingTimeMs);
      this.diagnostics.analysisBackend = message.backend;
      this.diagnostics.backendStartupMs = message.backendStartupMs;
      this.diagnostics.backendFallbackReason = message.backendFallbackReason ?? null;
      return;
    }
    this.diagnostics.skippedSpectrumFrames += message.skippedSpectrumFramesBefore;
    this.pendingFrame = {
      sessionGeneration: message.sessionGeneration,
      sequence: message.sequence,
      timestampMs: message.timestampMs,
      sampleIndex: message.sampleIndex,
      centerFrequencyHz: message.centerFrequencyHz,
      sampleRateHz: message.sampleRateHz,
      units: "relative-dB",
      bins: new Float32Array(message.bins),
      droppedFramesBefore: message.droppedFramesBefore,
    };
    if (this.animationFrame === undefined) {
      this.animationFrame = requestAnimationFrame(() => this.publishPendingFrame());
    }
  }

  private publishPendingFrame(): void {
    this.animationFrame = undefined;
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    if (!frame || frame.sessionGeneration !== this.generation) return;
    this.diagnostics.deliveredDisplayFrames += 1;
    for (const listener of this.listeners) listener(frame);
    this.post({ type: "spectrum-credit", sessionGeneration: this.generation });
  }

  private post(message: AnalysisWorkerInput): void { this.worker.postMessage(message); }

  private resetDiagnostics(metadata: SourceSessionMetadata): void {
    this.totalProcessingTimeMs = 0;
    this.diagnostics = {
      ...EMPTY_DIAGNOSTICS,
      sessionGeneration: metadata.sessionGeneration,
      source: metadata.source,
      receivedBytes: metadata.source === "rtl-sdr" || metadata.source === "replay" ? 0 : null,
    };
  }
}
