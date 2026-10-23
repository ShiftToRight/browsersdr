import { readPreference, storePreference } from "./explorerPreferences";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import {
  analyzeCandidates,
  retainAnalysisEvidence,
  type AnalysisCandidate,
  type SignalAnalysisRecord,
  type SignalAnalysisActivity,
} from "../radio/signalAnalysis";
import "./signalAnalysis.css";

const STORAGE_KEY = "browsersdr.signalAnalysis.v1";
function loadRecords(sessionKey: string): SignalAnalysisRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 1_500_000) return [];
    const saved = JSON.parse(raw);
    if (
      saved.version !== 1 ||
      saved.sessionKey !== sessionKey ||
      !Array.isArray(saved.records) ||
      saved.records.length > 512
    )
      return [];
    return saved.records.filter(
      (r: SignalAnalysisRecord) =>
        r &&
        r.candidate &&
        typeof r.candidate.id === "string" &&
        r.candidate.id.length <= 512 &&
        Number.isFinite(r.candidate.frequencyHz) &&
        Number.isFinite(r.candidate.bandwidthHz) &&
        (r.candidate.aboveNoiseDb === undefined ||
          Number.isFinite(r.candidate.aboveNoiseDb)) &&
        r.candidate.bandwidthHz > 0 &&
        typeof r.at === "string" &&
        Number.isFinite(Date.parse(r.at)) &&
        (!r.error || typeof r.error === "string") &&
        (!r.previousEvidence ||
          (typeof r.previousEvidence.at === "string" &&
            Number.isFinite(Date.parse(r.previousEvidence.at)) &&
            r.previousEvidence.result?.version === 1 &&
            typeof r.previousEvidence.result.label === "string" &&
            r.previousEvidence.result.label.length <= 128)) &&
        (!r.result ||
          (r.result.version === 1 &&
            typeof r.result.label === "string" &&
            r.result.label.length <= 128 &&
            Array.isArray(r.result.reasons) &&
            r.result.reasons.length <= 12 &&
            r.result.reasons.every(
              (reason) => typeof reason === "string" && reason.length <= 1000,
            ) &&
            Number.isFinite(r.result.sampledSeconds) &&
            r.result.sampledSeconds >= 0 &&
            r.result.sampledSeconds <= 30 &&
            Number.isFinite(r.result.resolutionHz) &&
            r.result.resolutionHz > 0 &&
            ["complete", "inconclusive", "interrupted"].includes(
              r.result.status,
            ) &&
            (r.result.measuredBandwidthHz === undefined ||
              Number.isFinite(r.result.measuredBandwidthHz)) &&
            (r.result.stableProgrammeService === null ||
              (typeof r.result.stableProgrammeService === "string" &&
                r.result.stableProgrammeService.length <= 8)) &&
            r.result.rds &&
            Number.isInteger(r.result.rds.validGroups) &&
            (r.result.suggestedMode === undefined ||
              r.result.suggestedMode === "WBFM"))),
    );
  } catch {
    return [];
  }
}

