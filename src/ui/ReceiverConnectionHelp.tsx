import { useId, useState } from "react";
import {
  OPERATING_SYSTEMS,
  type OperatingSystem,
  type UsbAvailability,
} from "../platform/browserEnvironment";
import {
  deviceSetupSteps,
  isUsbSource,
  recoveryHint,
  recoverySteps,
  type ReceiverIssue,
  type RecoveryStep,
} from "../radio/receiverRecovery";
import type { SourceKind } from "../radio/types";

interface PlatformProps {
  os: OperatingSystem;
  onOsChange: (os: OperatingSystem) => void;
}

function PlatformChoice({ os, onOsChange }: PlatformProps) {
  const id = useId();
  return (
    <label className="connection-help-platform" htmlFor={id}>
      Instructions for
      <select
        id={id}
        value={os}
        onChange={(event) =>
          onOsChange(event.currentTarget.value as OperatingSystem)
        }
      >
        {OPERATING_SYSTEMS.map((value) => (
          <option key={value} value={value}>
            {value === "Unknown" ? "Choose your OS" : value}
          </option>
        ))}
      </select>
    </label>
  );
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <>
      <div className="connection-help-command">
        <code>{command}</code>
        <button
          type="button"
          className="secondary"
          onClick={() => void copy()}
          aria-label={`Copy command: ${command}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {copyFailed && (
        <small role="status">
          Select the command text to copy it manually.
        </small>
      )}
    </>
  );
}

function Steps({ steps }: { steps: RecoveryStep[] }) {
  return (
    <ol className="connection-help-steps">
      {steps.map((step, index) => (
        <li key={`${index}-${step.text}`}>
          <p>{step.text}</p>
          {step.command && <Command command={step.command} />}
          {step.note && <small>{step.note}</small>}
          {step.link && (
            <a href={step.link.url} target="_blank" rel="noreferrer">
              {step.link.label}
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ConnectionReadiness({
  source,
  availability,
  os,
  onOsChange,
}: PlatformProps & { source: SourceKind; availability: UsbAvailability }) {
  if (!isUsbSource(source)) return null;
  return (
    <div
      className={`connection-readiness${availability === "available" ? "" : " needs-setup"}`}
      aria-label="Connection setup"
    >
      <p>
        {availability === "insecure"
          ? "Open over HTTPS or localhost to connect a device."
          : availability === "unsupported"
            ? "Use a desktop browser with USB support, such as Chrome or Edge."
            : "Close other SDR apps before connecting."}
      </p>
      <details key={source} className="connection-help-details">
        <summary>Setup help{os !== "Unknown" && ` · ${os}`}</summary>
        <PlatformChoice os={os} onOsChange={onOsChange} />
        <Steps steps={deviceSetupSteps(source, os)} />
      </details>
    </div>
  );
}

export function ReceiverRecovery({
  issue,
  cleanupRequired,
  activeConnection,
  os,
  onOsChange,
  onRelease,
  onRetry,
  onReviewSettings,
  disabled,
}: PlatformProps & {
  issue: ReceiverIssue;
  cleanupRequired: boolean;
  activeConnection: boolean;
  onRelease: () => void;
  onRetry: () => void;
  onReviewSettings: () => void;
  disabled: boolean;
}) {
  const cancelled = issue.code === "selection-cancelled";
  const reviewSettings =
    activeConnection ||
    ["settings", "firmware", "device-unsupported"].includes(issue.code) ||
    (!isUsbSource(issue.source) && issue.code !== "audio-blocked");
  const canRetry = !["browser-unsupported", "device-unsupported"].includes(
    issue.code,
  );
  return (
    <div className="receiver-recovery">
      <p className="recovery-hint">{recoveryHint(issue, cleanupRequired)}</p>
      <div className="recovery-actions">
        {cleanupRequired ? (
          <button
            type="button"
            className="secondary"
            onClick={onRelease}
            disabled={disabled}
          >
            Release device
          </button>
        ) : reviewSettings ? (
          <button
            type="button"
            className="secondary"
            onClick={onReviewSettings}
            disabled={disabled}
          >
            Review settings
          </button>
        ) : canRetry ? (
          <button
            type="button"
            className="secondary"
            onClick={onRetry}
            disabled={disabled}
          >
            {cancelled
              ? "Choose device again"
              : issue.code === "audio-blocked"
                ? "Start receiving again"
                : "Retry connection"}
          </button>
        ) : null}
      </div>
      {!cancelled && (
        <details className="connection-help-details">
          <summary>Show recovery steps</summary>
          {isUsbSource(issue.source) && (
            <PlatformChoice os={os} onOsChange={onOsChange} />
          )}
          <Steps steps={recoverySteps(issue, os, cleanupRequired)} />
        </details>
      )}
    </div>
  );
}
