import { describe, expect, it } from "vitest";
import { frequencyForPixel } from "../dsp/frequencyScale";
import type { SpectrumFrame } from "../radio/types";
import { WaterfallHistory } from "./waterfallHistory";

function frame(sequence: number, generation = 4, sampleIndex = (sequence + 1) * 16_384): SpectrumFrame {
  return {
    sessionGeneration: generation,
    sequence,
    timestampMs: 1_000 + sequence,
    sampleIndex,
    centerFrequencyHz: 100_000_000,
    sampleRateHz: 1_024_000,
    units: "relative-dB",
    bins: new Float32Array(4096).fill(sequence),
    droppedFramesBefore: 0,
  };
}

describe("waterfall history", () => {
  it("uses the experimental FFT size for the sample clock", () => {
    const history = new WaterfallHistory(8, 16384);
    history.reset(4);
    history.append(frame(0, 4, 65536));
    expect(history.append(frame(1, 4, 131072)).map(row => row.kind)).toEqual(["spectrum"]);
    expect(history.append(frame(2, 4, 262144)).map(row => row.kind)).toEqual(["gap", "spectrum"]);
  });
  it("keeps newest-to-oldest circular ordering without moving prior rows", () => {
    const history = new WaterfallHistory(3);
    history.reset(4);
    expect(history.append(frame(0)).map((row) => row.row)).toEqual([0]);
    expect(history.append(frame(1)).map((row) => row.row)).toEqual([1]);
    expect(history.append(frame(2)).map((row) => row.row)).toEqual([2]);
    expect(history.append(frame(3)).map((row) => row.row)).toEqual([0]);
    expect(history.newestFirst()).toEqual([0, 2, 1]);
  });

  it("uses the source sample clock to insert visible gap rows", () => {
    const history = new WaterfallHistory(8);
    history.reset(4);
    history.append(frame(0));
    const rows = history.append(frame(3, 4, 65_536));
    expect(rows.map((row) => row.kind)).toEqual(["gap", "gap", "spectrum"]);
  });

  it("rejects stale generations and out-of-order frames after retune", () => {
    const history = new WaterfallHistory(4);
    history.reset(5);
    expect(history.append(frame(8, 4))).toEqual([]);
    expect(history.append(frame(0, 5))).toHaveLength(1);
    expect(history.append(frame(0, 5))).toEqual([]);
    history.reset(6);
    expect(history.state).toEqual({ nextWriteRow: 0, count: 0 });
  });
});

describe("frequency mapping", () => {
  it("maps left, center and right pixels to the visible RF span", () => {
    expect(frequencyForPixel(0, 1000, 100_000_000, 1_024_000)).toBe(99_488_000);
    expect(frequencyForPixel(500, 1000, 100_000_000, 1_024_000)).toBe(100_000_000);
    expect(frequencyForPixel(1000, 1000, 100_000_000, 1_024_000)).toBe(100_512_000);
  });
});
