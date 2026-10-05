import type { ReceiverSnapshot } from "../radio/receiverController";
import type { SpectrumDisplayStatus } from "../graphics/WebGpuSpectrum";
import type { RecordingStatus } from "../radio/iqRecording";
import type { RecordingRetentionSnapshot } from "../radio/recordingExport";

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
}) {
  const running = receiver.lifecycle === "running";
  const noAudio =
    receiver.session?.source === "synthetic" ||
    ["OFF", "ADS-B", "AIS", "SRD"].includes(receiver.session?.mode ?? "");
  const graphicsFailed =
    spectrum.kind === "unsupported" || spectrum.kind === "error";
  const readyRecording =
    retained.status === "prepared" || retained.status === "download-requested";
  const items = [
    {
      label: "Receiver",
      text: running
        ? "● Receiving"
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
    },
    {
      label: "Spectrum",
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
    },
  ];
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
                <p>
                  Recovery steps are available beside the receiver status in
                  Acquire.
                </p>
              )}
            <button type="button" onClick={onReceiver}>
              {receiver.cleanupRequired
                ? "Release device in Acquire"
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
