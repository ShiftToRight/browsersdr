import { MAX_COMPATIBILITY_REPORT_BYTES } from "./compatibilityReportBuilder";
import type { CompatibilityReport } from "./compatibilityTypes";
import type { DiagnosticSendResult } from "./diagnosticTypes";

export function compatibilityEndpoint(): string {
  const value = import.meta.env.VITE_COMPATIBILITY_ENDPOINT?.trim();
  return value || "/api/v1/compatibility-reports";
}

export async function sendCompatibilityReport(
  report: CompatibilityReport,
  signal?: AbortSignal,
): Promise<DiagnosticSendResult> {
  const body = JSON.stringify(report);
  if (
    new TextEncoder().encode(body).byteLength > MAX_COMPATIBILITY_REPORT_BYTES
  )
    throw new Error("Compatibility report exceeds the 32 KiB upload limit.");
  const response = await fetch(compatibilityEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    credentials: "omit",
    signal,
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Too many reports were submitted. Please download this report and try again later."
        : `Report service rejected the request (${response.status}).`,
    );
  const result = (await response.json()) as Partial<DiagnosticSendResult>;
  if (!result.reference || typeof result.reference !== "string")
    throw new Error("Report service returned an invalid acknowledgement.");
  return { reference: result.reference.slice(0, 64) };
}

export function downloadCompatibilityReport(report: CompatibilityReport): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${report.reportId.toLowerCase()}-compatibility.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
