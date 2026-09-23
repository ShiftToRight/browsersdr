import type { SpectrumFrame } from "../radio/types";

export interface GpuInputBlock {
  I: Float32Array; Q: Float32Array; sessionGeneration: number;
  /** Absolute source position at block start, including declared missing samples. */
  sampleIndex?: number;
  centerFrequencyHz: number; sampleRateHz: number; discontinuity: boolean; missingSamples: number;
}

/** Fixed four-window staging and at most one upload/compute/render submission in flight.
 * Copies borrowed raw samples synchronously before the audio demodulator mutates them.
 */
export class GpuAnalysisTap {
  private readonly input: Float32Array;
  private readonly emptyBins = new Float32Array(0);
  private length = 0;
  private sampleIndex = 0;
  private sequence = 0;
  private dropped = 0;
  private busy = false;
  private disposed = false;
  private lastMs = -Infinity;
  constructor(readonly size: number, private readonly generation: number,
    private readonly submit: (input: Float32Array, frame: SpectrumFrame) => Promise<void>,
    private readonly fail: (error: unknown) => void) {
    this.input = new Float32Array(size * 8);
  }
  accept(block: GpuInputBlock, now = performance.now()): void {
    if (this.disposed || block.sessionGeneration !== this.generation) return;
    if (block.sampleIndex !== undefined && block.sampleIndex !== this.sampleIndex) {
      this.length = 0; this.dropped++;
    }
    if (block.sampleIndex !== undefined) this.sampleIndex = block.sampleIndex;
    if (block.discontinuity) {
      this.length = 0;
      if (block.sampleIndex === undefined) this.sampleIndex += block.missingSamples;
      this.dropped++;
    }
    const count = Math.min(block.I.length, block.Q.length);
    if (this.busy || now - this.lastMs < 40) {
      this.sampleIndex += count; this.length = 0; this.dropped++; return;
    }
    for (let k = 0; k < count; k++) {
      this.input[2 * this.length] = block.I[k]!;
      this.input[2 * this.length + 1] = block.Q[k]!;
      this.length++; this.sampleIndex++;
      if (this.length !== this.size * 4) continue;
      this.length = 0; this.busy = true; this.lastMs = now;
      const frame: SpectrumFrame = {
        sessionGeneration: this.generation, sequence: this.sequence++, timestampMs: now,
        sampleIndex: this.sampleIndex, centerFrequencyHz: block.centerFrequencyHz,
        sampleRateHz: block.sampleRateHz, units: "relative-dB", bins: this.emptyBins,
        droppedFramesBefore: this.dropped,
      };
      this.dropped = 0;
      // submit uploads synchronously; the borrowed source is never retained.
      try {
        void this.submit(this.input, frame).then(() => { this.busy = false; }, (error) => {
          if (!this.disposed) { this.dispose(); this.fail(error); }
        });
      } catch (error) { this.dispose(); this.fail(error); }
      const remaining = count - k - 1;
      this.sampleIndex += remaining;
      if (remaining) this.dropped++;
      return;
    }
  }
  dispose(): void { this.disposed = true; this.length = 0; }
}
