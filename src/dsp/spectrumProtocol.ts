import type { SourceSessionMetadata } from "../radio/types";
import type { SignalCenterResult } from "./signalCenter";
import type { AnalysisBackendName, AnalysisBackendPreference } from "./spectrumBackend";
import type { SignalProbeConfiguration, SignalProbeResult } from "./signalIntelligence";

export interface ConfigureAnalysisMessage {
  type: "configure";
  sessionGeneration: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  backendPreference: AnalysisBackendPreference;
}

export interface AnalysisSamplesMessage {
  type: "samples";
  /** Source-clock position; used to exclude queued pre-click samples. */
  sampleIndex?: number;
  sessionGeneration: number;
  centerFrequencyHz: number;
  sampleRateHz: number;
  discontinuity: boolean;
  droppedInputBlocks: number;
  droppedInputSamples: number;
  I: ArrayBuffer;
  Q: ArrayBuffer;
}

export type AnalysisCi8Message = Omit<AnalysisSamplesMessage, "type" | "I" | "Q"> & { type: "samples-ci8"; bytes: ArrayBuffer };
export type AnalysisCi8Ack = Omit<AnalysisAckMessage, "type" | "I" | "Q"> & { type: "samples-ci8-ack"; bytes: ArrayBuffer };
export type AnalysisSc16Message = Omit<AnalysisSamplesMessage, "type" | "I" | "Q"> & { type: "samples-sc16"; bytes: ArrayBuffer };
export type AnalysisSc16Ack = Omit<AnalysisAckMessage, "type" | "I" | "Q"> & { type: "samples-sc16-ack"; bytes: ArrayBuffer };
export type AnalysisUsrpSc16Message = Omit<AnalysisSamplesMessage, "type" | "I" | "Q"> & { type: "samples-usrp-sc16"; bytes: ArrayBuffer };
export type AnalysisUsrpSc16Ack = Omit<AnalysisAckMessage, "type" | "I" | "Q"> & { type: "samples-usrp-sc16-ack"; bytes: ArrayBuffer };
export interface AnalysisStopMessage { type: "stop"; sessionGeneration: number }
/** Maximum spectrum rows that may cross the worker boundary before the display drains them. */
export const SPECTRUM_PUBLICATION_WINDOW = 32;
export interface SpectrumCreditMessage { type: "spectrum-credit"; sessionGeneration: number; credits: number }
export interface ProbeStartMessage { type: "probe-start"; sessionGeneration: number; requestId: number; minimumSampleIndex: number; configuration: SignalProbeConfiguration }
export interface ProbeCancelMessage { type: "probe-cancel"; sessionGeneration: number; requestId: number }
export interface ProbeResultMessage { type: "probe-result"; sessionGeneration: number; requestId: number; result?: SignalProbeResult; error?: string }
export interface ProbeProgressMessage { type: "probe-progress"; sessionGeneration: number; requestId: number; sampledSeconds: number }
export type AnalysisWorkerInput = ConfigureAnalysisMessage | AnalysisSamplesMessage | AnalysisCi8Message | AnalysisSc16Message | AnalysisUsrpSc16Message | AnalysisStopMessage | SpectrumCreditMessage | CenterStartMessage | CenterCancelMessage | ProbeStartMessage | ProbeCancelMessage;

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
  missingSamplesBefore?: number;
  /** Expected samples per averaged display row; absent for legacy four-window frames. */
  hopSamples?: number;
}

export type AnalysisWorkerOutput = AnalysisAckMessage | AnalysisCi8Ack | AnalysisSc16Ack | AnalysisUsrpSc16Ack | AnalysisFrameMessage | CenterResultMessage | ProbeResultMessage | ProbeProgressMessage;

export interface CenterStartMessage { type: "center-start"; sessionGeneration: number; requestId: number; minimumSampleIndex: number; metadata: SourceSessionMetadata }
export interface CenterCancelMessage { type: "center-cancel"; sessionGeneration: number; requestId: number }
export interface CenterResultMessage { type: "center-result"; sessionGeneration: number; requestId: number; result: SignalCenterResult }
