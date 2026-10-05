import { preparedReception } from "../radio/receptionEvidence";
import { ActionButton } from "./ActionButton";
import { useEffect, useMemo, useRef, useState } from "react";
import { AtlasClient, type AtlasAnalysisRun } from "../radio/atlasClient";
import { atlasWebPageUrl } from "../radio/atlasWebNavigation";
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
  pause?(): void;
}

export interface AtlasSavePanelProps {
  prepared: PreparedRecordingExport;
  sourceKind?: "real" | "synthetic" | "unknown";
  onRecordNext?: (recordingUrl: string) => void;
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

const USER_TOKEN_STORAGE_KEY = "browsersdr.atlas.user-token.v1";

export function readUserToken(): string {
  try {
    const token = localStorage.getItem(USER_TOKEN_STORAGE_KEY) ?? "";
    return token.length >= 32 ? token : "";
  } catch {
    return "";
  }
}

function storeUserToken(token: string): boolean {
  try {
    if (token) localStorage.setItem(USER_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function uploadSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1_000 && unit < units.length - 1) {
    size /= 1_000;
    unit += 1;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function defaultController(
  prepared: PreparedRecordingExport,
): AtlasTransferControl {
  return new AtlasTransferController(prepared, { client: new AtlasClient() });
}

function stageText(snapshot: AtlasTransferSnapshot): string {
  switch (snapshot.state) {
    case "waiting":
      return "Server verification pending. Continue verification resumes the receipt; closed uploads are not sent again.";
    case "idle":
      return "Prepared locally. Not connected; nothing has been sent.";
    case "checking":
      return "Checking the same-origin SigIntAtlas destination…";
    case "authenticating":
      return "SigIntAtlas is reachable. Authenticating this browser session…";
    case "hashing":
      return "Connected and authenticated. Checking recording integrity…";
    case "uploading":
      return "Uploading recording…";
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
      return "Analysis completed with limits. Open the result for coverage and identification limitations.";
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
  onRecordNext,
  onActiveChange,
  createController,
  readAnalysisRun,
}: AtlasSavePanelProps) {
  const controller = useMemo(
    () => (createController ?? defaultController)(prepared),
    [createController, prepared],
  );
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [userToken, setUserToken] = useState(readUserToken);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [selectedOrigin, setSelectedOrigin] = useState(preparedReception(prepared)?.source_kind ?? sourceKind);
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
    const unsubscribe = controller.subscribe(next => {
      setSnapshot(next);
      if (next.receiptRequest) { setTitle(next.receiptRequest.title); setSelectedOrigin(next.receiptRequest.sourceKind ?? "unknown"); setAnalyzeAfterSave(next.receiptRequest.analyzeAfterSave ?? false); }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      queueMicrotask(() => {
        if (!mounted.current || currentController.current !== controller)
          if (controller.pause) controller.pause(); else void controller.cancel();
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
    if (userToken.length < 32) {
      setLocalError(
        "Enter the configured SigIntAtlas user token (at least 32 characters).",
      );
      return;
    }
    setStorageNotice(
      storeUserToken(userToken)
        ? undefined
        : "Browser storage is unavailable. Re-enter the token after reopening this panel.",
    );
    setRequestPending(true);
    void controller
      .start({
        userToken,
        title: title.trim(),
        sourceKind: selectedOrigin,
        analyzeAfterSave,
      })
      .then((next) => {
        if (!mounted.current) return;
        setResult(next);
        setAnalysisRun(next.analysis.run);
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
              : snapshot.state === "waiting"
                ? "Verification pending"
              : snapshot.state === "failed"
                ? "Attention needed"
                : "Local only"}
        </span>
      </div>
      <p>
        Explicit opt-in only. This sends the prepared SigMF data and metadata to
        the SigIntAtlas library at <strong>{location.hostname === "browsersdr.com" || location.hostname === "www.browsersdr.com" ? "sigintatlas.com · Production" : location.origin}</strong>. It never
        uploads surveys, diagnostics, browser location, or future captures
        automatically.
      </p>
      <div className="atlas-save-fields">
        <label>Capture origin
          <select aria-label="SigIntAtlas capture origin" value={selectedOrigin} disabled={active || saved || snapshot.requestLocked}
            onChange={event => setSelectedOrigin(event.currentTarget.value as typeof selectedOrigin)}>
            <option value="real">Real capture</option><option value="synthetic">Synthetic</option><option value="unknown">Unknown / unresolved replay</option>
          </select>
        </label>
        {preparedReception(prepared)?.candidate && <p>Intended station: {preparedReception(prepared)?.candidate?.station_name ?? "Catalog candidate"}. Confirm identity in the saved reception form.</p>}
        <p>Saved RDS evidence: {preparedReception(prepared)?.decoded_evidence.length ?? 0} observations from the saved range. Prior session text is excluded. Exact RDS coverage is currently available for native RTL-SDR captures.</p>
        {preparedReception(prepared)?.decoded_evidence.at(-1) && <dl className="rds-grid">
          <div><dt>Saved PI</dt><dd>{preparedReception(prepared)?.decoded_evidence.at(-1)?.pi}</dd></div>
          <div><dt>Saved PS</dt><dd>{preparedReception(prepared)?.decoded_evidence.at(-1)?.ps ?? "Not decoded"}</dd></div>
          <div><dt>Saved RadioText (partial)</dt><dd>{preparedReception(prepared)?.decoded_evidence.at(-1)?.radio_text ?? "Not decoded"}</dd></div>
        </dl>}
        <label>
          Recording title
          <input
            aria-label="SigIntAtlas recording title"
            value={title}
            maxLength={200}
            disabled={active || saved || snapshot.requestLocked}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label>
          SigIntAtlas user token
          <input
            aria-label="SigIntAtlas user token"
            type="password"
            value={userToken}
            autoComplete="off"
            spellCheck={false}
            disabled={active || saved}
            onChange={(event) => setUserToken(event.currentTarget.value)}
          />
        </label>
        <label className="atlas-analysis-choice">
          <input
            type="checkbox"
            checked={analyzeAfterSave}
            disabled={active || saved || snapshot.requestLocked}
            onChange={(event) =>
              setAnalyzeAfterSave(event.currentTarget.checked)
            }
          />
          Analyze after save when the live capability and prepared layout
          support it
        </label>
      </div>
      <div className="atlas-save-actions">
        <ActionButton
          type="button"
          disabledReason={
            saved
              ? "This recording is already saved."
              : "Wait for the current save to finish."
          }
          disabled={!canStart}
          onClick={start}
        >
          {snapshot.state === "failed" || snapshot.state === "cancelled"
            ? "Retry save"
            : snapshot.state === "waiting" ? "Continue verification"
            : "Save to SigIntAtlas"}
        </ActionButton>
        <ActionButton
          type="button"
          disabledReason={"There is no active transfer to cancel."}
          className="secondary"
          disabled={!transferActive}
          onClick={() => void controller.cancel()}
        >
          Cancel transfer
        </ActionButton>
        <ActionButton
          type="button"
          disabledReason={
            "Wait for the transfer to finish before removing its token."
          }
          className="secondary"
          disabled={active}
          onClick={() => {
            const removed = storeUserToken("");
            setUserToken("");
            setStorageNotice(
              removed
                ? undefined
                : "The saved token could not be removed from browser storage.",
            );
          }}
        >
          Forget token
        </ActionButton>
      </div>
      {storageNotice && <p className="display-note">{storageNotice}</p>}
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
              {uploadSize(transferred)} of {uploadSize(total)} uploaded
            </span>
          </>
        )}
        {snapshot.verificationStage && <span>Verification {snapshot.verificationStage === "queued" ? "queued — waiting for the worker; analysis may be using it" : snapshot.verificationStage === "active" ? "active" : "awaiting server reconciliation"} · {snapshot.waitSeconds ?? 0}s elapsed. Bytes are retained on the server.</span>}
        {snapshot.requestLocked && <span>{snapshot.recoveryAvailable ? "A resumable receipt is saved in this browser. Use Recover SigIntAtlas transfers after reopening." : "Browser receipt storage is unavailable; keep this tab open or download the exact pair for recovery."}</span>}
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
          <p>Saved · Bytes verified · Identity awaits confirmation · Reception history {selectedOrigin === "real" ? "awaits a dated linked claim" : `excluded: ${selectedOrigin === "unknown" ? "Unknown source kind" : "Synthetic source"}`}</p>
          <a href={`${atlasWebPageUrl(snapshot.recordingUrl)}?tab=annotations&reception=1`} target="_blank" rel="noreferrer">Confirm reception in SigIntAtlas</a>
          {onRecordNext && !active && <button type="button" onClick={() => { const url = atlasWebPageUrl(snapshot.recordingUrl); if (url) onRecordNext(url); }}>Record next station</button>}
          <a
            href={atlasWebPageUrl(snapshot.recordingUrl)}
            target="_blank"
            rel="noreferrer"
          >
            Open saved recording
          </a>
          {result?.analysis.status === "scheduled" &&
            result.analysis.run?.result_url && (
              <a
                href={atlasWebPageUrl(result.analysis.run.result_url)}
                target="_blank"
                rel="noreferrer"
              >
                Open analysis result
              </a>
            )}
        </div>
      )}
      <p className="display-note">
        Your token is remembered in this browser for future saves. Use Forget
        token to remove it. Keep this page open until the upload finishes;
        the resumable receipt survives reopening. If missing parts remain, prepare the exact original pair again; a new capture cannot replace it. You can also download
        the recording as a ZIP or separate files.
      </p>
    </section>
  );
}