export function SignalAnalysisPanel({
  sessionKey,
  candidates,
  selectedId,
  blocked,
  receiver,
  controller,
  pipeline,
  volume,
  startReception,
  onBusy,
  onRecords,
  onApply,
  onProgress,
  onActivity,
  stopToken = 0,
  runToken = 0,
  compact = false,
  setupRevision = 0,
  incomingRecord,
  onBudget,
}: {
  incomingRecord?: SignalAnalysisRecord;
  onBudget?: (seconds: number) => void;
  compact?: boolean;
  setupRevision?: number;
  sessionKey: string;
  candidates: readonly AnalysisCandidate[];
  selectedId?: string;
  blocked: boolean;
  receiver: ReceiverSnapshot;
  controller: ReceiverController;
  pipeline: AnalysisPipeline;
  volume: number;
  startReception: () => Promise<ReceiverSnapshot>;
  onBusy: (busy: boolean) => void;
  onRecords?: (records: SignalAnalysisRecord[]) => void;
  onApply: (frequencyHz: number, mode: "WBFM") => void;
  onProgress?: (message: string) => void;
  onActivity?: (activity: SignalAnalysisActivity | undefined) => void;
  stopToken?: number;
  runToken?: number;
}) {
  const [records, setRecords] = useState(() => loadRecords(sessionKey));
  const [seconds, setSeconds] = useState(() => {
    const saved = readPreference("browsersdr.analysisBudget.v1").seconds;
    return typeof saved === "number" && [6, 12, 20, 30].includes(saved)
      ? saved
      : 12;
  });
  useEffect(() => {
    storePreference("browsersdr.analysisBudget.v1", { seconds });
    onBudget?.(seconds);
  }, [seconds, onBudget]);
  useEffect(() => {
    if (!incomingRecord) return;
    setRecords((previous) => retainAnalysisEvidence(previous, incomingRecord));
    setMessage("Analysis finished for one candidate. Evidence retained.");
  }, [incomingRecord]);
  useEffect(() => {
    if (!setupRevision) return;
    const saved = readPreference("browsersdr.analysisBudget.v1").seconds;
    if (typeof saved === "number" && [6, 12, 20, 30].includes(saved))
      setSeconds(saved);
  }, [setupRevision]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Received-signal evidence only. Refines candidates, then tries broadcast FM / RDS where compatible.",
  );
  const [storage, setStorage] = useState("");
  const abort = useRef<AbortController>(undefined);
  const mounted = useRef(true);
  const handled = useRef(0);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => {
    mounted.current = true;
    const suspend = () => abort.current?.abort();
    document.addEventListener("freeze", suspend);
    window.addEventListener("pagehide", suspend);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      onActivityRef.current?.(undefined);
      document.removeEventListener("freeze", suspend);
      window.removeEventListener("pagehide", suspend);
    };
  }, []);
  useEffect(() => {
    onRecords?.(records);
  }, [records, onRecords]);
  useEffect(() => {
    onProgress?.(message);
  }, [message, onProgress]);
  useEffect(() => {
    if (stopToken) abort.current?.abort();
  }, [stopToken]);
  useEffect(() => {
    if (!records.length) return;
    try {
      const json = JSON.stringify({ version: 1, sessionKey, records });
      if (json.length > 1_500_000)
        throw new Error("Analysis checkpoint exceeds its storage limit.");
      localStorage.setItem(STORAGE_KEY, json);
      setStorage(
        "Latest analysis saved on this device. Export to retain additional sessions.",
      );
    } catch {
      setStorage("Analysis is in memory only. Export JSON to keep it.");
    }
  }, [records, sessionKey]);
  const run = useCallback(
    async (selectedOnly = false) => {
      if (abort.current || blocked) return;
      const jobs = selectedOnly
        ? candidates.filter((c) => c.id === selectedId)
        : [...candidates];
      if (!jobs.length) return;
      const cancellation = new AbortController();
      abort.current = cancellation;
      setBusy(true);
      onBusyRef.current(true);
      setMessage(
        `Preparing ${jobs.length} candidate${jobs.length === 1 ? "" : "s"}…`,
      );
      try {
        await analyzeCandidates(jobs, {
          pipeline,
          controller,
          startReception,
          volume,
          seconds,
          signal: cancellation.signal,
          onActivity: (activity) => {
            if (mounted.current) onActivityRef.current?.(activity);
          },
          onProgress: (done, total, candidate, acquired) => {
            if (mounted.current)
              setMessage(
                `Analyzing ${done + 1}/${total} · ${(candidate.frequencyHz / 1e6).toFixed(6)} MHz · ${acquired.toFixed(1)} s acquired · up to ${seconds} s per FM candidate`,
              );
          },
          onResult: (record) => {
            if (mounted.current)
              setRecords((previous) =>
                retainAnalysisEvidence(previous, record),
              );
          },
        });
        if (mounted.current)
          setMessage(
            `Analysis finished for ${jobs.length} candidates. Inspect the evidence and apply a suggestion deliberately.`,
          );
      } catch (error) {
        if (mounted.current)
          setMessage(
            cancellation.signal.aborted
              ? "Analysis stopped. Completed candidate evidence retained; unvisited candidates remain not analyzed."
              : error instanceof Error
                ? error.message
                : "Analysis failed.",
          );
      } finally {
        abort.current = undefined;
        if (mounted.current) setBusy(false);
        onBusyRef.current(false);
      }
    },
    [
      blocked,
      candidates,
      selectedId,
      controller,
      pipeline,
      startReception,
      volume,
      seconds,
    ],
  );
  useEffect(() => {
    if (!runToken || handled.current === runToken || blocked || abort.current)
      return;
    handled.current = runToken;
    void run();
  }, [runToken, blocked, run]);
  const available =
    !blocked &&
    !busy &&
    !!receiver.session &&
    ["running", "connected"].includes(receiver.lifecycle) &&
    receiver.session.source !== "replay" &&
    receiver.session.mode !== "ADS-B";
  const applicable = new Set(candidates.map((c) => c.id));
  const shown = records
    .filter((r) => applicable.has(r.candidate.id))
    .sort((a, b) => a.candidate.frequencyHz - b.candidate.frequencyHz);
  const unknown = Math.max(0, candidates.length - shown.length);
  return (
    <section
      className="signal-analysis"
      aria-label="Intelligent signal analysis"
    >
      <div className="signal-analysis-toolbar">
        <div>
          <strong>Intelligent analysis</strong>
          <small>Refined measurements · FM pilot · checked RDS</small>
        </div>
        <label>
          Analysis budget (s / candidate)
          <select
            aria-label="FM probe budget"
            value={seconds}
            disabled={busy || blocked}
            onChange={(e) => setSeconds(Number(e.target.value))}
          >
            <option value={6}>6 s / candidate</option>
            <option value={12}>12 s / candidate</option>
            <option value={20}>20 s / candidate</option>
            <option value={30}>30 s / candidate</option>
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!available || !candidates.length}
          onClick={() => void run()}
        >
          Analyze all signals
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!available || !selectedId}
          onClick={() => void run(true)}
        >
          Analyze selected signal
        </button>
        {busy && !compact && (
          <button
            type="button"
            className="secondary"
            onClick={() => abort.current?.abort()}
          >
            Stop analysis
          </button>
        )}
      </div>
      <p role="status" className="signal-analysis-progress">
        {message}
      </p>
      <small>
        {shown.length} analyzed · {unknown} not analyzed. Scanning/listening
        pauses during analysis. Unknown is a valid result; no catalog lookup is
        used.
      </small>
      {compact && !!shown.length && (
        <details className="signal-analysis-export">
          <summary>Export analysis evidence</summary>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      { version: 1, sessionKey, records: shown },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
              );
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${sessionKey}.signal-analysis.json`;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            Export analysis JSON
          </button>
          <small>{storage}</small>
        </details>
      )}
      {!!shown.length && !compact && (
        <details className="signal-analysis-evidence" open={shown.length <= 5}>
          <summary>
            Analysis evidence ·{" "}
            {shown.filter((r) => r.result?.suggestedMode).length} FM suggestions
            / {shown.length} visited
          </summary>
          <div className="monitor-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Frequency</th>
                  <th>Signal evidence</th>
                  <th>Refinement</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((record) => (
                  <tr key={record.candidate.id}>
                    <td>
                      {(record.candidate.frequencyHz / 1e6).toFixed(6)} MHz
                      <small>{new Date(record.at).toLocaleTimeString()}</small>
                    </td>
                    <td>
                      <strong>
                        {record.result?.label ?? "Analysis incomplete"}
                      </strong>
                      <details>
                        <summary>Why?</summary>
                        {record.error ? (
                          <p>{record.error}</p>
                        ) : (
                          <>
                            <ul>
                              {record.result!.reasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                            <p>
                              {record.result!.sampledSeconds.toFixed(2)} s
                              acquired · input samples{" "}
                              {record.result!.firstSampleIndex}–
                              {record.result!.lastSampleIndex} ·{" "}
                              {record.result!.discontinuities} gaps
                            </p>
                            <small>
                              Transmitted RDS data does not authenticate a
                              broadcaster or identify a physical transmitter.
                            </small>
                          </>
                        )}
                        {record.previousEvidence && (
                          <p>
                            Earlier evidence retained:{" "}
                            <strong>
                              {record.previousEvidence.result.label}
                            </strong>{" "}
                            ·{" "}
                            {new Date(
                              record.previousEvidence.at,
                            ).toLocaleString()}
                            . This is a previous visit, not the current analysis
                            result.
                          </p>
                        )}
                      </details>
                    </td>
                    <td>
                      {record.result?.measuredBandwidthHz === undefined
                        ? "—"
                        : `${(record.result.measuredBandwidthHz / 1000).toFixed(2)} kHz`}
                      <small>
                        {record.result
                          ? `${record.result.resolutionHz.toFixed(1)} Hz bins`
                          : "No measurement"}
                      </small>
                    </td>
                    <td>
                      {record.result?.suggestedMode ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!available}
                          onClick={() =>
                            onApply(record.candidate.frequencyHz, "WBFM")
                          }
                        >
                          Use WBFM + RDS
                        </button>
                      ) : (
                        "Unknown / inconclusive"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      { version: 1, sessionKey, records: shown },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = `${sessionKey}.signal-analysis.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            Export analysis JSON
          </button>
          <small>{storage}</small>
        </details>
      )}
    </section>
  );
}
