import { useEffect, useState, type RefObject } from "react";
import type { PersistenceHistory } from "./persistenceHistory";
import { PERSISTENCE_COLUMNS } from "./persistenceHistory";

export default function PersistenceHover({
  canvas,
  history,
  guideGap,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  history: RefObject<PersistenceHistory | undefined>;
  guideGap: number;
}) {
  const [preview, setPreview] = useState<
    | {
        x: number;
        y: number;
        frequency: string;
        level: string;
        occurrence: string;
      }
    | undefined
  >();
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    let pointer: { x: number; y: number } | undefined;
    let raf: number | undefined;
    const refresh = () => {
      if (!pointer) return;
      const bounds = node.getBoundingClientRect();
      const top = bounds.height * 0.38 + guideGap + 30;
      const bottom = bounds.height - (bounds.width <= 600 ? 110 : 90);
      const h = history.current,
        latest = h?.latest;
      if (
        !h ||
        !latest ||
        bottom <= top ||
        pointer.y < top ||
        pointer.y > bottom
      ) {
        setPreview(undefined);
        return;
      }
      const column = Math.min(
        PERSISTENCE_COLUMNS - 1,
        Math.max(
          0,
          Math.floor((pointer.x / bounds.width) * PERSISTENCE_COLUMNS),
        ),
      );
      // Read scale from the matching displayed axis; values are retained by the
      // model and inspected as a level bin, never inferred from pixel colour.
      const levelFraction = 1 - (pointer.y - top) / (bottom - top);
      const sample = h.inspectColumn(column, levelFraction);
      if (!sample) {
        setPreview(undefined);
        return;
      }
      const low =
        latest.centerFrequencyHz +
        (column / PERSISTENCE_COLUMNS - 0.5) * latest.sampleRateHz;
      const high = low + latest.sampleRateHz / PERSISTENCE_COLUMNS;
      const percent = sample.fraction * 100;
      setPreview({
        x: Math.max(8, Math.min(bounds.width - 258, pointer.x + 12)),
        y: Math.max(top, Math.min(bottom - 76, pointer.y - 80)),
        frequency: `${(low / 1e6).toFixed(3)}–${(high / 1e6).toFixed(3)} MHz`,
        level: `${sample.low.toFixed(1)}…${sample.high.toFixed(1)} dB rel.`,
        occurrence: `${percent > 0 && percent < 0.1 ? "<0.1" : percent.toFixed(1)}% of ${sample.observations} observed spectra`,
      });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const b = node.getBoundingClientRect();
      pointer = { x: event.clientX - b.left, y: event.clientY - b.top };
      if (raf === undefined)
        raf = requestAnimationFrame(() => {
          raf = undefined;
          refresh();
        });
    };
    const hide = () => {
      pointer = undefined;
      setPreview(undefined);
    };
    const timer = setInterval(refresh, 250);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", hide);
    window.addEventListener("pointerdown", hide);
    return () => {
      clearInterval(timer);
      if (raf !== undefined) cancelAnimationFrame(raf);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", hide);
      window.removeEventListener("pointerdown", hide);
    };
  }, [canvas, history, guideGap]);
  if (!preview) return null;
  return (
    <div
      className="persistence-hover"
      role="tooltip"
      style={{ left: preview.x, top: preview.y }}
    >
      <strong>{preview.frequency}</strong>
      <span>{preview.level}</span>
      <span>{preview.occurrence}</span>
    </div>
  );
}
