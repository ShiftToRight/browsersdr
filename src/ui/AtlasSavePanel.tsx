import { useEffect, useMemo, useRef, useState } from "react";
import { AtlasClient, type AtlasAnalysisRun } from "../radio/atlasClient";
import {
  AtlasTransferController,
  type AtlasTransferRequest,
  type AtlasTransferResult,
  type AtlasTransferSnapshot,
} from "../radio/atlasTransfer";
import type { PreparedRecordingExport } from "../radio/recordingExport";

interface AtlasTransferControl {
  getSnapshot(): AtlasTransferSnapshot;
  subscribe(listener: (snapshot: AtlasTransferSnapshot) => void): () => void;
  start(request: AtlasTransferRequest): Promise<AtlasTransferResult>;
  cancel(): Promise<void>;
}

export interface AtlasSavePanelProps {
  prepared: PreparedRecordingExport;
  sourceKind?: "real" | "synthetic" | "unknown";
  onActiveChange?: (active: boolean) => void;
  createController?: (
    prepared: PreparedRecordingExport,
  ) => AtlasTransferControl;
  readAnalysisRun?: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<AtlasAnalysisRun>;
}

const ACTIVE_STATES = new Set<AtlasTransferSnapshot["state"]>([
  "checking",
  "authenticating",
  "hashing",
  "uploading",
  "completing",
  "registering",
  "importing",
]);

function defaultController(
  prepared: PreparedRecordingExport,
): AtlasTransferControl {
  return new AtlasTransferController(prepared, { client: new AtlasClient() });
}

function stageText(snapshot: AtlasTransferSnapshot): string {
  switch (snapshot.state) {
    case "idle":
      return "Prepared locally. Not connected; nothing has been sent.";
    case "checking":
      return "Checking the same-origin SigIntAtlas destination…";
    case "authenticating":
      return "SigIntAtlas is reachable. Authenticating this browser session…";
    case "hashing":
      return "Connected and authenticated. Hashing the immutable prepared pair…";
    case "uploading":
      return "Uploading bounded parts…";
    case "completing":
      return "Upload complete; SigIntAtlas is verifying the original bytes…";
    case "registering":
      return "Verified uploads are being bound into one recording…";
    case "importing":
      return "SigIntAtlas is validating and importing the recording revision…";
    case "saved":
      return "Saved and verified by SigIntAtlas.";
    case "cancelled":
      return "Transfer cancelled. The local prepared pair is still available.";
    case "failed":
      return `Transfer failed${snapshot.errorCode ? ` (${snapshot.errorCode})` : ""}. ${snapshot.message ?? "The local prepared pair is still available."}`;
  }
}

function analysisText(
  result: AtlasTransferResult | undefined,
  requested: boolean,
  pending: boolean,
  run: AtlasAnalysisRun | undefined,
): string {
  if (!requested) return "Analysis was not requested.";
  if (pending) return "Recording saved; analysis request is pending.";
  if (!result)
    return "Analysis will start only after the recording is saved and verified.";
  if (result.analysis.status === "unavailable")
    return `Saved; analysis unavailable. ${result.analysis.reason ?? ""}`.trim();
  if (result.analysis.status === "failed")
    return `Saved; analysis request failed. ${result.analysis.reason ?? ""}`.trim();
  if (result.analysis.status === "not-requested")
    return "Saved; analysis was not requested.";
  switch (run?.status) {
    case "success":
      return "Analysis completed. Open the result in SigIntAtlas.";
    case "partial":
      return "Analysis completed with partial coverage. Open the result for limitations.";
    case "failure":
      return "The recording is saved, but analysis failed. Open the result for details.";
    case "cancelled":
      return "The recording is saved, but analysis was cancelled.";
    default:
      return "Analysis is queued or running in SigIntAtlas.";
  }
}

