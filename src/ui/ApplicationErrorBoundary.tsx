import { Component, type ErrorInfo, type ReactNode } from "react";
import { defaultDiagnosticRecorder, loadAutoReportPreference } from "../diagnostics/diagnosticRecorder";
import { buildDiagnosticReport } from "../diagnostics/reportBuilder";
import type { DiagnosticReport } from "../diagnostics/diagnosticTypes";
import { downloadDiagnosticReport, sendDiagnosticReport } from "../diagnostics/reportTransport";

interface ErrorBoundaryState { crashed: boolean; report?: DiagnosticReport; status: string }

export class ApplicationErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { crashed: false, status: "" };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> { return { crashed: true, status: "BrowserSDR stopped after an unexpected application error." }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    defaultDiagnosticRecorder.record({ area: "application", code: "REACT_RENDER_CRASH", severity: "fatal", operation: "render", error,
      safeMessage: `${error.message}${info.componentStack ? " (React component stack retained locally only)" : ""}`, autoSubmitEligible: true });
    const report = buildDiagnosticReport(defaultDiagnosticRecorder, {
      lifecycle: "crashed", source: null, mode: null, sampleRateHz: null, bandwidthHz: null,
      gainMode: null, firmwareVersion: null, recordingActive: false,
    }, { trigger: loadAutoReportPreference() ? "automatic" : "error", autoSubmitted: loadAutoReportPreference() });
    this.setState({ report });
    if (loadAutoReportPreference()) {
      void sendDiagnosticReport(report).then(({ reference }) => this.setState({ status: `BrowserSDR stopped after an unexpected error. Crash report sent: ${reference}.` }))
        .catch((sendError: unknown) => this.setState({ status: `BrowserSDR stopped after an unexpected error. The report could not be sent: ${sendError instanceof Error ? sendError.message : "unknown error"}` }));
    }
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return <main className="fatal-error-shell" role="alert">
      <p className="eyebrow">Unexpected application error</p>
      <h1>BrowserSDR needs to reload</h1>
      <p>{this.state.status}</p>
      <p>Your radio samples, recordings, audio, decoded content, and USB serial number are not included in the diagnostic report.</p>
      <div className="dialog-actions">
        <button type="button" onClick={() => location.reload()}>Reload BrowserSDR</button>
        <button type="button" className="secondary" disabled={!this.state.report} onClick={() => { if (this.state.report) downloadDiagnosticReport(this.state.report); }}>Download diagnostic JSON</button>
      </div>
    </main>;
  }
}
