import { browserSummary, operatingSystem } from "../platform/browserEnvironment";
import type {
  CompatibilityObservation,
  CompatibilityReport,
  CompatibilityReportContext,
} from "./compatibilityTypes";

export const MAX_COMPATIBILITY_REPORT_BYTES = 32 * 1024;

function randomReportId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `BC-${Array.from(bytes, (value) => value.toString(36).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function buildCompatibilityReport(
  context: CompatibilityReportContext,
  options: {
    observations: CompatibilityObservation[];
    notes?: string;
    includeExactFrequency?: boolean;
    reportId?: string;
  },
): CompatibilityReport {
  const exactFrequencyIncluded =
    options.includeExactFrequency === true &&
    context.exactFrequencyHz !== undefined;
  const receiver = { ...context };
  if (!exactFrequencyIncluded) delete receiver.exactFrequencyHz;
  return {
    schemaVersion: 1,
    reportType: "compatibility",
    reportId: options.reportId ?? randomReportId(),
    createdAt: new Date().toISOString(),
    build: {
      id: import.meta.env.VITE_BUILD_ID || "development",
      builtAt: import.meta.env.VITE_BUILD_TIMESTAMP || "unknown",
    },
    environment: {
      browser: browserSummary(),
      operatingSystem: operatingSystem(),
      language: navigator.language.slice(0, 16),
      secureContext: window.isSecureContext,
      capabilities: {
        webUsb: "usb" in navigator,
        webGpu: "gpu" in navigator,
        webAssembly: typeof WebAssembly === "object",
      },
    },
    receiver,
    observations: options.observations.slice(0, 12),
    ...(options.notes?.trim()
      ? { notes: options.notes.trim().slice(0, 1_000) }
      : {}),
    redaction: {
      omitted: [
        "iqSamples",
        "audio",
        "spectrumBins",
        "waterfall",
        "decodedContent",
        "usbSerial",
        "usbDevice",
        "fileNames",
        "location",
        ...(exactFrequencyIncluded ? [] : ["exactFrequencyHz"]),
      ],
      exactFrequencyIncluded,
    },
  };
}
