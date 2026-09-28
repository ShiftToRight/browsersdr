import type { IngressTimings } from "../radio/ingressTimings";
import { decodeCi8Into } from "../radio/ci8Samples";
import { decodeSc16Q11Into } from "../radio/sc16Samples";
import { decodeUsrpB205Sc16Into } from "../radio/usrpB205RxVrt";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { SourceSessionMetadata, SpectrumFrame } from "../radio/types";
import type {
  AnalysisWorkerInput,
  AnalysisWorkerOutput,
} from "./spectrumProtocol";
import {
  analysisBackendPreference,
  type AnalysisBackendName,
  type AnalysisBackendPreference,
} from "./spectrumBackend";

import type { GpuInputBlock, GpuCi8InputBlock } from "./gpuAnalysisTap";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";

type FrameListener = (frame: SpectrumFrame) => void;
type DisplayListener = (latest: SpectrumFrame, frames: readonly SpectrumFrame[]) => void;

export interface AnalysisDiagnostics {
  sessionGeneration: number;
  source: SourceSessionMetadata["source"] | null;
  receivedComplexSamples: number;
  /** Bytes represented by retained 8-bit I/Q samples, excluding transport settling/discards. */
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

/** Bounded credits absorb worker/main-thread jitter. The B205 9.6 MS/s path
 * measured a 292.3 ms excursion, so it uses 96 coalesced slots (~327 ms).
 * Existing 4.8 and 19.2 tiers retain their prior 32/128-slot bounds. */
// Retain short rendering stalls without accumulating an unbounded background backlog.
export const ANALYSIS_DISPLAY_QUEUE_CAPACITY = 32;
export const ANALYSIS_INPUT_SLOTS = 4;
export const ANALYSIS_WIDEBAND_INPUT_SLOTS = 32;
export const analysisInputSlots = (sampleRateHz: number): number =>
  sampleRateHz >= 19_200_000
    ? ANALYSIS_WIDEBAND_INPUT_SLOTS * 4
    : sampleRateHz >= 9_600_000
      ? ANALYSIS_WIDEBAND_INPUT_SLOTS * 3
      : sampleRateHz >= 4_800_000
        ? ANALYSIS_WIDEBAND_INPUT_SLOTS
    : ANALYSIS_INPUT_SLOTS;
export const ANALYSIS_MAX_BLOCK_SAMPLES = 262_144;
export class AnalysisPipeline {
  private readonly worker: Worker;
  private readonly listeners = new Set<DisplayListener>();
  private readonly measurementListeners = new Set<FrameListener>();
  private generation = 0;
  private sampleRateHz = 0;
  private centerFrequencyHz = 0;
  private inputsInFlight = 0;
  private get inputSlots(): number {
    return analysisInputSlots(this.sampleRateHz);
  }
  private droppedInputBlocks = 0;
  private droppedInputSamples = 0;
  private returnedBuffers: [ArrayBuffer, ArrayBuffer][] = [];
  private returnedCi8: ArrayBuffer[] = [];
  private returnedSc16: ArrayBuffer[] = [];
  private returnedUsrpSc16: ArrayBuffer[] = [];
  private gpuCi8Tap?: (block: GpuCi8InputBlock) => void;
  private gpuCompatibility?: [Float32Array, Float32Array];
  private pendingFrames: SpectrumFrame[] = [];
  private animationFrame?: number;
  private diagnostics: AnalysisDiagnostics = { ...EMPTY_DIAGNOSTICS };
  private totalProcessingTimeMs = 0;
  private sourceToken?: symbol;
  private gpuTap?: (block: GpuInputBlock) => void;
  private gpuMissingSamples = 0;
  private gpuSourceSamples = 0;
  private gpuDiscontinuity = false;

  attachGpuTap(
    tap: (block: GpuInputBlock) => void,
    ci8Tap?: (block: GpuCi8InputBlock) => void,
  ): () => void {
    this.gpuTap = tap;
    this.gpuCi8Tap = ci8Tap;
    return () => {
      if (this.gpuTap === tap) {
        this.gpuTap = undefined;
        this.gpuCi8Tap = undefined;
        this.gpuCompatibility = undefined;
      }
    };
  }

