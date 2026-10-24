import type { ReceiverSnapshot } from "../radio/receiverController";
import type { SpectrumDisplayStatus } from "../graphics/WebGpuSpectrum";
import type { RecordingStatus } from "../radio/iqRecording";
import type { RecordingRetentionSnapshot } from "../radio/recordingExport";
import { AppIcon, type AppIconName } from "./AppIcon";

export function ReceiverHealth({
  receiver,
  spectrum,
  recording,
  preparing,
  retained,
  recordingSupported,
  onReceiver,
  onRecording,
  onSpectrum,
  compact = false,
  includeReceiver = false,
}: {
  receiver: ReceiverSnapshot;
  spectrum: SpectrumDisplayStatus;
  recording?: RecordingStatus;
  preparing: boolean;
  retained: RecordingRetentionSnapshot;
  recordingSupported: boolean;
  onReceiver: () => void;
  onRecording: () => void;
  onSpectrum: () => void;
  compact?: boolean;
  includeReceiver?: boolean;
}) {
  const running = receiver.lifecycle === "running";
  const noAudio =
    receiver.session?.source === "synthetic" ||
    [
      "OFF",
      "ADS-B",
      "AIS",
      "SRD",
      "POCSAG",
      "APRS",
      "RS41",
      "RTTY",
      "PSK31",
      "NAVTEX",
      "ACARS",
      "WEFAX",
      "SSTV",
    ].includes(receiver.session?.mode ?? "");
  const graphicsFailed =
    spectrum.kind === "unsupported" || spectrum.kind === "error";
  const readyRecording =
    retained.status === "prepared" || retained.status === "download-requested";
  const items = [
    {
      label: "Receiver",
      text: running
        ? receiver.session?.source === "replay"
          ? "● Replaying"
          : "● Receiving"
        : receiver.lifecycle === "connected"
          ? "✓ Connected"
          : receiver.issue?.code === "selection-cancelled"
            ? "Not connected"
            : receiver.lifecycle === "error"
              ? "Needs attention"
              : receiver.lifecycle === "idle"
                ? "Not connected"
                : receiver.lifecycle.replaceAll("-", " "),
      good: running || receiver.lifecycle === "connected",
      attention:
        receiver.issue?.code !== "selection-cancelled" &&
        Boolean(
          receiver.issue ||
          receiver.cleanupRequired ||
          receiver.lifecycle === "error",
        ),
    },
    {
      label: "Audio",
      text: noAudio
        ? "Not used in this mode"
        : receiver.audioState === "running" && running
          ? "Audio context running"
          : receiver.audioState === "suspended"
            ? "Audio context suspended"
            : typeof AudioContext !== "undefined"
              ? "API available · not playing"
              : "API unavailable",
      good: receiver.audioState === "running" && running && !noAudio,
      shortText: noAudio
        ? "Not used"
        : receiver.audioState === "running" && running
          ? "Running"
          : receiver.audioState === "suspended"
            ? "Suspended"
            : typeof AudioContext !== "undefined"
              ? "Stopped"
              : "Unavailable",
      attention:
        !noAudio &&
        running &&
        (receiver.audioState === "suspended" ||
          typeof AudioContext === "undefined"),
    },
    {
      label: compact && includeReceiver ? "Display" : "Spectrum",
      text: graphicsFailed
        ? "Display unavailable"
        : spectrum.paused
          ? "Display paused"
          : spectrum.stalled && running
            ? "No recent spectrum frames · restart reception"
            : spectrum.kind === "ready" && spectrum.hasFrame && running
              ? "✓ Working"
              : spectrum.kind === "ready"
                ? "Available · waiting for samples"
                : "Checking graphics…",
      good:
        !spectrum.paused &&
        !spectrum.stalled &&
        spectrum.kind === "ready" &&
        spectrum.hasFrame &&
        running,
      shortText: graphicsFailed
        ? "Unavailable"
        : spectrum.paused
          ? "Paused"
          : spectrum.stalled && running
            ? "Stalled"
            : spectrum.kind === "ready" && spectrum.hasFrame && running
              ? "Working"
              : spectrum.kind === "ready"
                ? "Ready · waiting"
                : "Checking",
      attention: graphicsFailed || Boolean(spectrum.stalled && running),
    },
    {
      label: "Recording",
      text: recording
        ? "● Recording"
        : preparing || retained.status === "preparing"
          ? "Preparing…"
          : readyRecording
            ? "✓ Recording ready"
            : retained.error
              ? "Needs attention"
              : recordingSupported
                ? running
                  ? "Ready to record"
                  : receiver.lifecycle === "connected"
                    ? "Start reception to record"
                    : "Connect a receiver to record"
                : "Unavailable for this receiver",
      good: Boolean(recording) || readyRecording,
      shortText: recording
        ? "Recording"
        : preparing || retained.status === "preparing"
          ? "Preparing"
          : retained.error
            ? "Needs attention"
            : readyRecording
              ? "Ready to download"
              : !recordingSupported
                ? "Unavailable"
                : "Off",
      attention: Boolean(retained.error),
    },
  ];
  if (compact) {
    const icons: Record<string, AppIconName> = {
      Receiver: "radio",
      Audio: "volume",
      Spectrum: "activity",
      Display: "activity",
      Recording: "record",
    };
    const actions: Record<string, () => void> = {
      Receiver: onReceiver,
      Audio: onReceiver,
      Spectrum: onSpectrum,
      Display: onSpectrum,
      Recording: onRecording,
    };
    return (
      <div
        className="receiver-health-summary"
        aria-label="Live receiver health"
        aria-live="polite"
      >
        {items
          .filter((item) => includeReceiver || item.label !== "Receiver")
          .map((item) => (
            <button
              key={item.label}
              type="button"
              className={`health-indicator secondary${item.attention ? " needs-attention" : item.good && item.label !== "Display" ? " is-working" : ""}`}
              aria-label={`${item.label}: ${item.text}. Review ${item.label.toLowerCase()}.`}
              onClick={actions[item.label]}
            >
              <AppIcon name={item.attention ? "alert" : icons[item.label]!} />
              <span>
                {item.label}: <strong>{item.shortText ?? item.text}</strong>
              </span>
            </button>
          ))}
      </div>
    );
  }
  return (
    <>
      <dl className="receiver-health" aria-label="Receiver health overview">
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd className={item.good ? "health-working" : ""}>{item.text}</dd>
          </div>
        ))}
      </dl>
      <div className="health-actions">
        {(receiver.lifecycle === "error" || receiver.cleanupRequired) && (
          <div>
            <p
              role={
                receiver.issue?.code === "selection-cancelled"
                  ? "status"
                  : "alert"
              }
            >
              {receiver.message}
            </p>
            {receiver.issue &&
              receiver.issue.code !== "selection-cancelled" && (
                <p>Open receiver status in the header for recovery steps.</p>
              )}
            <button type="button" onClick={onReceiver}>
              {receiver.cleanupRequired
                ? "Release device in receiver status"
                : "Review connection"}
            </button>
          </div>
        )}
        {graphicsFailed && (
          <div>
            <p>
              The spectrum display is unavailable. Receiver and audio status are
              shown separately above.
            </p>
            <button type="button" onClick={onSpectrum}>
              Review spectrum display
            </button>
          </div>
        )}
        {retained.error && (
          <div>
            <p role="alert">{retained.error}</p>
            <button type="button" onClick={onRecording}>
              Review recording
            </button>
          </div>
        )}
      </div>
    </>
  );
}
