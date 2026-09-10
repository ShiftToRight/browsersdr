import { FFT_SIZE } from "../dsp/spectrumMath";
import type { SpectrumFrame } from "../radio/types";

export type WaterfallRow = { row: number; kind: "spectrum" | "gap"; bins?: Float32Array };

/** Pure circular-history policy shared by the renderer and numerical tests. */
export class WaterfallHistory {
  private writeRow = 0;
  private count = 0;
  private generation = 0;
  private lastSequence = -1;
  private lastSampleIndex?: number;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be positive");
  }

  reset(sessionGeneration: number): void {
    this.writeRow = 0;
    this.count = 0;
    this.generation = sessionGeneration;
    this.lastSequence = -1;
    this.lastSampleIndex = undefined;
  }

  append(frame: SpectrumFrame): WaterfallRow[] {
    if (frame.sessionGeneration !== this.generation || frame.sequence <= this.lastSequence) return [];
    const rows: WaterfallRow[] = [];
    if (this.lastSampleIndex !== undefined) {
      const averagedFrameSamples = FFT_SIZE * 4;
      const missingByClock = Math.max(0, Math.round((frame.sampleIndex - this.lastSampleIndex) / averagedFrameSamples) - 1);
      const missing = Math.min(this.capacity - 1, Math.max(missingByClock, frame.droppedFramesBefore > 0 ? 1 : 0));
      for (let index = 0; index < missing; index += 1) rows.push(this.push("gap"));
    }
    rows.push(this.push("spectrum", frame.bins));
    this.lastSequence = frame.sequence;
    this.lastSampleIndex = frame.sampleIndex;
    return rows;
  }

  get state(): Readonly<{ nextWriteRow: number; count: number }> {
    return { nextWriteRow: this.writeRow, count: this.count };
  }

  /** Returns physical row indices from newest to oldest. */
  newestFirst(): number[] {
    return Array.from({ length: this.count }, (_, age) => (this.writeRow + this.capacity - 1 - age) % this.capacity);
  }

  private push(kind: WaterfallRow["kind"], bins?: Float32Array): WaterfallRow {
    const row = this.writeRow;
    this.writeRow = (this.writeRow + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    return { row, kind, bins };
  }
}
