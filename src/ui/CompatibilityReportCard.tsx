import { ReportDialog } from "./ReportDialog";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatSampleRate } from "./frequencyFormat";
import { buildCompatibilityReport } from "../diagnostics/compatibilityReportBuilder";
import {
  downloadCompatibilityReport,
  sendCompatibilityReport,
} from "../diagnostics/compatibilityReportTransport";
import type {
  CompatibilityObservation,
  CompatibilityReport,
  CompatibilityReportContext,
  CompatibilityResult,
  CompatibilityService,
} from "../diagnostics/compatibilityTypes";

const SERVICES: Array<{ service: CompatibilityService; label: string }> = [
  { service: "connection", label: "Device connection" },
  { service: "spectrum", label: "Spectrum & waterfall" },
  { service: "tuning", label: "Tuning" },
  { service: "audio", label: "Audio demodulation" },
  { service: "rds", label: "RDS" },
  { service: "dab", label: "DAB / DAB+" },
  { service: "digital-decode", label: "ADS-B, AIS or SRD decode" },
  { service: "recording-export", label: "Recording & export" },
  { service: "replay", label: "Recording replay" },
];

type Selection = CompatibilityResult | "not-tested";

function initialResults(): Record<CompatibilityService, Selection> {
  return Object.fromEntries(
    SERVICES.map(({ service }) => [service, "not-tested"]),
  ) as Record<CompatibilityService, Selection>;
}

export function CompatibilityReportCard({
  context,
}: {
  context: CompatibilityReportContext;
}) {
  const [report, setReport] = useState<CompatibilityReport>();
  const [results, setResults] = useState(initialResults);
  const [notes, setNotes] = useState("");
  const [includeFrequency, setIncludeFrequency] = useState(false);
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const observations = useMemo(
    () =>
      SERVICES.flatMap(({ service }) => {
        const result = results[service];
        return result === "not-tested" ? [] : [{ service, result }];
      }) as CompatibilityObservation[],
    [results],
  );

  const currentReport = (reportId?: string) =>
    buildCompatibilityReport(context, {
      observations,
      notes,
      includeExactFrequency: includeFrequency,
      reportId,
    });

  const openReport = () => {
    setStatus("");
    setResults(initialResults());
    setNotes("");
    setIncludeFrequency(false);
    setReport(
      buildCompatibilityReport(context, {
        observations: [],
        includeExactFrequency: false,
      }),
    );
  };

  const send = async () => {
    if (!report || observations.length === 0) return;
    const current = currentReport(report.reportId);
    setReport(current);
    setSending(true);
    setStatus("Sending compatibility report…");
    try {
      const result = await sendCompatibilityReport(current);
      setStatus(`Compatibility report sent. Reference: ${result.reference}`);
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
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(currentReport(report.reportId), null, 2),
      );
      setStatus("Compatibility JSON copied.");
    } catch {
      setStatus(
        "The browser blocked clipboard access. Download the JSON instead.",
      );
    }
  };

  return (
    <>
      <section
        className="diagnostic-report-card compatibility-report-card"
        aria-labelledby="compatibility-report-heading"
      >
        <div>
          <p className="eyebrow">Community evidence</p>
          <h3 id="compatibility-report-heading">Share a compatibility test</h3>
          <p>
            Report which services worked with the current receiver setup. The
            device profile, browser, mode, sample rate and gain state are filled
            in automatically so the matrix can be updated from specific
            evidence.
          </p>
          <dl className="compatibility-report-snapshot">
            <div>
              <dt>Source</dt>
              <dd>{context.deviceProfile}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{context.mode}</dd>
            </div>
            <div>
              <dt>Sample rate</dt>
              <dd>{formatSampleRate(context.sampleRateHz)}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{context.lifecycle.replaceAll("-", " ")}</dd>
            </div>
          </dl>
          {status && (
            <p className="diagnostic-report-status" role="status">
              {status}
            </p>
          )}
        </div>
        <div className="diagnostic-report-actions">
          <button type="button" onClick={openReport}>
            Share test result
          </button>
          <small>
            Nothing is sent until you review the report and press Send. USB
            serials, received data, decoded content and location are excluded.
          </small>
        </div>
      </section>
      {report &&
        createPortal(
          <ReportDialog className="compatibility-report-dialog" labelledBy="compatibility-report-dialog-heading" onDismiss={() => setReport(undefined)}>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Review before sending</p>
                  <h2 id="compatibility-report-dialog-heading">
                    Compatibility report {report.reportId}
                  </h2>
                </div>
              </div>
              <p>
                Mark only services you actually tested. “Degraded” means the
                service worked but was unstable, incomplete or noticeably
                impaired.
              </p>
              <div className="compatibility-observations">
                {SERVICES.map(({ service, label }) => (
                  <label key={service}>
                    <span>{label}</span>
                    <select
                      aria-label={`${label} result`}
                      value={results[service]}
                      onChange={(event) =>
                        setResults({
                          ...results,
                          [service]: event.currentTarget.value as Selection,
                        })
                      }
                    >
                      <option value="not-tested">Not tested</option>
                      <option value="working">Works</option>
                      <option value="degraded">Degraded</option>
                      <option value="not-working">Doesn’t work</option>
                    </select>
                  </label>
                ))}
              </div>
              <label>
                Test notes
                <textarea
                  maxLength={1000}
                  value={notes}
                  onChange={(event) => setNotes(event.currentTarget.value)}
                  placeholder="Optional: signal, antenna, duration, symptoms, or steps used"
                />
              </label>
              <label className="auto-report-toggle">
                <input
                  type="checkbox"
                  checked={includeFrequency}
                  onChange={(event) =>
                    setIncludeFrequency(event.currentTarget.checked)
                  }
                />
                Include exact tuned frequency
              </label>
              {observations.length === 0 && (
                <p className="compatibility-report-prompt" role="status">
                  Choose a result for at least one tested service.
                </p>
              )}
              <details>
                <summary>Review sanitized JSON</summary>
                <pre>
                  {JSON.stringify(currentReport(report.reportId), null, 2)}
                </pre>
              </details>
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || observations.length === 0}
                >
                  Send report
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadCompatibilityReport(currentReport(report.reportId))
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
            </ReportDialog>,
          document.body,
        )}
    </>
  );
}
