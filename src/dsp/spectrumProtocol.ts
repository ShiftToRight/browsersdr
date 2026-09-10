import type { AnalysisBackendName, AnalysisBackendPreference } from "./spectrumBackend";

export interface ConfigureAnalysisMessage {
  type: "configure";
  sessionGeneration: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  backendPreference: AnalysisBackendPreference;
}

export interface AnalysisSamplesMessage {
  type: "samples";
  sessionGeneration: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  discontinuity: boolean;
  droppedInputBlocks: number;
  droppedInputSamples: number;
  I: ArrayBuffer;
  Q: ArrayBuffer;
}

export interface AnalysisStopMessage { type: "stop"; sessionGeneration: number }
export interface SpectrumCreditMessage { type: "spectrum-credit"; sessionGeneration: number }
export type AnalysisWorkerInput = ConfigureAnalysisMessage | AnalysisSamplesMessage | AnalysisStopMessage | SpectrumCreditMessage;

export interface AnalysisAckMessage {
  type: "samples-ack";
  sessionGeneration: number;
  processingTimeMs: number;
  backend: AnalysisBackendName;
  backendStartupMs: number;
  backendFallbackReason?: string;
  I: ArrayBuffer;
  Q: ArrayBuffer;
}

export interface AnalysisFrameMessage {
  type: "spectrum";
  sessionGeneration: number;
  sequence: number;
  timestampMs: number;
  sampleIndex: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  bins: ArrayBuffer;
  droppedFramesBefore: number;
  skippedSpectrumFramesBefore: number;
}

export type AnalysisWorkerOutput = AnalysisAckMessage | AnalysisFrameMessage;
