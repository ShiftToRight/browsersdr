import { useEffect, useRef, useState } from "react";
import { buildDiagnosticReport } from "../diagnostics/reportBuilder";
import {
  defaultDiagnosticRecorder,
  loadAutoReportPreference,
  saveAutoReportPreference,
  type DiagnosticRecorder,
} from "../diagnostics/diagnosticRecorder";
import type {
  DiagnosticEvent,
  DiagnosticReport,
  DiagnosticReportContext,
} from "../diagnostics/diagnosticTypes";
import {
  downloadDiagnosticReport,
  sendDiagnosticReport,
} from "../diagnostics/reportTransport";

export const OPEN_DIAGNOSTIC_REPORT_EVENT = "browsersdr:open-diagnostic-report";

function eventTitle(event: DiagnosticEvent | undefined): string {
  if (!event) return "No issue has been detected in this page session.";
  return `${event.code.replaceAll("_", " ").toLowerCase()} · ${new Date(event.occurredAt).toLocaleTimeString()}`;
}

export function DiagnosticReportCard({
  context,
  recorder = defaultDiagnosticRecorder,
}: {
  context: DiagnosticReportContext;
  recorder?: DiagnosticRecorder;
}) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const [latest, setLatest] = useState(() => recorder.getLatestEvent());
  const [autoReport, setAutoReport] = useState(() =>
    loadAutoReportPreference(),
  );
  const autoRef = useRef(autoReport);
  autoRef.current = autoReport;
  const [report, setReport] = useState<DiagnosticReport>();
  const [description, setDescription] = useState("");
  const [includeFrequency, setIncludeFrequency] = useState(false);
  const [status, setStatus] = useState("");
  const [automaticReference, setAutomaticReference] = useState<string>();
  const [sending, setSending] = useState(false);
  const submitted = useRef(new Set<string>());

  const createReport = (
    trigger: DiagnosticReport["trigger"] = "manual",
    autoSubmitted = false,
  ) => {
    setStatus("");
    setReport(
      buildDiagnosticReport(recorder, contextRef.current, {
        trigger,
        autoSubmitted,
        description,
        includeExactFrequency: includeFrequency,
      }),
    );
  };

  useEffect(() => {
    const open = () => createReport("error");
    window.addEventListener(OPEN_DIAGNOSTIC_REPORT_EVENT, open);
    return () => window.removeEventListener(OPEN_DIAGNOSTIC_REPORT_EVENT, open);
  });

  useEffect(
    () =>
      recorder.subscribe((event) => {
        setLatest(event);
        if (
          !autoRef.current ||
          !event.autoSubmitEligible ||
          submitted.current.has(event.id)
        )
          return;
        submitted.current.add(event.id);
        const automatic = buildDiagnosticReport(recorder, contextRef.current, {
          trigger: "automatic",
          autoSubmitted: true,
        });
        void sendDiagnosticReport(automatic)
          .then(({ reference }) => {
            setAutomaticReference(reference);
            setStatus(`Crash report sent automatically: ${reference}.`);
          })
          .catch((error: unknown) => {
            submitted.current.delete(event.id);
            setStatus(
              error instanceof Error
                ? `Automatic report was not sent: ${error.message}`
                : "Automatic report was not sent.",
            );
          });
      }),
    [recorder],
  );

  const updateAutoReport = (enabled: boolean) => {
    saveAutoReportPreference(enabled);
    setAutoReport(enabled);
    autoRef.current = enabled;
    if (!enabled) setAutomaticReference(undefined);
    setStatus(
      enabled
        ? "Automatic crash reporting enabled for this browser."
        : "Automatic crash reporting disabled.",
    );
  };

  const send = async () => {
    const current = buildDiagnosticReport(recorder, contextRef.current, {
      trigger: report?.trigger ?? "manual",
      reportId: report?.reportId,
      description,
      includeExactFrequency: includeFrequency,
    });
    setReport(current);
    setSending(true);
    setStatus("Sending diagnostic report…");
    try {
      const result = await sendDiagnosticReport(current);
      setStatus(`Report sent. Reference: ${result.reference}`);
      setReport(undefined);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not send the report.",
      );
    } finally {
      setSending(false);
    }
  };

  const copy = async () => {
    if (!report) return;
    const current = buildDiagnosticReport(recorder, contextRef.current, {
      trigger: report.trigger,
      reportId: report.reportId,
      description,
      includeExactFrequency: includeFrequency,
    });
    try {
      await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
      setStatus("Diagnostic JSON copied.");
    } catch {
      setStatus(
        "The browser blocked clipboard access. Download the JSON instead.",
      );
    }
  };

  return (
    <>
      <section
        className="diagnostic-report-card"
        aria-labelledby="diagnostic-report-heading"
      >
        <div>
          <p className="eyebrow">Sanitized diagnostics</p>
          <h3 id="diagnostic-report-heading">Help improve BrowserSDR</h3>
          <p>
            A report contains app errors, recent bounded performance counters,
            browser capabilities, and receiver configuration. It never contains
            recordings, decoded messages, USB serial numbers, IP addresses, or
            audio.
          </p>
          <small>Last detected issue: {eventTitle(latest)}</small>
          {status && (
            <p className="diagnostic-report-status" role="status">
              {status}
            </p>
          )}
          {automaticReference && (
            <button
              type="button"
              className="secondary undo-auto-report"
              onClick={() => updateAutoReport(false)}
            >
              Undo automatic sending
            </button>
          )}
        </div>
        <div className="diagnostic-report-actions">
          <button type="button" onClick={() => createReport()}>
            Create diagnostic report
          </button>
          <label className="auto-report-toggle">
            <input
              type="checkbox"
              checked={autoReport}
              onChange={(event) =>
                updateAutoReport(event.currentTarget.checked)
              }
            />{" "}
            Automatically send errors and recent diagnostic logs
          </label>
          <small>
            Automatic sending is off by default and starts only after you enable
            it here.
          </small>
        </div>
      </section>
      {report && (
        <div className="diagnostic-dialog-backdrop" role="presentation">
          <section
            className="diagnostic-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnostic-dialog-heading"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Review before sending</p>
                <h2 id="diagnostic-dialog-heading">
                  Diagnostic report {report.reportId}
                </h2>
              </div>
            </div>
            <p>
              This report includes the fields shown below. It excludes I/Q
              samples, audio, spectrum and waterfall contents, decoded data, USB
              serials, filenames, imported metadata, survey locations, URL query
              values, and exact tuned frequency unless you enable it.
            </p>
            <label>
              What were you doing?{" "}
              <textarea
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                placeholder="Optional context that may help reproduce the problem"
              />
            </label>
            <label className="auto-report-toggle">
              <input
                type="checkbox"
                checked={includeFrequency}
                onChange={(event) =>
                  setIncludeFrequency(event.currentTarget.checked)
                }
              />{" "}
              Include exact tuned frequency
            </label>
            <details>
              <summary>Review sanitized JSON</summary>
              <pre>
                {JSON.stringify(
                  buildDiagnosticReport(recorder, contextRef.current, {
                    trigger: report.trigger,
                    reportId: report.reportId,
                    description,
                    includeExactFrequency: includeFrequency,
                  }),
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
              >
                Send report
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  downloadDiagnosticReport(
                    buildDiagnosticReport(recorder, contextRef.current, {
                      trigger: report.trigger,
                      reportId: report.reportId,
                      description,
                      includeExactFrequency: includeFrequency,
                    }),
                  )
                }
              >
                Download JSON
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void copy()}
              >
                Copy JSON
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setReport(undefined)}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
