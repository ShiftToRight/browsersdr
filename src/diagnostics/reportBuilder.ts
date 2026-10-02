import { browserSummary, operatingSystem } from "../platform/browserEnvironment";
import type {
  DiagnosticReport,
  DiagnosticReportContext,
} from "./diagnosticTypes";
import type { DiagnosticRecorder } from "./diagnosticRecorder";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const MAX_REPORT_BYTES = 128 * 1024;

function randomReportId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `BR-${Array.from(bytes, (value) => value.toString(36).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function buildDiagnosticReport(
  recorder: DiagnosticRecorder,
  context: DiagnosticReportContext,
  options: {
    trigger: DiagnosticReport["trigger"];
    autoSubmitted?: boolean;
    description?: string;
    includeExactFrequency?: boolean;
    reportId?: string;
  },
): DiagnosticReport {
  const exactFrequencyIncluded =
    options.includeExactFrequency === true &&
    context.exactFrequencyHz !== undefined;
  const sanitizedContext = { ...context };
  if (!exactFrequencyIncluded) delete sanitizedContext.exactFrequencyHz;
  const report: DiagnosticReport = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    reportId: options.reportId ?? randomReportId(),
    createdAt: new Date().toISOString(),
    trigger: options.trigger,
    autoSubmitted: options.autoSubmitted === true,
    build: {
      id: import.meta.env.VITE_BUILD_ID || "development",
      builtAt: import.meta.env.VITE_BUILD_TIMESTAMP || "unknown",
    },
    environment: {
      browser: browserSummary(),
      operatingSystem: operatingSystem(),
      language: navigator.language.slice(0, 16),
      secureContext: window.isSecureContext,
      visibility: document.visibilityState,
      capabilities: {
        webUsb: "usb" in navigator,
        webGpu: "gpu" in navigator,
        webAssembly: typeof WebAssembly === "object",
      },
    },
    receiver: sanitizedContext,
    ...(options.description?.trim()
      ? { description: options.description.trim().slice(0, 1_000) }
      : {}),
    events: recorder
      .getEvents()
      .map((event) => ({
        ...event,
        context: event.context
          ? Object.fromEntries(
              Object.entries(event.context).filter(
                ([key]) => key !== "fingerprint",
              ),
            )
          : undefined,
      })),
    snapshots: recorder.getSnapshots(),
    redaction: {
      omitted: [
        "iqSamples",
        "audio",
        "spectrumBins",
        "waterfall",
        "decodedContent",
        "usbSerial",
        "usbDevice",
        "ipAddress",
        "forwardedFor",
        "fileNames",
        "importedMetadata",
        "surveySite",
        "urlQuery",
        ...(exactFrequencyIncluded ? [] : ["exactFrequencyHz"]),
      ],
      exactFrequencyIncluded,
    },
  };
  const size = () =>
    new TextEncoder().encode(JSON.stringify(report)).byteLength;
  while (size() > MAX_REPORT_BYTES && report.snapshots.length)
    report.snapshots.shift();
  while (size() > MAX_REPORT_BYTES && report.events.length > 1)
    report.events.shift();
  if (size() > MAX_REPORT_BYTES)
    report.events = report.events.map((event) => ({
      ...event,
      safeStack: event.safeStack?.slice(0, 2),
      safeMessage: event.safeMessage?.slice(0, 160),
      context: undefined,
    }));
  if (size() > MAX_REPORT_BYTES) delete report.description;
  return report;
}