  constructor(
    worker = new Worker(
      new URL("../workers/spectrum.worker.ts", import.meta.url),
      { type: "module" },
    ),
    private readonly backendPreference: AnalysisBackendPreference = analysisBackendPreference(),
  ) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<AnalysisWorkerOutput>) =>
      this.onWorkerMessage(event.data);
    this.worker.onerror = (event) => {
      defaultDiagnosticRecorder.record({
        area: "analysis",
        code: "SPECTRUM_WORKER_CRASH",
        severity: "fatal",
        operation: "worker",
        error: event.error ?? event.message,
        autoSubmitEligible: true,
      });
    };
    this.worker.onmessageerror = (event) => {
      defaultDiagnosticRecorder.record({
        area: "analysis",
        code: "SPECTRUM_WORKER_MESSAGE_ERROR",
        severity: "error",
        operation: "worker-message",
        error: event.data,
        autoSubmitEligible: true,
      });
    };
  }

  begin(metadata: SourceSessionMetadata): SampleReceiver {
    const sourceToken = Symbol("analysis source");
    this.sourceToken = sourceToken;
    this.generation = metadata.sessionGeneration;
    this.sampleRateHz = metadata.actualSampleRateHz;
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.inputsInFlight = 0;
    this.returnedBuffers = [];
    this.returnedCi8 = [];
    this.returnedSc16 = [];
    this.returnedUsrpSc16 = [];
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.pendingFrames = [];
    this.resetDiagnostics(metadata);
    this.post({
      type: "configure",
      sessionGeneration: this.generation,
      centerFrequencyHz: this.centerFrequencyHz,
      sampleRateHz: this.sampleRateHz,
      backendPreference: this.backendPreference,
    });
    return {
      setSampleRate: (sampleRate) => {
        if (this.sourceToken === sourceToken) this.sampleRateHz = sampleRate;
      },
      receiveSamples: (block) => {
        if (this.sourceToken === sourceToken)
          this.receiveSamples(block, this.generation);
      },
    };
  }

  /** Starts a new display generation while keeping the acquisition tap alive. */
  retune(metadata: SourceSessionMetadata): void {
    this.generation = metadata.sessionGeneration;
    this.sampleRateHz = metadata.actualSampleRateHz;
    this.centerFrequencyHz = metadata.hardwareCenterFrequencyHz;
    this.inputsInFlight = 0;
    this.returnedBuffers = [];
    this.returnedCi8 = [];
    this.returnedSc16 = [];
    this.returnedUsrpSc16 = [];
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.pendingFrames = [];
    this.resetDiagnostics(metadata);
    if (this.animationFrame !== undefined)
      cancelAnimationFrame(this.animationFrame);
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
    this.inputsInFlight = 0;
    this.returnedBuffers = [];
    this.returnedCi8 = [];
    this.returnedSc16 = [];
    this.returnedUsrpSc16 = [];
    this.pendingFrames = [];
    if (this.animationFrame !== undefined)
      cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
  }

  getDiagnostics(): AnalysisDiagnostics {
    return { ...this.diagnostics };
  }

  /** Preserve the source clock while resetting analysis across a recorded gap. */
  markDiscontinuity(missingSamples = 0): void {
    this.gpuDiscontinuity = true;
    this.gpuMissingSamples += missingSamples;
    this.gpuSourceSamples += missingSamples;
    this.droppedInputBlocks += 1;
    this.droppedInputSamples += missingSamples;
    this.diagnostics.knownApplicationDiscontinuities += 1;
  }

  dispose(): void {
    this.stop();
    this.gpuTap = undefined;
    this.gpuCi8Tap = undefined;
    this.gpuCompatibility = undefined;
    this.worker.terminate();
    this.listeners.clear();
    this.measurementListeners.clear();
  }

  subscribe(listener: DisplayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Receives every published worker measurement without waiting for display rendering. */
  subscribeMeasurements(listener: FrameListener): () => void {
    this.measurementListeners.add(listener);
    return () => this.measurementListeners.delete(listener);
  }

  /** Native HackRF path: copy compact bytes before the transport reuses them. */
  receiveCi8(
    bytes: Uint8Array,
    frequency: number,
    generation: number,
    timings?: IngressTimings,
  ): void {
    if (generation !== this.generation || !this.sourceToken) return;
    const length = bytes.byteLength / 2;
    if (!Number.isInteger(length) || length < 1 || length > 32768)
      throw new Error("Invalid native analysis block.");
    const tapStart = performance.now();
    const context = {
      sampleIndex: this.gpuSourceSamples,
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      discontinuity: this.gpuDiscontinuity,
      missingSamples: this.gpuMissingSamples,
    };
    if (this.gpuCi8Tap) this.gpuCi8Tap({ ...context, bytes });
    else if (this.gpuTap) {
      this.gpuCompatibility ??= [
        new Float32Array(32768),
        new Float32Array(32768),
      ];
      const [I, Q] = this.gpuCompatibility;
      decodeCi8Into(bytes, I, Q);
      this.gpuTap({
        ...context,
        I: I.subarray(0, length),
        Q: Q.subarray(0, length),
      });
    }
    timings?.record("GPU tap", performance.now() - tapStart);
    this.gpuSourceSamples += length;
    this.gpuDiscontinuity = false;
    this.gpuMissingSamples = 0;
    this.diagnostics.receivedComplexSamples += length;
    if (this.diagnostics.receivedBytes !== null)
      this.diagnostics.receivedBytes += bytes.byteLength;
    if (this.inputsInFlight >= this.inputSlots) {
      this.droppedInputBlocks++;
      this.droppedInputSamples += length;
      this.diagnostics.skippedInputBlocks++;
      this.diagnostics.skippedInputSamples += length;
      this.diagnostics.knownApplicationDiscontinuities++;
      return;
    }
    const copyStart = performance.now();
    const returned = this.returnedCi8.pop();
    const buffer =
      returned?.byteLength === bytes.byteLength
        ? returned
        : new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    timings?.record("Spectrum copy", performance.now() - copyStart);
    const message: AnalysisWorkerInput = {
      type: "samples-ci8",
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      bytes: buffer,
      discontinuity: this.droppedInputBlocks > 0,
      droppedInputBlocks: this.droppedInputBlocks,
      droppedInputSamples: this.droppedInputSamples,
    };
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.inputsInFlight++;
    const dispatchStart = performance.now();
    this.worker.postMessage(message, [buffer]);
    timings?.record("Spectrum dispatch", performance.now() - dispatchStart);
  }

  /** Native bladeRF path: keep SC16 Q11 normalization off the acquisition thread. */
  receiveSc16(
    bytes: Uint8Array,
    frequency: number,
    generation: number,
    timings?: IngressTimings,
  ): void {
    if (generation !== this.generation || !this.sourceToken) return;
    const length = bytes.byteLength / 4;
    if (!Number.isInteger(length) || length < 1 || length > 32768)
      throw new Error("Invalid native SC16 analysis block.");
    const tapStart = performance.now();
    const context = {
      sampleIndex: this.gpuSourceSamples,
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      discontinuity: this.gpuDiscontinuity,
      missingSamples: this.gpuMissingSamples,
    };
    if (this.gpuTap) {
      this.gpuCompatibility ??= [
        new Float32Array(32768),
        new Float32Array(32768),
      ];
      const [I, Q] = this.gpuCompatibility;
      decodeSc16Q11Into(bytes, I, Q);
      this.gpuTap({
        ...context,
        I: I.subarray(0, length),
        Q: Q.subarray(0, length),
      });
    }
    timings?.record("GPU tap", performance.now() - tapStart);
    this.gpuSourceSamples += length;
    this.gpuDiscontinuity = false;
    this.gpuMissingSamples = 0;
    this.diagnostics.receivedComplexSamples += length;
    if (this.diagnostics.receivedBytes !== null)
      this.diagnostics.receivedBytes += bytes.byteLength;
    if (this.inputsInFlight >= this.inputSlots) {
      this.droppedInputBlocks++;
      this.droppedInputSamples += length;
      this.diagnostics.skippedInputBlocks++;
      this.diagnostics.skippedInputSamples += length;
      this.diagnostics.knownApplicationDiscontinuities++;
      return;
    }
    const copyStart = performance.now();
    const returned = this.returnedSc16.pop();
    const buffer =
      returned?.byteLength === bytes.byteLength
        ? returned
        : new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    timings?.record("Spectrum copy", performance.now() - copyStart);
    const message: AnalysisWorkerInput = {
      type: "samples-sc16",
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      bytes: buffer,
      discontinuity: this.droppedInputBlocks > 0,
      droppedInputBlocks: this.droppedInputBlocks,
      droppedInputSamples: this.droppedInputSamples,
    };
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.inputsInFlight++;
    const dispatchStart = performance.now();
    this.worker.postMessage(message, [buffer]);
    timings?.record("Spectrum dispatch", performance.now() - dispatchStart);
  }

  /** Native USRP path: Q/I little-endian int16 with full-scale normalization. */
  receiveUsrpSc16(
    bytes: Uint8Array,
    frequency: number,
    generation: number,
    timings?: IngressTimings,
  ): void {
    if (generation !== this.generation || !this.sourceToken) return;
    const length = bytes.byteLength / 4;
    if (!Number.isInteger(length) || length < 1 || length > 65536)
      throw new Error("Invalid native USRP SC16 analysis block.");
    const tapStart = performance.now();
    const context = {
      sampleIndex: this.gpuSourceSamples,
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      discontinuity: this.gpuDiscontinuity,
      missingSamples: this.gpuMissingSamples,
    };
    if (this.gpuTap) {
      if (!this.gpuCompatibility || this.gpuCompatibility[0].length < length)
        this.gpuCompatibility = [new Float32Array(length), new Float32Array(length)];
      const [I, Q] = this.gpuCompatibility;
      decodeUsrpB205Sc16Into(bytes, I, Q);
      this.gpuTap({ ...context, I: I.subarray(0, length), Q: Q.subarray(0, length) });
    }
    timings?.record("GPU tap", performance.now() - tapStart);
    this.gpuSourceSamples += length;
    this.gpuDiscontinuity = false;
    this.gpuMissingSamples = 0;
    this.diagnostics.receivedComplexSamples += length;
    if (this.diagnostics.receivedBytes !== null)
      this.diagnostics.receivedBytes += bytes.byteLength;
    if (this.inputsInFlight >= this.inputSlots) {
      this.droppedInputBlocks++;
      this.droppedInputSamples += length;
      this.diagnostics.skippedInputBlocks++;
      this.diagnostics.skippedInputSamples += length;
      this.diagnostics.knownApplicationDiscontinuities++;
      return;
    }
    const copyStart = performance.now();
    const returned = this.returnedUsrpSc16.pop();
    const buffer = returned?.byteLength === bytes.byteLength
      ? returned
      : new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    timings?.record("Spectrum copy", performance.now() - copyStart);
    const message: AnalysisWorkerInput = {
      type: "samples-usrp-sc16",
      sessionGeneration: generation,
      centerFrequencyHz: frequency,
      sampleRateHz: this.sampleRateHz,
      bytes: buffer,
      discontinuity: this.droppedInputBlocks > 0,
      droppedInputBlocks: this.droppedInputBlocks,
      droppedInputSamples: this.droppedInputSamples,
    };
    this.droppedInputBlocks = 0;
    this.droppedInputSamples = 0;
    this.inputsInFlight++;
    const dispatchStart = performance.now();
    this.worker.postMessage(message, [buffer]);
    timings?.record("Spectrum dispatch", performance.now() - dispatchStart);
  }

  private receiveSamples(block: SampleBlock, generation: number): void {
    if (generation !== this.generation) return;
    const length = Math.min(block.I.length, block.Q.length);
    const gpuSampleIndex = this.gpuSourceSamples;
    this.gpuSourceSamples += length;
    this.gpuTap?.({
      sampleIndex: gpuSampleIndex,
      I: block.I,
      Q: block.Q,
      sessionGeneration: generation,
      centerFrequencyHz: block.frequency,
      sampleRateHz: this.sampleRateHz,
      discontinuity: this.gpuDiscontinuity,
      missingSamples: this.gpuMissingSamples,
    });
    this.gpuDiscontinuity = false;
    this.gpuMissingSamples = 0;
    this.diagnostics.receivedComplexSamples += length;
    if (this.diagnostics.receivedBytes !== null)
      this.diagnostics.receivedBytes += length * 2;
    if (
      this.inputsInFlight >= this.inputSlots ||
      length > ANALYSIS_MAX_BLOCK_SAMPLES
    ) {
      this.droppedInputBlocks += 1;
      this.droppedInputSamples += length;
      this.diagnostics.skippedInputBlocks += 1;
      this.diagnostics.skippedInputSamples += length;
      this.diagnostics.knownApplicationDiscontinuities += 1;
      return;
    }
    let I: Float32Array;
    let Q: Float32Array;
    const returned = this.returnedBuffers.pop();
    if (
      returned &&
      returned[0].byteLength === length * Float32Array.BYTES_PER_ELEMENT &&
      returned[1].byteLength === length * Float32Array.BYTES_PER_ELEMENT
    ) {
      I = new Float32Array(returned[0]);
      Q = new Float32Array(returned[1]);
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
    this.inputsInFlight += 1;
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
    if (
      message.type === "samples-ack" ||
      message.type === "samples-ci8-ack" ||
      message.type === "samples-sc16-ack" ||
      message.type === "samples-usrp-sc16-ack"
    ) {
      if (message.type === "samples-ci8-ack") {
        if (this.returnedCi8.length < this.inputSlots)
          this.returnedCi8.push(message.bytes);
      } else if (message.type === "samples-sc16-ack") {
        if (this.returnedSc16.length < this.inputSlots)
          this.returnedSc16.push(message.bytes);
      } else if (message.type === "samples-usrp-sc16-ack") {
        if (this.returnedUsrpSc16.length < this.inputSlots)
          this.returnedUsrpSc16.push(message.bytes);
      } else if (this.returnedBuffers.length < this.inputSlots)
        this.returnedBuffers.push([message.I, message.Q]);
      this.inputsInFlight = Math.max(0, this.inputsInFlight - 1);
      this.diagnostics.processedBlocks += 1;
      this.totalProcessingTimeMs += message.processingTimeMs;
      this.diagnostics.processingTimeLastMs = message.processingTimeMs;
      this.diagnostics.processingTimeAverageMs =
        this.totalProcessingTimeMs / this.diagnostics.processedBlocks;
      this.diagnostics.processingTimeMaximumMs = Math.max(
        this.diagnostics.processingTimeMaximumMs ?? 0,
        message.processingTimeMs,
      );
      this.diagnostics.analysisBackend = message.backend;
      this.diagnostics.backendStartupMs = message.backendStartupMs;
      this.diagnostics.backendFallbackReason =
        message.backendFallbackReason ?? null;
      return;
    }
    this.diagnostics.skippedSpectrumFrames +=
      message.skippedSpectrumFramesBefore;
    const frame: SpectrumFrame = {
      sessionGeneration: message.sessionGeneration,
      sequence: message.sequence,
      timestampMs: message.timestampMs,
      sampleIndex: message.sampleIndex,
      centerFrequencyHz: message.centerFrequencyHz,
      sampleRateHz: message.sampleRateHz,
      units: "relative-dB",
      bins: new Float32Array(message.bins),
      droppedFramesBefore: message.droppedFramesBefore,
      missingSamplesBefore: message.missingSamplesBefore ?? 0,
      ...(message.hopSamples ? { hopSamples: message.hopSamples } : {}),
    };
    this.post({ type: "spectrum-credit", sessionGeneration: this.generation });
    for (const listener of this.measurementListeners) listener(frame);
    this.pendingFrames.push(frame);
    if (this.pendingFrames.length > ANALYSIS_DISPLAY_QUEUE_CAPACITY) {
      const discarded = this.pendingFrames.shift()!;
      const first = this.pendingFrames[0]!;
      this.pendingFrames[0] = {
        ...first,
        missingSamplesBefore: (first.missingSamplesBefore ?? 0) + (discarded.missingSamplesBefore ?? 0),
        droppedFramesBefore: first.droppedFramesBefore + discarded.droppedFramesBefore + 1,
      };
      this.diagnostics.skippedSpectrumFrames += 1;
    }
    if (this.animationFrame === undefined) {
      this.animationFrame = requestAnimationFrame(() =>
        this.publishPendingFrame(),
      );
    }
  }

  private publishPendingFrame(): void {
    this.animationFrame = undefined;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    const latest = frames.at(-1);
    if (!latest || latest.sessionGeneration !== this.generation) return;
    // The trace needs only the latest bins; history needs every retained row.
    const frame = {
      ...latest,
      missingSamplesBefore: frames.reduce((sum, item) => sum + (item.missingSamplesBefore ?? 0), 0),
      droppedFramesBefore: frames.reduce((sum, item) => sum + item.droppedFramesBefore, 0),
    };
    this.diagnostics.deliveredDisplayFrames += frames.length;
    for (const listener of this.listeners) listener(frame, frames);
  }

  private post(message: AnalysisWorkerInput): void {
    this.worker.postMessage(message);
  }

  private resetDiagnostics(metadata: SourceSessionMetadata): void {
    this.totalProcessingTimeMs = 0;
    this.gpuSourceSamples = 0;
    this.gpuMissingSamples = 0;
    this.gpuDiscontinuity = false;
    this.diagnostics = {
      ...EMPTY_DIAGNOSTICS,
      sessionGeneration: metadata.sessionGeneration,
      source: metadata.source,
      receivedBytes:
        metadata.source === "rtl-sdr" ||
        metadata.source === "hackrf" ||
        metadata.source === "bladerf" ||
        metadata.source === "usrp-b205" ||
        metadata.source === "replay"
          ? 0
          : null,
    };
  }
}
