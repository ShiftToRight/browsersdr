export type CompatibilityService =
  | "connection"
  | "spectrum"
  | "tuning"
  | "audio"
  | "rds"
  | "dab"
  | "digital-decode"
  | "recording-export"
  | "replay";

export type CompatibilityResult = "working" | "degraded" | "not-working";

export interface CompatibilityObservation {
  service: CompatibilityService;
  result: CompatibilityResult;
}

export interface CompatibilityReportContext {
  lifecycle: string;
  source: string;
  deviceProfile: string;
  mode: string;
  sampleRateHz: number;
  nativeSampleRateHz: number | null;
  bandwidthHz: number;
  squelch: number;
  gainMode: string;
  gainDb: number | null;
  lnaGainCode: number | null;
  vgaGainDb: number | null;
  rfAmplifierEnabled: boolean | null;
  antennaPowerEnabled: boolean | null;
  firmwareVersion: string | null;
  usbApiVersion: number | null;
  protocolProfile: string | null;
  recordingActive: boolean;
  audioState: string | null;
  exactFrequencyHz?: number;
}

export interface CompatibilityReport {
  schemaVersion: 1;
  reportType: "compatibility";
  reportId: string;
  createdAt: string;
  build: { id: string; builtAt: string };
  environment: {
    browser: string;
    operatingSystem: string;
    language: string;
    secureContext: boolean;
    capabilities: { webUsb: boolean; webGpu: boolean; webAssembly: boolean };
  };
  receiver: CompatibilityReportContext;
  observations: CompatibilityObservation[];
  notes?: string;
  redaction: { omitted: string[]; exactFrequencyIncluded: boolean };
}
