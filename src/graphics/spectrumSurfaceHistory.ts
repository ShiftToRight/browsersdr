import type { SpectrumFrame } from "../radio/types";

export const SURFACE_COLUMNS = 1024;
export const SURFACE_ROWS = 512;
export const SURFACE_GAP = -10_000;
const ROWS_PER_SECOND = 25;

/** Display-only, peak-held source-time intervals. Owns all retained data.
 * Metadata: end time relative to context origin, valid flag, start time, reserved.
 * Gaps are separate invalid rows: the renderer never connects across them.
 */
export class SpectrumSurfaceHistory {
  readonly levels = new Float32Array(SURFACE_COLUMNS * SURFACE_ROWS).fill(SURFACE_GAP);
  readonly metadata = new Float32Array(SURFACE_ROWS * 4);
  nextRow = 0;
  count = 0;
  latestTime = 0;
  private context = "";
  private sequence = -1;
  private lastSample = -1;
  private origin = 0;
  private bucket = -1;
  private pendingGap = false;
  private generation = -1;
  private continuation?: number;

  reset(): void {
    this.context = ""; this.nextRow = this.count = 0;
    this.continuation = undefined; this.pendingGap = false;
  }
  /** Called only after a verified channel-only metadata change. Analysis resets
   * its sample clock: retain RF rows, rebase the next measured segment and leave
   * an invalid separator. Unknown tuning interruption time is not invented. */
  continueGeneration(generation: number): void {
    if (generation > this.generation) { this.continuation = generation; this.generation = generation; }
  }

  breakContinuity(): void { this.pendingGap = true; }

  accept(frame: SpectrumFrame): number[] {
    if (!Number.isSafeInteger(frame.sessionGeneration) || frame.sessionGeneration < this.generation ||
      !Number.isSafeInteger(frame.sequence) || !Number.isFinite(frame.sampleRateHz) || frame.sampleRateHz <= 0 ||
      !Number.isFinite(frame.centerFrequencyHz) || !Number.isSafeInteger(frame.sampleIndex) ||
      frame.sampleIndex < 0 || !frame.bins.length || frame.units !== "relative-dB") return [];
    const context = `${frame.sessionGeneration}:${frame.centerFrequencyHz}:${frame.sampleRateHz}:${frame.bins.length}`;
    if (this.context !== context && this.continuation === frame.sessionGeneration &&
      this.context.split(":").slice(1).join(":") === context.split(":").slice(1).join(":")) {
      this.origin = frame.sampleIndex - (this.latestTime + (frame.hopSamples ?? frame.bins.length * 4) / frame.sampleRateHz) * frame.sampleRateHz;
      this.context = context; this.generation = frame.sessionGeneration;
      this.sequence = this.lastSample = this.bucket = -1;
      this.pendingGap = this.count > 0;
      this.continuation = undefined;
    }
    if (this.context !== context) {
      this.generation = frame.sessionGeneration;
      this.context = context;
      this.nextRow = this.count = 0;
      this.sequence = this.lastSample = this.bucket = -1;
      this.origin = frame.sampleIndex;
      this.pendingGap = false; this.continuation = undefined;
    }
    if (frame.sequence <= this.sequence) return [];
    if (frame.sampleIndex < this.lastSample) {
      // A seek can retain a source context while moving its sample clock back.
      this.nextRow = this.count = 0;
      this.origin = frame.sampleIndex;
      this.bucket = -1;
      this.pendingGap = false;
    }
    const changed: number[] = [];
    const time = (frame.sampleIndex - this.origin) / frame.sampleRateHz;
    const hop = frame.hopSamples ?? frame.bins.length * 4;
    const gap = this.count > 0 && (this.pendingGap || frame.droppedFramesBefore > 0 ||
      (frame.missingSamplesBefore ?? 0) > 0 || frame.sampleIndex - this.lastSample > hop * 1.5);
    if (gap) {
      const row = this.push((this.latestTime + time) / 2, false);
      changed.push(row);
      this.bucket = -1;
    }
    const bucket = Math.floor(time * ROWS_PER_SECOND + 1e-7);
    const merge = this.count > 0 && this.bucket === bucket;
    const row = merge ? (this.nextRow + SURFACE_ROWS - 1) % SURFACE_ROWS : this.push(time, true);
    const offset = row * SURFACE_COLUMNS;
    for (let x = 0; x < SURFACE_COLUMNS; x++) {
      const start = Math.floor(x * frame.bins.length / SURFACE_COLUMNS);
      const end = Math.max(start + 1, Math.floor((x + 1) * frame.bins.length / SURFACE_COLUMNS));
      let peak = merge ? this.levels[offset + x]! : SURFACE_GAP;
      for (let i = start; i < end; i++) {
        const value = frame.bins[i];
        if (value !== undefined && Number.isFinite(value)) peak = Math.max(peak, value);
      }
      this.levels[offset + x] = peak;
    }
    this.metadata[row * 4] = time;
    if (!merge) this.metadata[row * 4 + 2] = Math.max(0, time - hop / frame.sampleRateHz);
    changed.push(row);
    this.bucket = bucket;
    this.latestTime = time;
    this.lastSample = frame.sampleIndex;
    this.sequence = frame.sequence;
    this.pendingGap = false;
    return changed;
  }

  duration(windowSeconds: number): number {
    if (!this.count) return 0;
    const oldest = (this.nextRow + SURFACE_ROWS - this.count) % SURFACE_ROWS;
    return Math.min(windowSeconds, Math.max(0, this.latestTime - this.metadata[oldest * 4]!));
  }

  /** Exclude off-window rows before issuing vertex work; retain all gap rows. */
  visibleRows(windowSeconds: number): number {
    let visible = 0;
    for (; visible < this.count; visible++) {
      const row = (this.nextRow + SURFACE_ROWS - 1 - visible) % SURFACE_ROWS;
      if (this.latestTime - this.metadata[row * 4]! > windowSeconds) break;
    }
    return visible;
  }

  private push(time: number, valid: boolean): number {
    const row = this.nextRow;
    this.metadata.set([time, valid ? 1 : 0, time, 0], row * 4);
    this.nextRow = (row + 1) % SURFACE_ROWS;
    this.count = Math.min(SURFACE_ROWS, this.count + 1);
    return row;
  }
}
