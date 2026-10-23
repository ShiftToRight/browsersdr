import type { ReactNode } from "react";
import type { ReceiverSnapshot } from "../radio/receiverController";
import type { SignalAnalysisActivity } from "../radio/signalAnalysis";
import { AppIcon } from "./AppIcon";

export function MonitorStatusCard({
  state,
  running,
  analyzing,
  pausing,
  receiver,
  complete,
  total,
  sweep,
  activity,
  pending,
  analyzed,
  children,
}: {
  state: string;
  running: boolean;
  analyzing: boolean;
  pausing: boolean;
  receiver: ReceiverSnapshot;
  complete: number;
  total: number;
  sweep: number;
  activity?: SignalAnalysisActivity;
  pending: number;
  analyzed: number;
  children: ReactNode;
}) {
  const variant = pausing
    ? "cleanup"
    : analyzing || state === "Restoring receiver"
      ? "analysis"
      : running
        ? "running"
        : ["failed", "interrupted"].includes(state)
          ? "failed"
          : state === "paused" || state === "stopped"
            ? "paused"
            : "ready";
  const live = receiver.lifecycle === "running";
  return (
    <div
      className="monitor-state-card"
      data-state={variant}
      aria-label="Monitoring status"
    >
      <div className="monitor-state-title" role="status" aria-live="polite">
        <span className="monitor-state-icon">
          <AppIcon
            name={
              pausing
                ? "retry"
                : analyzing
                  ? "search"
                  : running
                    ? "activity"
                    : variant === "failed"
                      ? "alert"
                      : variant === "paused"
                        ? "pause"
                        : "radio"
            }
          />
        </span>
        <strong className="status-pill">{pausing ? "Pausing…" : state}</strong>
      </div>
      <p className="monitor-acquisition-state">
        {live
          ? `Receiver acquiring at ${(receiver.session!.selectedChannelFrequencyHz / 1e6).toFixed(6)} MHz.`
          : receiver.lifecycle === "connected"
            ? "Receiver is not acquiring. History retained."
            : ["starting", "tuning", "stopping"].includes(receiver.lifecycle)
              ? "Receiver changing state; waiting for completion."
              : "Receiver is not acquiring."}
      </p>
      <div className="monitor-state-measurement">
        {analyzing && activity ? (
          <div className="monitor-state-progress">
            <div>
              <span>
                {activity.phase === "measuring"
                  ? "Acquired samples"
                  : activity.phase === "tuning"
                    ? "Tuning candidate"
                    : "Settling receiver"}
              </span>
              <span>
                {activity.acquiredSeconds.toFixed(1)} / {activity.budgetSeconds}{" "}
                s limit
              </span>
            </div>
            <progress
              aria-label="Candidate acquired samples"
              max={activity.budgetSeconds}
              value={activity.acquiredSeconds}
            />
            <small>
              {(activity.candidate.frequencyHz / 1e6).toFixed(6)} MHz ·{" "}
              {pending} waiting
            </small>
          </div>
        ) : total > 0 ? (
          <div className="monitor-state-progress">
            <div>
              <span>{running ? `Sweep ${sweep}` : "Last sweep"}</span>
              <span>
                {complete} / {total} windows
              </span>
            </div>
            <progress
              aria-label={
                running
                  ? "Discovery sweep progress"
                  : "Last measured sweep progress"
              }
              max={total}
              value={complete}
            />
            {!running && <small>Retained sweep · resume to continue</small>}
          </div>
        ) : null}
      </div>
      <small className="monitor-cycle-count" aria-hidden={analyzed === 0}>
        {analyzed} candidate {analyzed === 1 ? "visit" : "visits"} completed
      </small>
      {children}
    </div>
  );
}
