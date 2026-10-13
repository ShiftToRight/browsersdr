import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  COMMUNITY_FEATURES,
  COMMUNITY_REPORT_HARDWARE,
  defaultCommunityHardware,
  type CommunityFeatureId,
  type CommunityHardwareId,
} from "../diagnostics/communityCatalog";
import {
  buildCommunityReport,
  communityContextKey,
  communityParticipant,
  COMMUNITY_BUILD,
  downloadCommunityReport,
  sendCommunityReport,
} from "../diagnostics/communityReports";
import type { CommunityReport } from "../diagnostics/communityTypes";
import type {
  CompatibilityReportContext,
  CompatibilityResult,
} from "../diagnostics/compatibilityTypes";
import { ReportDialog } from "./ReportDialog";

export function CommunityTestReport({
  context,
  renderer,
  blockedReason,
  onSent,
}: {
  context: CompatibilityReportContext;
  renderer?: "webgpu" | "canvas2d";
  blockedReason?: string;
  onSent: () => void;
}) {
  const [frozen, setFrozen] = useState<{
    context: CompatibilityReportContext;
    key: string;
    token: string;
    id: string;
    createdAt: string;
    renderer: "webgpu" | "canvas2d" | "unknown";
  }>();
  const [hardwareId, setHardwareId] = useState<CommunityHardwareId>(
    defaultCommunityHardware(context.source),
  );
  const [results, setResults] = useState<
    Partial<Record<CommunityFeatureId, CompatibilityResult>>
  >({});
  const [duration, setDuration] = useState("");
  const [scope, setScope] = useState<"smoke" | "sustained">("smoke");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const [status, setStatus] = useState("");
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [ack, setAck] = useState<{ reference: string; receipt: string }>();
  const available = COMMUNITY_FEATURES.filter((f) => {
    if (f.id === "srd-acurite")
      return (
        frozen?.context.mode === "SRD" &&
        frozen.context.srdProtocol === "acurite-592txr"
      );
    if (f.id === "srd-wh51")
      return (
        frozen?.context.mode === "SRD" &&
        frozen.context.srdProtocol === "fineoffset-wh51"
      );
    return f.mode
      ? f.mode === frozen?.context.mode
      : f.id !== "access" ||
          !["synthetic", "replay"].includes(frozen?.context.source ?? "");
  });
  const observations = useMemo(
    () =>
      COMMUNITY_FEATURES.flatMap((f) =>
        results[f.id] ? [{ feature: f.id, result: results[f.id]! }] : [],
      ),
    [results],
  );
  const changed = frozen && frozen.key !== communityContextKey(context);
  const buildEligible =
    COMMUNITY_BUILD.id !== "development" &&
    COMMUNITY_BUILD.builtAt !== "unknown";
  const minutes = Number(duration);
  const valid =
    duration !== "" &&
    Number.isFinite(minutes) &&
    minutes >= 0 &&
    minutes <= 10080 &&
    observations.length > 0;
  const report: CommunityReport | undefined = frozen
    ? {
        ...buildCommunityReport(frozen.context, {
          hardwareId,
          participantToken: frozen.token,
          durationMinutes: duration === "" ? 0 : minutes,
          testScope: scope,
          observations,
          notes,
          reportId: frozen.id,
          renderer: frozen.renderer,
        }),
        createdAt: frozen.createdAt,
      }
    : undefined;
  const open = () => {
    setWithdrawalOpen(false);
    const snapshot = { ...context };
    const token = communityParticipant(COMMUNITY_BUILD.id);
    setHardwareId(defaultCommunityHardware(snapshot.source));
    setResults({});
    setDuration("");
    setNotes("");
    setScope("smoke");
    setStatus("");
    setFrozen({
      context: snapshot,
      key: communityContextKey(snapshot),
      token,
      id: `BC-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      renderer: renderer ?? "unknown",
    });
  };
  const send = async () => {
    if (
      !report ||
      !valid ||
      changed ||
      !buildEligible ||
      pending.current ||
      blockedReason
    )
      return;
    pending.current = true;
    setSending(true);
    setStatus("Sending reviewed test…");
    try {
      const result = await sendCommunityReport(report);
      setAck(result);
      setFrozen(undefined);
      setStatus(
        "Test received. Independence review is pending. Keep the receipt to withdraw this report.",
      );
      onSent();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Report could not be sent.",
      );
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  const withdraw = async () => {
    if (!ack || pending.current) return;
    pending.current = true;
    setSending(true);
    try {
      const endpoint =
        import.meta.env.VITE_COMPATIBILITY_ENDPOINT?.trim() ||
        "/api/v1/compatibility-reports";
      const response = await fetch(`${endpoint}/withdraw`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ack),
      });
      if (!response.ok)
        throw new Error(`Withdrawal failed (${response.status}).`);
      setAck(undefined);
      setWithdrawalOpen(false);
      setStatus("Report withdrawn. Community counts will refresh.");
      onSent();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Withdrawal failed.");
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  const loadReceipt = async (file: File) => {
    try {
      if (file.size > 4096) throw new Error("Receipt file is too large.");
      const value: unknown = JSON.parse(await file.text());
      if (
        !value ||
        typeof value !== "object" ||
        !("reference" in value) ||
        !("receipt" in value) ||
        Object.keys(value).some(
          (key) => !["reference", "receipt"].includes(key),
        ) ||
        typeof value.reference !== "string" ||
        !/^BC-[a-f0-9]{24}$/.test(value.reference) ||
        typeof value.receipt !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.receipt)
      )
        throw new Error("Invalid withdrawal receipt.");
      setAck({ reference: value.reference, receipt: value.receipt });
      setStatus(
        "Receipt loaded locally. Press Withdraw this report to remove its evidence.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Invalid withdrawal receipt.",
      );
    }
  };
  return (
    <div className="community-report-action">
      <div className="community-report-buttons">
        <button
          type="button"
          onClick={open}
          disabled={Boolean(blockedReason) || sending}
        >
          Report this test
        </button>
        <button
          type="button"
          className="secondary"
          disabled={sending}
          onClick={() => {
            setFrozen(undefined);
            setStatus("");
            setWithdrawalOpen(true);
          }}
        >
          Withdraw report
        </button>
        {ack && (
          <button
            type="button"
            className="secondary"
            disabled={sending}
            onClick={() =>
              downloadCommunityReport(ack, "community-test-receipt.json")
            }
          >
            Download withdrawal receipt
          </button>
        )}
      </div>
      {blockedReason && <small>{blockedReason}</small>}
      {status && !withdrawalOpen && !frozen && (
        <p className="community-report-status" role="status">
          {status}
        </p>
      )}
      {withdrawalOpen &&
        createPortal(
          <ReportDialog
            className="community-withdrawal-dialog"
            labelledBy="community-withdrawal-title"
            onDismiss={() => {
              if (!pending.current) setWithdrawalOpen(false);
            }}
          >
            <h2 id="community-withdrawal-title">Withdraw a report</h2>
            <p>
              Load your private receipt to withdraw its report. Loading stays in
              this browser until you press Withdraw this report. Keep the
              receipt private: anyone holding it can authorize withdrawal.
            </p>
            <label>
              Withdrawal receipt JSON
              <input
                type="file"
                accept="application/json,.json"
                disabled={sending}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void loadReceipt(file);
                }}
              />
            </label>
            {ack && (
              <p>
                Report reference: <code>{ack.reference}</code>
              </p>
            )}
            {status && <p role="status">{status}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                disabled={!ack || sending}
                onClick={() => void withdraw()}
              >
                Withdraw this report
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sending}
                onClick={() => setWithdrawalOpen(false)}
              >
                Cancel
              </button>
            </div>
          </ReportDialog>,
          document.body,
        )}
      {frozen &&
        createPortal(
          <ReportDialog
            className="community-report-dialog"
            labelledBy="community-report-title"
            onDismiss={() => {
              if (!pending.current) setFrozen(undefined);
            }}
          >
            <h2 id="community-report-title">Report a community test</h2>
            <p>
              {frozen.context.deviceProfile} · {frozen.context.mode} ·{" "}
              {frozen.context.sampleRateHz.toLocaleString()} processing
              samples/s
            </p>
            <p>
              Choose only functions you exercised. Environment details are
              filled automatically; receiver settings, browser capabilities and
              notes remain private. No radio data, location or device serial is
              sent.
            </p>
            <label>
              Tested receiver
              <select
                value={hardwareId}
                disabled={sending}
                onChange={(event) =>
                  setHardwareId(
                    event.currentTarget.value as CommunityHardwareId,
                  )
                }
              >
                {COMMUNITY_REPORT_HARDWARE.filter(
                  (h) => h.source === frozen.context.source,
                ).map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="compatibility-observations">
              {available.map((f) => (
                <label key={f.id}>
                  <span>{f.label}</span>
                  <select
                    aria-label={`${f.label} test result`}
                    value={results[f.id] ?? "not-tested"}
                    disabled={sending}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setResults((previous) => {
                        const next = { ...previous };
                        if (value === "not-tested") delete next[f.id];
                        else next[f.id] = value as CompatibilityResult;
                        return next;
                      });
                    }}
                  >
                    <option value="not-tested">Not tested</option>
                    <option value="working">Works</option>
                    <option value="degraded">Degraded</option>
                    <option value="not-working">Doesn’t work</option>
                  </select>
                </label>
              ))}
            </div>
            <div className="community-actions">
              <label>
                Test duration (minutes)
                <input
                  aria-label="Test duration (minutes)"
                  type="number"
                  min="0"
                  max="10080"
                  step="0.5"
                  value={duration}
                  disabled={sending}
                  onChange={(event) => setDuration(event.currentTarget.value)}
                />
              </label>
              <label>
                Test scope
                <select
                  aria-label="Test scope"
                  value={scope}
                  disabled={sending}
                  onChange={(event) =>
                    setScope(event.currentTarget.value as "smoke" | "sustained")
                  }
                >
                  <option value="smoke">Smoke test · 5+ minutes</option>
                  <option value="sustained">
                    Sustained test · 30+ minutes
                  </option>
                </select>
              </label>
            </div>
            <p>
              Short tests and problems are still recorded. Confirmation needs
              two reviewed independent positives meeting the selected duration.
            </p>
            <label>
              Private test notes
              <textarea
                maxLength={1000}
                value={notes}
                disabled={sending}
                onChange={(event) => setNotes(event.currentTarget.value)}
              />
            </label>
            <p>
              A random participation token is kept locally for this build to
              avoid duplicate votes. Another browser or cleared storage does not
              prove a separate device; review remains necessary.
            </p>
            {changed && (
              <p role="alert">
                The receiver setup changed. Cancel and open a fresh report;
                these results still refer to the original setup.
              </p>
            )}
            {!buildEligible && (
              <p>
                This is a development build. Download the report for review;
                sending requires an exact registered release build.
              </p>
            )}
            <details>
              <summary>Review outgoing JSON</summary>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </details>
            {status && <p role="status">{status}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                disabled={
                  sending || !valid || Boolean(changed) || !buildEligible
                }
                onClick={() => void send()}
              >
                Send community report
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sending || !valid}
                onClick={() => {
                  if (report) downloadCommunityReport(report);
                }}
              >
                Download community JSON
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sending || !valid}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      JSON.stringify(report, null, 2),
                    );
                    setStatus("Community JSON copied.");
                  } catch {
                    setStatus(
                      "Clipboard access was blocked. Download the JSON instead.",
                    );
                  }
                }}
              >
                Copy community JSON
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sending}
                onClick={() => setFrozen(undefined)}
              >
                Cancel
              </button>
            </div>
          </ReportDialog>,
          document.body,
        )}
    </div>
  );
}
