import { describe, expect, it } from "vitest";
import type { SpectrumFrame } from "../radio/types";
import { SpectrumSurfaceHistory, SURFACE_COLUMNS, SURFACE_ROWS, SURFACE_GAP } from "./spectrumSurfaceHistory";
import { surfaceSettings } from "./spectrumSurfaceSettings";

function frame(sequence: number, patch: Partial<SpectrumFrame> = {}): SpectrumFrame {
  return { sessionGeneration: 1, sequence, sampleIndex: (sequence + 1) * 40, timestampMs: 0,
    sampleRateHz: 1000, hopSamples: 40, centerFrequencyHz: 100e6, units: "relative-dB",
    bins: new Float32Array(4096).fill(-90), droppedFramesBefore: 0, ...patch };
}
describe("source-clock 3D spectrum history", () => {
  it("owns peak-pooled bins, retains narrow peaks and merges a source interval without averaging dB", () => {
    const history = new SpectrumSurfaceHistory(), a = frame(0);
    a.bins[2051] = -20;
    expect(history.accept(a)).toEqual([0]);
    a.bins.fill(-120);
    expect(history.levels[512]).toBe(-20);
    const b = frame(1, { sampleIndex: 45 });
    b.bins[10] = -30;
    expect(history.accept(b)).toEqual([0]);
    expect(history.count).toBe(1);
    expect(history.levels[512]).toBe(-20);
    expect(history.levels[2]).toBe(-30);
    expect(history.metadata[0]).toBeCloseTo(.005);
  });
  it("inserts invalid separator rows for drops, explicit pause and sample-clock jumps", () => {
    for (const reason of ["drop", "clock", "pause", "missing"] as const) {
      const h = new SpectrumSurfaceHistory();h.accept(frame(0));
      if (reason === "pause") h.breakContinuity();
      const next = frame(1, reason === "clock" ? { sampleIndex: 4000 } : reason === "drop" ?
        { droppedFramesBefore: 1 } : reason === "missing" ? { missingSamplesBefore: 20 } : {});
      expect(h.accept(next)).toEqual([1, 2]);
      expect(h.metadata[1 * 4 + 1]).toBe(0);
      expect(h.metadata[2 * 4 + 1]).toBe(1);
      expect(h.metadata[4]).toBeGreaterThan(0);
      expect(h.metadata[4]).toBeLessThan(h.latestTime);
    }
  });
  it("rejects duplicate, out-of-order, stale generation and malformed frames", () => {
    const h = new SpectrumSurfaceHistory();h.accept(frame(2));
    for (const f of [frame(2),frame(1),frame(3,{sessionGeneration:0}),frame(3,{sampleRateHz:0}),
      frame(3,{sampleIndex:NaN}),frame(NaN)]) expect(h.accept(f)).toEqual([]);
    expect(h.count).toBe(1);
  });
  it("resets incompatible center, rate, FFT, generation and backwards seek contexts", () => {
    for (const patch of [{centerFrequencyHz:101e6},{sampleRateHz:2000},
      {bins:new Float32Array(16384).fill(-70)},{sessionGeneration:2},{sampleIndex:1}]) {
      const h = new SpectrumSurfaceHistory();h.accept(frame(0));h.accept(frame(1));
      h.accept(frame(2,patch));expect(h.count).toBe(1);expect(h.latestTime).toBe(0);
    }
  });
  it("wraps bounded allocations and reports actual retained source time", () => {
    const h = new SpectrumSurfaceHistory(), levels = h.levels, metadata = h.metadata;
    for (let i=0;i<1000;i++) h.accept(frame(i));
    expect(h.count).toBe(SURFACE_ROWS);expect(h.nextRow).toBe(1000%SURFACE_ROWS);
    expect(h.levels).toBe(levels);expect(h.metadata).toBe(metadata);
    expect(h.levels.byteLength).toBe(SURFACE_COLUMNS*SURFACE_ROWS*4);
    expect(h.duration(16)).toBe(16);expect(h.duration(100)).toBeCloseTo(511*.04,4);
  });
  it("keeps nonfinite-only columns empty instead of inventing a floor measurement", () => {
    const h = new SpectrumSurfaceHistory();h.accept(frame(0,{bins:new Float32Array(4096).fill(NaN)}));
    expect(h.levels.subarray(0,SURFACE_COLUMNS).every(v=>v===SURFACE_GAP)).toBe(true);
  });
  it("separates nearby peaks that the old 256-column terrain collapsed, including band edges", () => {
    const h = new SpectrumSurfaceHistory(), f = frame(0);
    f.bins[0] = -10; f.bins[2048] = -20; f.bins[2056] = -30; f.bins[4095] = -40;
    h.accept(f);
    expect(h.levels[0]).toBe(-10);
    expect(h.levels[512]).toBe(-20);
    expect(h.levels[513]).toBe(-90);
    expect(h.levels[514]).toBe(-30);
    expect(h.levels[1023]).toBe(-40);
  });
  it("renders only rows inside the chosen source-clock window, without dropping gap separators", () => {
    const h = new SpectrumSurfaceHistory();
    expect(h.visibleRows(10)).toBe(0);
    for (let i=0;i<400;i++) h.accept(frame(i));
    expect(h.duration(10)).toBe(10);
    expect(h.visibleRows(10)).toBeGreaterThanOrEqual(250);
    expect(h.visibleRows(10)).toBeLessThanOrEqual(251);
    h.breakContinuity(); h.accept(frame(400));
    expect(h.metadata[((h.nextRow + SURFACE_ROWS - 2) % SURFACE_ROWS) * 4 + 1]).toBe(0);
    expect(h.visibleRows(10)).toBeGreaterThanOrEqual(251);
    expect(h.visibleRows(16)).toBe(h.count);
  });
  it("validates saved display-only preferences", () => {
    expect(surfaceSettings({view:"webgl",seconds:999,elevation:NaN,height:Infinity})).toEqual({view:"2d",seconds:10,elevation:38,height:1,perspective:true,layout:"combined"});
    expect(surfaceSettings({view:"3d",seconds:16,elevation:999,height:-5})).toEqual({view:"3d",seconds:16,elevation:60,height:.5,perspective:true,layout:"combined"});
    expect(surfaceSettings({seconds:8}).seconds).toBe(8);
    expect(surfaceSettings({seconds:10}).seconds).toBe(10);
    expect(surfaceSettings({layout:"separate"}).layout).toBe("separate");
    expect(surfaceSettings({layout:"invalid"}).layout).toBe("combined");
    expect(surfaceSettings().perspective).toBe(true);
    expect(surfaceSettings({view:"3d",seconds:8,height:1,elevation:38}).perspective).toBe(true);
    expect(surfaceSettings({perspective:false}).perspective).toBe(false);
    expect(surfaceSettings({perspective:"false"}).perspective).toBe(true);
  });
});


it("retains compatible RF rows across a declared channel handover, rejects stale generations and marks the clock reset",()=>{
  const h=new SpectrumSurfaceHistory();h.accept(frame(0));h.accept(frame(1));
  const original=h.levels.slice(0,2*SURFACE_COLUMNS),time=h.latestTime;
  h.continueGeneration(2);
  expect(h.accept(frame(2))).toEqual([]);
  expect(h.accept(frame(0,{sessionGeneration:2,sampleIndex:40}))).toEqual([2,3]);
  expect(h.count).toBe(4);expect(h.levels.slice(0,2*SURFACE_COLUMNS)).toEqual(original);
  expect(h.metadata[2*4+1]).toBe(0);expect(h.latestTime).toBeCloseTo(time+.04);
  expect(h.accept(frame(1,{sessionGeneration:2,sampleIndex:80}))).toEqual([4]);
  h.continueGeneration(3);
  h.accept(frame(0,{sessionGeneration:3,centerFrequencyHz:101e6}));
  expect(h.count).toBe(1);
});
