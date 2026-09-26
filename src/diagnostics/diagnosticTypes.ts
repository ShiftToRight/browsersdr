export type DiagnosticArea =
  | "receiver" | "usb" | "analysis" | "channel" | "audio"
  | "graphics" | "decoder" | "recording" | "application";

export type DiagnosticSeverity = "info" | "warning" | "error" | "fatal";

export interface DiagnosticEventInput {
  area: DiagnosticArea;
  code: string;
  severity: DiagnosticSeverity;
  operation?: string;
  error?: unknown;
  safeMessage?: string;
  context?: Record<string, string | number | boolean | null>;
  autoSubmitEligible?: boolean;
}

export interface DiagnosticEvent {
  id: string;
  monotonicMs: number;
  occurredAt: string;
  area: DiagnosticArea;
  code: string;
  severity: DiagnosticSeverity;
  operation?: string;
  errorName?: string;
  safeMessage?: string;
  safeStack?: string[];
  context?: Record<string, string | number | boolean | null>;
  autoSubmitEligible: boolean;
  count: number;
}

export interface DiagnosticSnapshot {
  monotonicMs: number;
  lifecycle: string;
  visibility: DocumentVisibilityState;
  analysis: Record<string, string | number | boolean | null>;
  channel?: Record<string, string | number | boolean | null>;
  ingress?: Record<string, string | number | boolean | null>;
}

export interface DiagnosticReportContext {
  lifecycle: string;
  source: string | null;
  mode: string | null;
  sampleRateHz: number | null;
  bandwidthHz: number | null;
  gainMode: string | null;
  firmwareVersion: string | null;
  recordingActive: boolean;
  exactFrequencyHz?: number;
}

export interface DiagnosticReport {
  schemaVersion: 1;
  reportId: string;
  createdAt: string;
  trigger: "manual" | "error" | "automatic";
  autoSubmitted: boolean;
  build: {
    id: string;
    builtAt: string;
  };
  environment: {
    browser: string;
    operatingSystem: string;
    language: string;
    secureContext: boolean;
    visibility: DocumentVisibilityState;
    capabilities: { webUsb: boolean; webGpu: boolean; webAssembly: boolean };
  };
  receiver: DiagnosticReportContext;
  description?: string;
  events: DiagnosticEvent[];
  snapshots: DiagnosticSnapshot[];
  redaction: {
    omitted: string[];
    exactFrequencyIncluded: boolean;
  };
}

export interface DiagnosticSendResult {
  reference: string;
}
