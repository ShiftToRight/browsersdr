import { useEffect, useRef, useState, type RefObject } from "react";
import { formatFrequencyMHz } from "../ui/frequencyFormat";
import { sampleSpectrumTrace, type HoverSpectrumFrame } from "./spectrumHoverMath";
import "./SpectrumHover.css";

export function SpectrumHover({ canvas, frame, guideGap, selectedHz, paused, stalled, traceOnly = false, traceFraction = .38 }: {
  canvas: RefObject<HTMLCanvasElement | null>;
  frame: RefObject<HoverSpectrumFrame | undefined>;
  guideGap: number;
  selectedHz: number;
  paused: boolean;
  stalled: boolean;
  traceOnly?: boolean;
  traceFraction?: number;
}) {
  const readoutRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    x: number; y?: number; frequency: number; level?: number;
    waterfall: boolean; width: number; height: number; readoutHeight: number; readoutWidth: number;
  }>();
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    let pointer: { x: number; y: number } | undefined;
    let animation: number | undefined;
    let coordinates: string | undefined;
    const hide = () => {
      pointer = undefined;
      coordinates = undefined;
      if (animation !== undefined) cancelAnimationFrame(animation);
      animation = undefined;
      setPreview(undefined);
    };
    const update = () => {
      animation = undefined;
      const data = frame.current;
      if (!pointer || !data || document.visibilityState === "hidden") { hide(); return; }
      const key = `${data.center}:${data.rate}`;
      if (coordinates && coordinates !== key) { hide(); return; }
      coordinates = key;
      const bounds = node.getBoundingClientRect();
      const x = pointer.x - bounds.left, y = pointer.y - bounds.top;
      const guideStart = bounds.height * traceFraction;
      if (traceOnly && y >= guideStart) { hide(); return; }
      if (bounds.width <= 0 || bounds.height <= 0 || x < 0 || x > bounds.width || y < 0 || y > bounds.height ||
        (guideGap > 0 && y >= guideStart && y < guideStart + guideGap)) { hide(); return; }
      const fraction = x / bounds.width;
      const sample = sampleSpectrumTrace(data, fraction);
      setPreview({ x, y: sample ? sample.y * bounds.height : undefined,
        frequency: data.center + (fraction - 0.5) * data.rate,
        level: sample?.level, waterfall: y >= guideStart + guideGap,
        width: bounds.width, height: bounds.height, readoutHeight: readoutRef.current?.offsetHeight || 132,
        readoutWidth: readoutRef.current?.offsetWidth || 205 });
      animation = requestAnimationFrame(update);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.buttons) { hide(); return; }
      pointer = { x: event.clientX, y: event.clientY };
      if (animation === undefined) animation = requestAnimationFrame(update);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", hide);
    node.addEventListener("pointerdown", hide);
    node.addEventListener("pointercancel", hide);
    return () => {
      if (animation !== undefined) cancelAnimationFrame(animation);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("pointerdown", hide);
      node.removeEventListener("pointercancel", hide);
    };
  }, [canvas, frame, guideGap, traceOnly, traceFraction]);
  if (!preview) return null;
  const offset = (preview.frequency - selectedHz) / 1000;
  const width = Math.min(preview.readoutWidth, preview.width - 16);
  const left = Math.max(8, Math.min(preview.width - width - 8,
    preview.x + width + 20 < preview.width ? preview.x + 16 : preview.x - width - 16));
  const top = Math.max(8, Math.min(preview.height - preview.readoutHeight - 8,
    (preview.y ?? 80) - preview.readoutHeight - 12));
  return <div className="spectrum-hover" aria-hidden="true">
    <span className="spectrum-hover-line" style={{ left: preview.x }} />
    {preview.y !== undefined && <>
      <span className="spectrum-hover-level" style={{ top: preview.y, width: preview.x }} />
      <span className="spectrum-hover-dot" style={{ left: preview.x, top: preview.y }} />
    </>}
    <div ref={readoutRef} className="spectrum-hover-readout" style={{ left, top, maxWidth: preview.width - 16 }}>
      <strong>{formatFrequencyMHz(preview.frequency)} MHz{paused || stalled ? <small> · {paused ? "Paused" : "Stale"}</small> : null}</strong>
      {preview.waterfall && <span className="spectrum-hover-source">Latest spectrum level</span>}
      <span>{preview.waterfall ? "" : "Level "}{preview.level === undefined ? "Unavailable" : `${Math.round(preview.level)} dB rel.`}</span>
      <span>Offset {offset >= 0 ? "+" : ""}{offset.toFixed(1)} kHz</span>
    </div>
  </div>;
}
