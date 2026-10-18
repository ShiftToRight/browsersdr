import { useEffect, useRef } from "react";
import type { SpectrumFrame } from "../radio/types";

export class GuestFrames {
  private listeners = new Set<(frame?: SpectrumFrame) => void>();
  emit(frame?: SpectrumFrame): void { for (const listener of this.listeners) listener(frame); }
  subscribe(listener: (frame?: SpectrumFrame) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
export function GuestSpectrum({ frames }: { frames: GuestFrames }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!, context = element.getContext("2d");
    if (!context) return;
    const width = 1024, height = 360, plot = 135, capacity = 240;
    const bitmap = document.createElement("canvas"); bitmap.width = width; bitmap.height = capacity;
    const history = bitmap.getContext("2d")!;
    const paletteCanvas = document.createElement("canvas"); paletteCanvas.width = 256; paletteCanvas.height = 1;
    const paletteContext = paletteCanvas.getContext("2d")!, gradient = paletteContext.createLinearGradient(0, 0, 256, 0);
    gradient.addColorStop(0, "#081321"); gradient.addColorStop(.4, "#24327c"); gradient.addColorStop(.7, "#12bacc"); gradient.addColorStop(1, "#ffe5a0");
    paletteContext.fillStyle = gradient; paletteContext.fillRect(0, 0, 256, 1);
    const colors = paletteContext.getImageData(0, 0, 256, 1).data, row = history.createImageData(width, 1);
    const times = new Float64Array(capacity);
    let generation = -1, center = -1, rate = -1, latest: SpectrumFrame | undefined;
    let animation = 0, next = 0, count = 0, dirty = true;
    const clear = () => {
      latest = undefined; count = 0; next = 0; generation = -1; dirty = true;
      element.dataset.historyRows = "0"; element.dataset.historySeconds = "0";
    };
    const unsubscribe = frames.subscribe(frame => {
      if (!frame) { clear(); return; }
      if (generation !== frame.sessionGeneration || center !== frame.centerFrequencyHz || rate !== frame.sampleRateHz) {
        clear(); generation = frame.sessionGeneration; center = frame.centerFrequencyHz; rate = frame.sampleRateHz;
      }
      latest = frame;
      const gap = frame.droppedFramesBefore > 0 || (frame.missingSamplesBefore ?? 0) > 0;
      for (let x = 0; x < width; x++) {
        const color = Math.round(Math.max(0, Math.min(255, ((frame.bins[x] ?? -160) + 105) * 255 / 90)));
        const offset = x * 4;
        if (gap) { row.data[offset] = 76; row.data[offset + 1] = 66; row.data[offset + 2] = 80; }
        else row.data.set(colors.subarray(color * 4, color * 4 + 3), offset);
        row.data[offset + 3] = 255;
      }
      history.putImageData(row, 0, next); times[next] = frame.sampleIndex / frame.sampleRateHz;
      next = (next + 1) % capacity; count = Math.min(capacity, count + 1); dirty = true;
    });
    const draw = () => {
      animation = requestAnimationFrame(draw);
      if (!dirty) return; dirty = false;
      context.fillStyle = "#081321"; context.fillRect(0, 0, width, height);
      const frame = latest;
      if (!frame) { context.fillStyle = "#b3c5d8"; context.font = "18px sans-serif"; context.fillText("Waiting for host RF spectrum", 24, 65); return; }
      // Stretch only retained measurements into the available height, like the
      // local display. No synthetic history is inserted while a guest joins.
      const first = (next - count + capacity) % capacity, firstRows = Math.min(count, capacity - first), rowHeight = (height - plot) / count;
      context.save(); context.translate(0, height); context.scale(1, -1); context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, first, width, firstRows, 0, 0, width, firstRows * rowHeight);
      if (count > firstRows) context.drawImage(bitmap, 0, 0, width, count - firstRows, 0, firstRows * rowHeight, width, (count - firstRows) * rowHeight);
      context.restore();
      const span = Math.max(0, frame.sampleIndex / frame.sampleRateHz - times[first]!);
      element.dataset.historyRows = String(count); element.dataset.historySeconds = String(span);
      context.strokeStyle = "#66d6d1"; context.lineWidth = 1.5; context.beginPath();
      for (let x = 0; x < width; x++) {
        const normalized = Math.max(0, Math.min(1, ((frame.bins[x] ?? -160) + 105) / 90)), y = 12 + (1 - normalized) * (plot - 44);
        if (x) context.lineTo(x, y); else context.moveTo(x, y);
      }
      context.stroke(); context.fillStyle = "#b3c5d8"; context.font = "14px sans-serif";
      context.textAlign = "left"; context.fillText(`${((center - rate / 2) / 1e6).toFixed(4)} MHz`, 8, plot - 8);
      context.textAlign = "center"; context.fillText(`${(center / 1e6).toFixed(4)} MHz · dB rel.`, width / 2, plot - 8);
      context.textAlign = "right"; context.fillText(`${((center + rate / 2) / 1e6).toFixed(4)} MHz`, width - 8, plot - 8);
      context.textAlign = "left"; context.fillText(`Received history: ${span.toFixed(1)} s · newest at top`, 8, height - 8);
    };
    animation = requestAnimationFrame(draw);
    return () => { unsubscribe(); cancelAnimationFrame(animation); };
  }, [frames]);
  return <canvas ref={canvas} width={1024} height={360} role="img" aria-label="Shared host RF spectrum and waterfall, relative power" />;
}
