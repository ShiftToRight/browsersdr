import type {
  CommunityFeatureId,
  CommunityHardwareId,
} from "./communityCatalog";
import type { CompatibilityResult } from "./compatibilityTypes";

export interface CommunityBuild {
  id: string;
  version: string;
  builtAt: string;
}
export interface CommunitySetup {
  source: string;
  hardwareId: CommunityHardwareId;
  mode: string;
  srdProtocol: "none" | "acurite-592txr" | "fineoffset-wh51" | null;
  rateHz: number;
  nativeRateHz: number | null;
  protocolProfile: string | null;
  firmwareVersion: string | null;
  origin: "live" | "replay" | "synthetic";
}
export interface CommunityEnvironment {
  browser: string;
  operatingSystem: string;
  renderer: "webgpu" | "canvas2d" | "unknown";
}
export interface CommunityObservation {
  feature: CommunityFeatureId;
  result: CompatibilityResult;
}
export interface CommunityReport {
  schemaVersion: 2;
  reportType: "compatibility";
  reportId: string;
  createdAt: string;
  build: CommunityBuild;
  participantToken: string;
  setup: CommunitySetup;
  environment: CommunityEnvironment;
  durationMinutes: number;
  testScope: "smoke" | "sustained";
  observations: CommunityObservation[];
  notes?: string;
  /** Private troubleshooting context; never part of the public matrix or vote key. */
  receiverDetails?: Pick<
    import("./compatibilityTypes").CompatibilityReportContext,
    | "lifecycle"
    | "bandwidthHz"
    | "squelch"
    | "gainMode"
    | "gainDb"
    | "lnaGainCode"
    | "vgaGainDb"
    | "rfAmplifierEnabled"
    | "antennaPowerEnabled"
    | "usbApiVersion"
    | "recordingActive"
    | "audioState"
  >;
  browserCapabilities?: {
    secureContext: boolean;
    webUsb: boolean;
    webGpu: boolean;
    webAssembly: boolean;
  };
}
export interface CommunityPublicReport {
  result: CompatibilityResult;
  durationMinutes: number;
  receivedAt: string;
  environment: CommunityEnvironment;
  setup: CommunitySetup;
  review: "pending" | "accepted";
}
export interface CommunityCell {
  key: string;
  hardwareId: CommunityHardwareId;
  feature: CommunityFeatureId;
  setup: CommunitySetup;
  testScope: "smoke" | "sustained";
  platform: string | null;
  working: number;
  eligibleWorking: number;
  problems: number;
  status: "untested" | "working" | "confirmed" | "issue";
  lastAt: string;
  reports: CommunityPublicReport[];
}
export interface CommunityEngineCheck {
  feature: CommunityFeatureId;
  result: "passed" | "failed";
  checkedAt: string;
  evidence: string;
}
export interface CommunityMatrix {
  schemaVersion: 1;
  generatedAt: string;
  builds: CommunityBuild[];
  buildId: string | null;
  cells: CommunityCell[];
  engineChecks: CommunityEngineCheck[];
}
