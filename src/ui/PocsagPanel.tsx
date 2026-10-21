import { pocsagExport, pocsagJson } from "../radio/pocsagExport";
function download(receiver: ReceiverSnapshot, format: "txt" | "json"): void {
  const data = pocsagExport(receiver);
  if (!data) return;
  const text =
    format === "json"
      ? pocsagJson(data)
      : `${data.scope}\n${data.clock}\n\n${data.snapshot.messages.map((m) => `${m.rate} bit/s · RIC ${m.address ?? "unknown"} · function ${m.function ?? "unknown"} · ${m.complete ? "complete framing" : "partial"} · ${m.ending}\nInput samples ${m.provenance.firstInputSampleIndex}–${m.provenance.lastInputSampleIndex} · ${m.correctedBits} corrected bits\n${m.text}${m.displayTruncated ? "\n[Display truncated; raw payload retained in JSON]" : ""}`).join("\n\n")}`;
  const url = URL.createObjectURL(
    new Blob([text], {
      type: format === "json" ? "application/json" : "text/plain;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `browsersdr-pocsag-${Date.now()}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
import type { ReceiverSnapshot } from "../radio/receiverController";
export function PocsagPanel({ receiver }: { receiver: ReceiverSnapshot }) {
  const data = receiver.pocsag;
  return (
    <section aria-label="POCSAG reception">
      <h3>POCSAG reception</h3>
      <p role="status">
        {data?.state ?? "Ready"} ·{" "}
        {data?.detectedRate
          ? `${data.detectedRate} bit/s · ${data.polarity}`
          : "Searching for 512 / 1200 / 2400 bit/s"}
      </p>
      {data?.inProgress && (
        <div>
          <strong>
            In progress · RIC {data.inProgress.address ?? "unknown"}
          </strong>
          <pre>
            {data.inProgress.text || "Address received; waiting for payload"}
          </pre>
          {data.inProgress.displayTruncated && (
            <small>Display truncated; raw payload retained.</small>
          )}
        </div>
      )}
      <p>
        {data?.counters.complete ?? 0} complete framing ·{" "}
        {data?.counters.partial ?? 0} partial ·{" "}
        {data?.counters.correctedMessages ?? 0} corrected messages ·{" "}
        {data?.counters.rejectedWords ?? 0} rejected words ·{" "}
        {data?.counters.gaps ?? 0} input gaps
      </p>
      <div className="button-row">
        <button
          type="button"
          disabled={!pocsagExport(receiver)}
          onClick={() => download(receiver, "txt")}
        >
          Export POCSAG text
        </button>
        <button
          type="button"
          disabled={!pocsagExport(receiver)}
          onClick={() => download(receiver, "json")}
        >
          Export POCSAG data (JSON)
        </button>
      </div>
      <p>
        Latest retained messages are available in Decoder. Addresses and message
        content do not establish transmitter identity.
      </p>
    </section>
  );
}