export function AtlasSavePanel({
  prepared,
  sourceKind = "unknown",
  onActiveChange,
  createController,
  readAnalysisRun,
}: AtlasSavePanelProps) {
  const controller = useMemo(
    () => (createController ?? defaultController)(prepared),
    [createController, prepared],
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [operatorToken, setOperatorToken] = useState("");
  const [title, setTitle] = useState(prepared.basename);
  const [analyzeAfterSave, setAnalyzeAfterSave] = useState(false);
  const [result, setResult] = useState<AtlasTransferResult>();
  const [analysisRun, setAnalysisRun] = useState<AtlasAnalysisRun>();
  const [requestPending, setRequestPending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const mounted = useRef(true);
  const currentController = useRef(controller);
  currentController.current = controller;
  const runClient = useMemo(() => new AtlasClient(), []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      mounted.current = false;
      unsubscribe();
      queueMicrotask(() => {
        if (!mounted.current || currentController.current !== controller)
          void controller.cancel();
      });
    };
  }, [controller]);

  const transferActive = ACTIVE_STATES.has(snapshot.state);
  const active =
    transferActive || (requestPending && snapshot.state === "saved");
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  const start = () => {
    setLocalError(undefined);
    if (!title.trim()) {
      setLocalError("Enter a recording title before saving.");
      return;
    }
    if (operatorToken.length < 32) {
      setLocalError(
        "Enter the configured SigIntAtlas operator token (at least 32 characters). The token stays only in memory.",
      );
      return;
    }
    setRequestPending(true);
    void controller
      .start({
        operatorToken,
        title: title.trim(),
        sourceKind,
        analyzeAfterSave,
      })
      .then((next) => {
        if (!mounted.current) return;
        setResult(next);
        setAnalysisRun(next.analysis.run);
        setOperatorToken("");
      })
      .catch((error: unknown) => {
        if (mounted.current && error instanceof Error)
          setLocalError(error.message);
      })
      .finally(() => {
        if (mounted.current) setRequestPending(false);
      });
  };

  const runId = result?.analysis.run?.id;
  useEffect(() => {
    if (!runId || !result || result.analysis.status !== "scheduled") return;
    if (!["queued", "running"].includes(result.analysis.run?.status ?? ""))
      return;
    const aborter = new AbortController();
    const read =
      readAnalysisRun ??
      ((id: string, signal: AbortSignal) =>
        runClient.getAnalysisRun(id, signal));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (milliseconds: number) =>
      new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          reject(aborter.signal.reason);
        };
        timer = setTimeout(() => {
          aborter.signal.removeEventListener("abort", onAbort);
          resolve();
        }, milliseconds);
        aborter.signal.addEventListener("abort", onAbort, { once: true });
      });
    void (async () => {
      let failures = 0;
      for (let poll = 0; poll < 120 && !aborter.signal.aborted; poll += 1) {
        try {
          await wait(failures ? Math.min(8_000, 1_000 * 2 ** failures) : 1_000);
          const next = await read(runId, aborter.signal);
          failures = 0;
          if (mounted.current) setAnalysisRun(next);
          if (!["queued", "running"].includes(next.status)) return;
        } catch {
          if (aborter.signal.aborted) return;
          failures += 1;
          if (failures >= 6) return;
        }
      }
    })();
    return () => {
      aborter.abort(
        new DOMException("Analysis status polling stopped", "AbortError"),
      );
      if (timer) clearTimeout(timer);
    };
  }, [readAnalysisRun, result, runClient, runId]);

  const total = Number(snapshot.totalBytes);
  const transferred = Number(snapshot.bytesTransferred);
  const progress = total > 0 ? Math.min(100, (transferred / total) * 100) : 0;
  const saved = snapshot.state === "saved";
  const analysisPending = saved && requestPending && analyzeAfterSave;
  const canStart = !active && !saved && !requestPending;

  return (
    <section className="atlas-save-panel" aria-labelledby="atlas-save-heading">
      <div className="atlas-save-heading">
        <div>
          <p className="eyebrow">Optional library destination</p>
          <h3 id="atlas-save-heading">Save to SigIntAtlas</h3>
        </div>
        <span className={`atlas-connection atlas-${snapshot.state}`}>
          {saved
            ? "Saved"
            : active
              ? "Connected workflow"
              : snapshot.state === "failed"
                ? "Attention needed"
                : "Local only"}
        </span>
      </div>
      <p>
        Explicit opt-in only. This sends the prepared SigMF data and metadata to
        the same-origin SigIntAtlas library at <code>/api/v1</code>. It never
        uploads surveys, diagnostics, browser location, or future captures
        automatically.
      </p>
      <div className="atlas-save-fields">
        <label>
          Recording title
          <input
            aria-label="SigIntAtlas recording title"
            value={title}
            maxLength={200}
            disabled={active || saved}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label>
          Operator token
          <input
            aria-label="SigIntAtlas operator token"
            type="password"
            value={operatorToken}
            autoComplete="off"
            spellCheck={false}
            disabled={active || saved}
            onChange={(event) => setOperatorToken(event.currentTarget.value)}
          />
        </label>
        <label className="atlas-analysis-choice">
          <input
            type="checkbox"
            checked={analyzeAfterSave}
            disabled={active || saved}
            onChange={(event) =>
              setAnalyzeAfterSave(event.currentTarget.checked)
            }
          />
          Analyze after save when the live capability and prepared layout
          support it
        </label>
      </div>
      <div className="atlas-save-actions">
        <button type="button" disabled={!canStart} onClick={start}>
          {snapshot.state === "failed" || snapshot.state === "cancelled"
            ? "Retry save"
            : "Save to SigIntAtlas"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!transferActive}
          onClick={() => void controller.cancel()}
        >
          Cancel transfer
        </button>
      </div>
      <div className="atlas-transfer-status" aria-live="polite">
        <strong>{stageText(snapshot)}</strong>
        {(active || snapshot.bytesTransferred !== "0") && (
          <>
            <progress
              aria-label="SigIntAtlas upload and verification progress"
              max={100}
              value={progress}
            />
            <span>
              {transferred.toLocaleString()} of {total.toLocaleString()} bytes
              accepted for upload
            </span>
          </>
        )}
        {localError && snapshot.state !== "failed" && (
          <span className="atlas-error">{localError}</span>
        )}
        {saved && (
          <span>
            {analysisText(
              result,
              analyzeAfterSave,
              analysisPending,
              analysisRun,
            )}
          </span>
        )}
      </div>
      {saved && (
        <div className="atlas-saved-links">
          <a href={snapshot.recordingUrl} target="_blank" rel="noreferrer">
            Open saved recording
          </a>
          {result?.analysis.status === "scheduled" &&
            result.analysis.run?.result_url && (
              <a
                href={result.analysis.run.result_url}
                target="_blank"
                rel="noreferrer"
              >
                Open analysis result
              </a>
            )}
        </div>
      )}
      <p className="display-note">
        The operator token is kept only in this page's memory. Retry reuses
        verified parts while this prepared pair remains retained. Reload cannot
        resume without preparing or reselecting the source bytes. Offline ZIP
        and separate-file downloads remain available.
      </p>
    </section>
  );
}
