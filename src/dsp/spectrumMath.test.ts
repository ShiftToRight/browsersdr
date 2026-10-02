import { describe, expect, it } from "vitest";
import { SyntheticComplexTone } from "../testing/syntheticTone";
import { shiftedBinForOffset, spectrumEdges } from "./frequencyScale";
import { FFT_SIZE, SPECTRUM_FLOOR_DB, SpectrumAccumulator } from "./spectrumMath";
import { SpectrumProcessor, spectrumWindowsPerAverage } from "./spectrumProcessor";

const SAMPLE_RATE = 1_024_000;

function spectrumForTone(offsetHz: number, amplitude: number): Float32Array {
  const tone = new SyntheticComplexTone({ sampleRateHz: SAMPLE_RATE, toneOffsetHz: offsetHz, amplitude });
  const accumulator = new SpectrumAccumulator();
  let result: Float32Array | undefined;
  for (let index = 0; index < 4; index += 1) {
    const block = tone.generate(FFT_SIZE);
    result = accumulator.addWindow(block.I, block.Q);
  }
  if (!result) throw new Error("Spectrum was not produced");
  return result;
}

function peakBin(bins: Float32Array): number {
  let peak = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if ((bins[index] ?? -Infinity) > (bins[peak] ?? -Infinity)) peak = index;
  }
  return peak;
}

describe("RF spectrum analysis", () => {
  it.each([1_024_000, 2_400_000, 4_800_000])("averages continuous %d Hz input at a bounded source-clock display cadence", rate => {
    const windows = spectrumWindowsPerAverage(rate);
    const processor = new SpectrumProcessor(new SpectrumAccumulator(FFT_SIZE, windows), true);
    const tone = new SyntheticComplexTone({ sampleRateHz: rate, toneOffsetHz: rate / 16, amplitude: 0.5 });
    for (let row = 0; row < 3; row++) {
      const data = tone.generate(windows * FFT_SIZE);
      const frames = processor.accept(data.I, data.Q, 0);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ sampleIndex: (row + 1) * windows * FFT_SIZE, droppedBefore: 0, skippedSpectrumFramesBefore: 0, missingSamplesBefore: 0 });
      expect(frames[0]!.bins[FFT_SIZE / 2 + FFT_SIZE / 16]).toBeCloseTo(-6.0206, 2);
      processor.grantPublicationCredit();
    }
    expect(windows * FFT_SIZE / rate).toBeGreaterThanOrEqual(0.04);
    expect(windows * FFT_SIZE / rate).toBeLessThan(0.045);
  });
  it.each([128_000, -192_000])("places a %d Hz complex tone in its shifted bin", (offsetHz) => {
    const bins = spectrumForTone(offsetHz, 0.5);
    expect(Math.abs(peakBin(bins) - shiftedBinForOffset(offsetHz, SAMPLE_RATE, FFT_SIZE))).toBeLessThanOrEqual(1);
  });

  it("reports a doubled amplitude approximately 6.02 dB higher", () => {
    const bin = shiftedBinForOffset(128_000, SAMPLE_RATE, FFT_SIZE);
    const quieter = spectrumForTone(128_000, 0.25);
    const louder = spectrumForTone(128_000, 0.5);
    expect((louder[bin] ?? 0) - (quieter[bin] ?? 0)).toBeCloseTo(6.0206, 2);
  });

  it("keeps silence finite at the documented floor", () => {
    const accumulator = new SpectrumAccumulator();
    let bins: Float32Array | undefined;
    for (let index = 0; index < 4; index += 1) bins = accumulator.addWindow(new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE));
    expect(bins).toBeDefined();
    expect(Array.from(bins ?? []).every(Number.isFinite)).toBe(true);
    expect(bins?.[0]).toBe(SPECTRUM_FLOOR_DB);
  });

  it("assembles windows across blocks and resets partial data on a discontinuity", () => {
    const tone = new SyntheticComplexTone({ sampleRateHz: SAMPLE_RATE, toneOffsetHz: 64_000 });
    const data = tone.generate(FFT_SIZE * 4);
    const processor = new SpectrumProcessor();
    expect(processor.accept(data.I.subarray(0, 5000), data.Q.subarray(0, 5000), 0)).toHaveLength(0);
    const frames = processor.accept(data.I.subarray(5000), data.Q.subarray(5000), 0);
    expect(frames).toHaveLength(1);
    expect(Math.abs(peakBin(frames[0]?.bins ?? new Float32Array()) - shiftedBinForOffset(64_000, SAMPLE_RATE, FFT_SIZE))).toBeLessThanOrEqual(1);

    processor.reset();
    processor.accept(data.I.subarray(0, FFT_SIZE * 3), data.Q.subarray(0, FFT_SIZE * 3), 100);
    expect(processor.accept(data.I.subarray(0, FFT_SIZE), data.Q.subarray(0, FFT_SIZE), 100, true, 1)).toHaveLength(0);
  });

  it("absorbs a bounded publication burst before a slow renderer returns batched credit", () => {
    const tone = new SyntheticComplexTone({ sampleRateHz: SAMPLE_RATE, toneOffsetHz: 32_000 });
    const processor = new SpectrumProcessor(new SpectrumAccumulator(), false, 3);
    const first = tone.generate(FFT_SIZE * 4);
    const second = tone.generate(FFT_SIZE * 4);
    const third = tone.generate(FFT_SIZE * 4);
    const fourth = tone.generate(FFT_SIZE * 4);
    expect(processor.accept(first.I, first.Q, 0)).toHaveLength(1);
    expect(processor.accept(second.I, second.Q, 100)).toHaveLength(1);
    expect(processor.accept(third.I, third.Q, 200)).toHaveLength(1);
    expect(processor.accept(fourth.I, fourth.Q, 300)).toHaveLength(0);
    processor.grantPublicationCredit(3);
    const fifth = tone.generate(FFT_SIZE * 4);
    const resumed = processor.accept(fifth.I, fifth.Q, 400);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.droppedBefore).toBe(1);
  });

  it("keeps three 9.6 MS/s rows from a burst without a credit round trip", () => {
    const rate = 9_600_000, windows = spectrumWindowsPerAverage(rate);
    let accumulated = 0;
    const processor = new SpectrumProcessor({
      size: FFT_SIZE,
      reset: () => { accumulated = 0; },
      addWindow: () => (++accumulated % windows === 0 ? new Float32Array(FFT_SIZE) : undefined),
    }, true);
    const I = new Float32Array(16_384), Q = new Float32Array(16_384), frames = [];
    for (let index = 0; index < 72; index += 1) frames.push(...processor.accept(I, Q, index));
    expect(frames).toHaveLength(3);
    expect(frames.map(frame => frame.skippedSpectrumFramesBefore)).toEqual([0, 0, 0]);
  });

  it("reports exact missing source samples separately from skipped publications", () => {
    const tone = new SyntheticComplexTone({ sampleRateHz: SAMPLE_RATE, toneOffsetHz: 32_000 });
    const processor = new SpectrumProcessor();
    const first = tone.generate(FFT_SIZE * 4);
    processor.accept(first.I, first.Q, 0);
    processor.grantPublicationCredit();
    const resumed = processor.accept(first.I, first.Q, 100, true, 2, 2_000);
    expect(resumed[0]).toMatchObject({ droppedBefore: 2, missingSamplesBefore: 2_000 });
  });

  it("derives axis edges from the frame center and actual sample rate", () => {
    expect(spectrumEdges(100_000_000, 1_024_000)).toEqual([99_488_000, 100_000_000, 100_512_000]);
  });
});
