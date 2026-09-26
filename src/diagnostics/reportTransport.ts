import type { DiagnosticReport, DiagnosticSendResult } from "./diagnosticTypes";
import { MAX_REPORT_BYTES } from "./reportBuilder";

export function diagnosticEndpoint(): string {
  const value = import.meta.env.VITE_DIAGNOSTIC_ENDPOINT?.trim();
  return value || "/api/v1/diagnostic-reports";
}

export async function sendDiagnosticReport(report: DiagnosticReport, signal?: AbortSignal): Promise<DiagnosticSendResult> {
  const endpoint = diagnosticEndpoint();
  const body = JSON.stringify(report);
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) throw new Error("Diagnostic report exceeds the 128 KiB upload limit.");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, credentials: "omit", signal });
  if (!response.ok) throw new Error(response.status === 429 ? "Too many reports were submitted. Please download this report and try again later." : `Report service rejected the request (${response.status}).`);
  const result = await response.json() as Partial<DiagnosticSendResult>;
  if (!result.reference || typeof result.reference !== "string") throw new Error("Report service returned an invalid acknowledgement.");
  return { reference: result.reference.slice(0, 64) };
}

export function downloadDiagnosticReport(report: DiagnosticReport): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${report.reportId.toLowerCase()}-diagnostics.json`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
