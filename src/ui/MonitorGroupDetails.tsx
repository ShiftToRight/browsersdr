import type { MonitorSignal } from "../radio/signalMonitor";

const frequency = (hz: number) => `${(hz / 1e6).toFixed(6)} MHz`;
export function MonitorGroupDetails({ signal }: { signal: MonitorSignal }) {
  if (!signal.group) return null;
  const { group } = signal;
  const reliable = signal.centerEvidence?.length ?? 0;
  return (
    <details className="monitor-group-details">
      <summary
        aria-label={`Expand group · ${group.componentCount} ${group.componentCount === 1 ? "component" : "components"}`}
      >
        Group ({group.componentCount})
      </summary>
      <div aria-label={`Group evidence at ${frequency(signal.frequencyHz)}`}>
        <p>
          <strong>
            {reliable
              ? "Stable middle frequency"
              : "Provisional middle frequency"}
            :
          </strong>{" "}
          {frequency(signal.frequencyHz)}
        </p>
        <p>
          {reliable
            ? `Median of ${reliable} recent complete visits. Observed center spread: ${Math.round(signal.centerSpreadHz ?? 0).toLocaleString()} Hz.`
            : "Edges are clipped. A complete observation is needed for a stable center."}
        </p>
        <p>
          Tracked envelope: {frequency(signal.lowerFrequencyHz!)}–
          {frequency(signal.upperFrequencyHz!)}. Its midpoint can differ from
          the stable middle.
        </p>
        <p>
          {group.reason === "supported-notch"
            ? "Grouped across bounded shallow notches with evidence of activity in the same frames. Gaps are inferred envelope extent."
            : "One contiguous region of supported spectral power."}{" "}
          Grouping does not identify a transmitter.
        </p>
        <p>
          Latest valid detection: {new Date(signal.lastSeen).toLocaleString()}.
          FFT bin spacing: {group.binSpacingHz.toLocaleString()} Hz. Activity
          counts each observed frame once.
        </p>
        {group.associationUncertain && (
          <p className="monitor-warning">
            Association uncertain: multiple histories fit this observation.
            Neighboring histories remain separate.
          </p>
        )}
        <ul aria-label="Latest supported components">
          {group.components.map((c, i) => (
            <li key={i}>
              {frequency(c.lowerHz)}–{frequency(c.upperHz)}; peak{" "}
              {frequency(c.peakHz)}
            </li>
          ))}
        </ul>
        {group.componentCount > group.components.length && (
          <p>
            Showing the first {group.components.length} of{" "}
            {group.componentCount} components.
          </p>
        )}
      </div>
    </details>
  );
}
