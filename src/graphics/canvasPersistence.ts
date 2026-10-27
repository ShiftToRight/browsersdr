import type { SpectrumFrame } from "../radio/types";
import { peakColumns, CANVAS_MAX_DIMENSION } from "./canvasSpectrum";
import {
  rgbCss,
  SPECTRUM_PALETTES,
  type SpectrumPalette,
} from "./spectrumPalette";
import {
  PersistenceHistory,
  PERSISTENCE_COLUMNS,
  PERSISTENCE_LEVELS,
} from "./persistenceHistory";

/** Occurrence, not power. Fixed cool→warm meaning across application themes. */
export function persistenceColor(
  fraction: number,
  ceiling = 1,
): readonly number[] {
  const stops = [
    [10, 40, 170],
    [0, 205, 235],
    [255, 222, 35],
    [255, 55, 20],
  ];
  const value = Math.sqrt(Math.max(0, Math.min(1, fraction / ceiling))) * 3;
  const index = Math.min(2, Math.floor(value)),
    mix = value - index;
  return stops[index]!.map((v, i) =>
    Math.round(v + (stops[index + 1]![i]! - v) * mix),
  );
}

/** Canvas2D uses the existing averaged FFT stream, with no extra FFT/readback. */
export class CanvasPersistence {
  readonly history: PersistenceHistory;
  private readonly bitmap = document.createElement("canvas");
  private readonly bitmapContext: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private paintedRevision = -1;
  private colourCeiling = -1;
  private palette?: SpectrumPalette;
  constructor(
    private readonly context: CanvasRenderingContext2D,
    history?: PersistenceHistory,
  ) {
    this.history = history ?? new PersistenceHistory();
    this.bitmap.width = PERSISTENCE_COLUMNS;
    this.bitmap.height = PERSISTENCE_LEVELS;
    const ctx = this.bitmap.getContext("2d");
    if (!ctx) throw new Error("Persistence bitmap is unavailable.");
    this.bitmapContext = ctx;
    this.image = ctx.createImageData(PERSISTENCE_COLUMNS, PERSISTENCE_LEVELS);
  }
  accept(frames: readonly SpectrumFrame[]): SpectrumFrame | undefined {
    let accepted: SpectrumFrame | undefined;
    for (const f of frames)
      if (this.history.accept(f)) accepted = this.history.latest;
    return accepted;
  }
  render(
    cssWidth: number,
    cssHeight: number,
    ratio: number,
    floor: number,
    range: number,
    palette = SPECTRUM_PALETTES.classic,
    guideHeight = 0,
  ): void {
    const canvas = this.context.canvas,
      ctx = this.context;
    const width = Math.min(
      CANVAS_MAX_DIMENSION,
      Math.max(1, Math.round(cssWidth * ratio)),
    );
    const height = Math.min(
      CANVAS_MAX_DIMENSION,
      Math.max(1, Math.round(cssHeight * ratio)),
    );
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    this.history.configure(
      floor,
      range,
      Number(canvas.dataset.persistenceWindow ?? 10),
    );
    const requestedCeiling = Number(
      canvas.dataset.persistenceColourCeiling ?? 0.5,
    );
    const ceiling = [0.05, 0.1, 0.25, 0.5, 1].includes(requestedCeiling)
      ? requestedCeiling
      : 0.5;
    if (
      this.paintedRevision !== this.history.revision ||
      this.colourCeiling !== ceiling ||
      palette !== this.palette
    ) {
      const bg = palette.background.map((v) => Math.round(v * 255));
      for (let y = 0; y < PERSISTENCE_LEVELS; y++)
        for (let x = 0; x < PERSISTENCE_COLUMNS; x++) {
          const n = this.history.observations[x]!,
            count = this.history.counts[y * PERSISTENCE_COLUMNS + x]!;
          const color = count && n ? persistenceColor(count / n, ceiling) : bg;
          const at =
            ((PERSISTENCE_LEVELS - 1 - y) * PERSISTENCE_COLUMNS + x) * 4;
          this.image.data[at] = color[0]!;
          this.image.data[at + 1] = color[1]!;
          this.image.data[at + 2] = color[2]!;
          this.image.data[at + 3] = 255;
        }
      this.bitmapContext.putImageData(this.image, 0, 0);
      this.paintedRevision = this.history.revision;
      this.colourCeiling = ceiling;
      this.palette = palette;
    }
    ctx.fillStyle = rgbCss(palette.background);
    ctx.fillRect(0, 0, width, height);
    const scale = height / Math.max(1, cssHeight);
    const top = height * 0.38 + guideHeight * scale + 30 * scale;
    const bottom = height - (cssWidth <= 600 ? 110 : 90) * scale;
    ctx.imageSmoothingEnabled = false;
    if (bottom > top) ctx.drawImage(this.bitmap, 0, top, width, bottom - top);
    ctx.strokeStyle = rgbCss(palette.trace);
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + ((bottom - top) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const latest = this.history.latest;
    if (latest) {
      const bins = peakColumns(
        latest.bins,
        Math.min(width, latest.bins.length),
      );
      ctx.strokeStyle = rgbCss(palette.trace);
      ctx.lineWidth = Math.max(1, width / Math.max(1, cssWidth));
      ctx.beginPath();
      for (let x = 0; x < bins.length; x++) {
        const px = (x / Math.max(1, bins.length - 1)) * width;
        const py =
          height *
          (0.375 -
            Math.max(0, Math.min(1, (bins[x]! - floor) / range)) * 0.335);
        if (x === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    canvas.dataset.persistenceFrames = String(this.history.count);
    canvas.dataset.persistenceDuration = this.history.duration.toFixed(3);
    canvas.dataset.persistenceGaps = String(this.history.gaps);
    canvas.dataset.persistenceLimited = String(this.history.limited);
  }
}
