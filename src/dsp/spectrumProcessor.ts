import { FFT_SIZE, SpectrumAccumulator } from "./spectrumMath";
import type { SpectrumKernel } from "./spectrumBackend";

export function spectrumWindowsPerAverage(sampleRateHz: number): number {
  return Math.max(4, Math.ceil(sampleRateHz * 0.04 / FFT_SIZE));
}

export interface ProcessorFrame {
  bins: Float32Array;
  droppedBefore: number;
  skippedSpectrumFramesBefore: number;
  sampleIndex: number;
  missingSamplesBefore: number;
}

/** Stateful block assembler and latest-only spectrum publisher used by the worker. */
export class SpectrumProcessor {
  private readonly accumulator: SpectrumKernel;
  private readonly pendingI = new Float32Array(FFT_SIZE);
  private readonly pendingQ = new Float32Array(FFT_SIZE);
  private pendingLength = 0;
  private publicationCredit = true;
  private lastPublicationMs = -Infinity;
  private droppedSincePublication = 0;
  private skippedSpectrumFramesSincePublication = 0;
  private sampleIndex = 0;
  private missingSamplesSincePublication = 0;

  constructor(accumulator: SpectrumKernel = new SpectrumAccumulator(), private readonly sampleClockCadence = false) {
    if (accumulator.size !== FFT_SIZE) throw new RangeError(`SpectrumProcessor requires ${FFT_SIZE} bins`);
    this.accumulator = accumulator;
  }

  dispose(): void { this.accumulator.dispose?.(); }

  reset(): void {
    this.pendingLength = 0;
    this.accumulator.reset();
    this.lastPublicationMs = -Infinity;
    this.droppedSincePublication = 0;
    this.skippedSpectrumFramesSincePublication = 0;
    this.publicationCredit = true;
    this.sampleIndex = 0;
    this.missingSamplesSincePublication = 0;
  }

  grantPublicationCredit(): void { this.publicationCredit = true; }

  accept(
    I: Float32Array,
    Q: Float32Array,
    nowMs: number,
    discontinuity = false,
    droppedInputBlocks = 0,
    droppedInputSamples = 0,
  ): ProcessorFrame[] {
    if (I.length !== Q.length) throw new RangeError("I and Q block lengths must match");
    if (discontinuity) {
      this.sampleIndex += this.pendingLength;
      this.missingSamplesSincePublication += this.pendingLength;
      this.pendingLength = 0;
      this.accumulator.reset();
    }
    this.sampleIndex += droppedInputSamples;
    this.missingSamplesSincePublication += droppedInputSamples;
    this.droppedSincePublication += droppedInputBlocks;
    const output: ProcessorFrame[] = [];
    let sourceOffset = 0;
    while (sourceOffset < I.length) {
      const count = Math.min(FFT_SIZE - this.pendingLength, I.length - sourceOffset);
      this.pendingI.set(I.subarray(sourceOffset, sourceOffset + count), this.pendingLength);
      this.pendingQ.set(Q.subarray(sourceOffset, sourceOffset + count), this.pendingLength);
      this.pendingLength += count;
      sourceOffset += count;
      if (this.pendingLength !== FFT_SIZE) continue;
      this.pendingLength = 0;
      this.sampleIndex += FFT_SIZE;
      const bins = this.accumulator.addWindow(this.pendingI, this.pendingQ);
      if (!bins) continue;
      if (!this.publicationCredit || (!this.sampleClockCadence && nowMs - this.lastPublicationMs < 40)) {
        this.droppedSincePublication += 1;
        this.skippedSpectrumFramesSincePublication += 1;
        continue;
      }
      this.publicationCredit = false;
      this.lastPublicationMs = nowMs;
      output.push({
        bins,
        droppedBefore: this.droppedSincePublication,
        skippedSpectrumFramesBefore: this.skippedSpectrumFramesSincePublication,
        sampleIndex: this.sampleIndex,
        missingSamplesBefore: this.missingSamplesSincePublication,
      });
      this.droppedSincePublication = 0;
      this.skippedSpectrumFramesSincePublication = 0;
      this.missingSamplesSincePublication = 0;
    }
    return output;
  }
}
