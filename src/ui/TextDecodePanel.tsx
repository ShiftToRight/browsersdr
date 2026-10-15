import type { ReceiverSnapshot } from "../radio/receiverController";
import { textModemExport } from "../radio/textModemExport";
import type { TextMode } from "../textmodem/settings";
import { isImageMode } from "../textmodem/settings";
import { lazy, Suspense } from "react";
const ImageDecodePanel = lazy(() => import("./ImageDecodePanel").then(module => ({ default: module.ImageDecodePanel })));
function download(receiver: ReceiverSnapshot, format: "txt" | "json"): void {
  const data = textModemExport(receiver);
  if (!data) return;
  const text =
    format === "json"
      ? JSON.stringify(data, null, 2)
      : `${data.snapshot.mode} · ${data.acquisition.selectedChannelFrequencyHz} Hz\n${data.clock}\n\n${data.snapshot.text}\n\n${data.snapshot.messages.map((message) => `${message.header || message.address || "Text segment"} · ${message.integrity}\nInput samples ${message.provenance.firstInputSampleIndex}–${message.provenance.lastInputSampleIndex}\n${message.text}`).join("\n\n")}`;
  const url = URL.createObjectURL(
    new Blob([text], {
      type: format === "json" ? "application/json" : "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `browsersdr-${data.snapshot.mode.toLowerCase()}-${Date.now()}.${format}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function TextDecodePanel({
  receiver,
  mode,
}: {
  receiver: ReceiverSnapshot;
  mode: TextMode;
}) {
  const state =
    receiver.textModem?.mode === mode ? receiver.textModem : undefined;
  const worker = receiver.textModemWorker;
  if (isImageMode(mode)) return <Suspense fallback={<p role="status">Loading image decoder…</p>}><ImageDecodePanel receiver={receiver} mode={mode} /></Suspense>;
  return (
    <div className="text-decode-panel" aria-label={`${mode} decoded text`}>
      <h4>
        {receiver.lifecycle === "running" ? "Live" : "Retained"} text &amp;
        tuning
      </h4>
      <p className="support-copy">
        {mode === "CW-TEXT" ? "Tentative Morse transcription alongside CW audio. Speed and threshold are adjustable; noise, fading and hand-sent timing can produce errors. No checksum or language guessing."
          : mode === "ACARS"
          ? "CRC and odd parity are required. Reported aircraft addresses are message fields; they are not linked to ADS-B targets."
          : mode === "NAVTEX"
            ? "CCIR476 phasing and delayed-copy FEC. Erasures remain visible; a complete message requires ZCZC/header and NNNN. No message CRC."
            : "Received text is tentative: this protocol has no checksum. Framing or Varicode alone cannot prove correct content."}
      </p>
      <dl className="session-grid">
        <div>
          <dt>Decoder</dt>
          <dd>{state?.status ?? "not started"}</dd>
        </div>
        <div>
          <dt>Characters</dt>
          <dd>{state?.counters.characters ?? 0}</dd>
        </div>
        <div>
          <dt>
            {mode === "ACARS" ? "Valid blocks" : "Text segments / messages"}
          </dt>
          <dd>{state?.counters.accepted ?? 0}</dd>
        </div>
        <div>
          <dt>Framing / integrity errors</dt>
          <dd>{state?.counters.framingErrors ?? 0}</dd>
        </div>
        <div>
          <dt>FEC recoveries</dt>
          <dd>{state?.counters.corrected ?? 0}</dd>
        </div>
        <div>
          <dt>Dropped input blocks</dt>
          <dd>{worker?.droppedInputBlocks ?? 0}</dd>
        </div>
        <div>
          <dt>Discontinuities</dt>
          <dd>{state?.counters.discontinuities ?? 0}</dd>
        </div>
        {mode !== "ACARS" && (
          <div>
            <dt>Detector confidence</dt>
            <dd>{Math.round((state?.confidence ?? 0) * 100)}% · relative</dd>
          </div>
        )}
        {state?.markHz !== null && state?.markHz !== undefined && (
          <>
            <div>
              <dt>Mark relative to channel</dt>
              <dd>{state.markHz} Hz</dd>
            </div>
            <div>
              <dt>Space relative to channel</dt>
              <dd>{state.spaceHz} Hz</dd>
            </div>
          </>
        )}
        {mode === "PSK31" && (
          <div>
            <dt>Carrier correction</dt>
            <dd>{(state?.frequencyErrorHz ?? 0).toFixed(1)} Hz</dd>
          </div>
        )}
      </dl>
      {mode === "CW-TEXT" && <p className="support-copy">Timing estimate: {(state?.cwWpm ?? state?.settings.cw?.wpm ?? 20).toFixed(1)} WPM · relative detector confidence, not text correctness.</p>}
      <pre className="decoded-text-output" aria-label="Received text">
        {state?.text || "Waiting for decoded text…"}
      </pre>
      <p className="support-copy">
        Retains the last 8,192 characters and 16 messages, up to 4,096
        characters each. Results use the decoder input clock. Reception is
        receive only.
      </p>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={!state}
          onClick={() => download(receiver, "txt")}
        >
          Export text
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!state}
          onClick={() => download(receiver, "json")}
        >
          Export modem JSON
        </button>
      </div>
    </div>
  );
}
