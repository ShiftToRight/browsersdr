import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { ReceiverHealth } from "./ReceiverHealth";
import { AppIcon } from "./AppIcon";
import { InstrumentFace } from "./InstrumentButton";

export function ReceiverStatus({
  children,
  onReport,
  ...health
}: Omit<
  ComponentProps<typeof ReceiverHealth>,
  "compact" | "includeReceiver"
> & {
  children: ReactNode;
  onReport: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target)
      ) {
        menu.current?.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const { receiver, spectrum, recording, retained } = health;
  const receivingLabel = receiver.session?.source === "replay" ? "Replaying" : "Receiving";
  const cancelled = receiver.issue?.code === "selection-cancelled";
  const receiverIssue =
    !cancelled &&
    Boolean(
      receiver.issue ||
      receiver.cleanupRequired ||
      receiver.lifecycle === "error",
    );
  const noAudio =
    receiver.session?.source === "synthetic" ||
    ["OFF", "ADS-B", "AIS", "SRD", "POCSAG", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV"].includes(receiver.session?.mode ?? "");
  const issues =
    Number(receiverIssue) +
    Number(
      spectrum.kind === "unsupported" ||
        spectrum.kind === "error" ||
        Boolean(spectrum.stalled && receiver.lifecycle === "running"),
    ) +
    Number(
      !noAudio &&
        receiver.lifecycle === "running" &&
        (receiver.audioState === "suspended" ||
          typeof AudioContext === "undefined"),
    ) +
    Number(Boolean(retained.error));
  const label = issues
    ? `${recording ? "Recording · " : receiver.lifecycle === "running" ? `${receivingLabel} · ` : ""}${issues} ${issues === 1 ? "issue" : "issues"}`
    : recording
      ? "Recording"
      : receiver.lifecycle === "running"
        ? receivingLabel
        : receiver.lifecycle === "connected"
          ? "Connected"
          : receiver.lifecycle === "idle" || cancelled
            ? receiver.session?.source === "replay" ? "Replay finished" : "Not connected"
            : receiver.lifecycle.replaceAll("-", " ");
  return (
    <div
      className={`receiver-status receiver-status-${cancelled ? "idle" : receiver.lifecycle}${receiver.issue ? " has-recovery" : ""}`}
    >
      <details
        ref={menu}
        className="receiver-status-menu"
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            menu.current?.removeAttribute("open");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            menu.current?.removeAttribute("open");
            menu.current?.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label={`Receiver status: ${label}`}>
          <InstrumentFace>
          <span
            className={`receiver-status-label${issues ? " needs-attention" : recording || receiver.lifecycle === "running" || receiver.lifecycle === "connected" ? " is-working" : ""}`}
            aria-live="polite"
          >
            <span className="receiver-status-dot" aria-hidden="true" />
            {label}
          </span>
          <AppIcon name="expand" />
          </InstrumentFace>
        </summary>
        <div
          className="receiver-health-panel"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(
                ".health-indicator, .open-diagnostics-button, .report-error-button",
              )
            )
              menu.current?.removeAttribute("open");
          }}
        >
          <p className="eyebrow">Receiver health</p>
          {!receiver.issue && <p>{receiver.message}</p>}
          <ReceiverHealth compact includeReceiver {...health} />
          {retained.error && (
            <p className="health-detail-error" role="alert">
              {retained.error}
            </p>
          )}
          {receiver.issue && (
            <div
              className="receiver-notice"
              role={cancelled ? "status" : "alert"}
            >
              <AppIcon name={cancelled ? "info" : "alert"} />
              <div className="receiver-status-content">
                <strong className="receiver-status-message">
                  {receiver.message}
                </strong>
                {children}
              </div>
              {receiver.lifecycle === "error" && !cancelled && (
                <button
                  type="button"
                  className="secondary report-error-button"
                  onClick={onReport}
                >
                  <AppIcon name="file" />
                  Review &amp; send report
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="secondary open-diagnostics-button"
            onClick={health.onReceiver}
          >
            <AppIcon name="activity" />
            Open diagnostics
          </button>
        </div>
      </details>
    </div>
  );
}
