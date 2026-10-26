import { InstrumentRange } from "./InstrumentRange";
import { useEffect, useRef, useState } from "react";
import type { ReceiverSnapshot } from "../radio/receiverController";
import type { ReceivedImage } from "../textmodem/imageTypes";
import { textModemExport } from "../radio/textModemExport";

function draw(canvas: HTMLCanvasElement, image: ReceivedImage, alignment: number, slant: number): void {
  const context = canvas.getContext("2d");
  if (!context || !image.rows) return;
  canvas.width = image.width; canvas.height = image.rows;
  const output = context.createImageData(image.width, image.rows);
  for (let y = 0; y < image.rows; y++) {
    const shift = Math.round(alignment * image.width / 100 + y * image.width * slant / 1_000_000);
    for (let x = 0; x < image.width; x++) {
      const sourceX = ((x + shift) % image.width + image.width) % image.width;
      const source = (y * image.width + sourceX) * image.channels;
      const target = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) output.data[target + c] = image.pixels[source + (image.channels === 1 ? 0 : c)]!;
      output.data[target + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
}
function save(blob: Blob, extension: string, mode: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `browsersdr-${mode.toLowerCase()}-${Date.now()}.${extension}`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function ImageDecodePanel({ receiver, mode }: { receiver: ReceiverSnapshot; mode: "WEFAX" | "SSTV" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [alignment, setAlignment] = useState(0), [slant, setSlant] = useState(0);
  const state = receiver.textModem?.mode === mode ? receiver.textModem : undefined;
  const image = state?.image?.id === receiver.modemImage?.id ? receiver.modemImage : undefined;
  const rows = image?.rows ?? 0;
  useEffect(() => { if (canvas.current && image) draw(canvas.current, image, alignment, slant); }, [image, rows, alignment, slant]);
  const metadata = () => ({ ...textModemExport(receiver), image: image ? { ...state?.image, receivedRows: rows } : null, displayCorrection: { alignmentPercent: alignment, slantPpm: slant, appliedToPng: true }, pixelData: "PNG is exported separately; no pixels embedded in metadata JSON." });
  return <section className="image-decode-panel" aria-label={`${mode} decoded image`}>
    <h4>{receiver.lifecycle === "running" ? "Live" : "Retained"} image</h4>
    <p className="support-copy">{mode === "WEFAX" ? "Weather fax grayscale · automatic APT/phasing or manual start. Tune the USB dial frequency; image tones are centered 1,900 Hz above it." : "SSTV Martin M1/M2 · automatic VIS parity check or a manual Martin mode. Tune the USB dial frequency; image tones are 1,500–2,300 Hz above it."} Image synchronization does not verify content or transmitter identity.</p>
    <dl className="session-grid">
      <div><dt>Image decoder</dt><dd>{state?.decoderStage ?? "not started"}</dd></div>
      <div><dt>Received rows</dt><dd>{rows}{image ? ` / ${image.height}` : ""}</dd></div>
      <div><dt>Image format</dt><dd>{image ? `${image.mode} · ${image.width} pixels wide` : "Waiting for image"}</dd></div>
      <div><dt>Completion</dt><dd>{image?.reason ?? "No image yet"}</dd></div>
      <div><dt>Dropped input blocks</dt><dd>{receiver.textModemWorker?.droppedInputBlocks ?? 0}</dd></div>
      <div><dt>Discontinuities</dt><dd>{state?.counters.discontinuities ?? 0}</dd></div>
    </dl>
    <div className="image-decoder-canvas-wrap" hidden={!rows}><canvas ref={canvas} role="img" aria-label={`Decoded ${image?.mode ?? "image"}, ${rows} received rows`} /></div>
    {!rows && <p role="status">Waiting for decoded image rows…</p>}
    <div className="image-corrections">
      <label>Image alignment (%)<InstrumentRange aria-label="Image alignment"  min={-50} max={50} step={0.1} value={alignment} onChange={event => setAlignment(Number(event.target.value))} /><output>{alignment.toFixed(1)}%</output></label>
      <label>Image slant correction (ppm)<input aria-label="Image slant correction" type="number" min={-5000} max={5000} step={10} value={slant} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 5000) setSlant(value); }} /></label>
      <button type="button" className="secondary" onClick={() => { setAlignment(0); setSlant(0); }}>Reset image correction</button>
    </div>
    <p className="support-copy">Keeps one bounded image: weather fax up to 2,048 rows; SSTV one 256-row Martin frame. A gap ends the partial image. PNG includes only received rows and the display corrections; JSON retains decoder input-clock provenance. Export before starting another image.</p>
    <div className="button-row">
      <button type="button" className="secondary" disabled={!rows} onClick={() => { if (canvas.current && image) { draw(canvas.current, image, alignment, slant); canvas.current.toBlob(blob => { if (blob) save(blob, "png", state!.mode); }, "image/png"); } }}>Export PNG</button>
      <button type="button" className="secondary" disabled={!image} onClick={() => save(new Blob([JSON.stringify(metadata(), null, 2)], { type: "application/json" }), "json", state!.mode)}>Export image metadata</button>
    </div>
  </section>;
}
