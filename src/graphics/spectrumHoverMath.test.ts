import { expect, it } from "vitest";
import { sampleSpectrumTrace } from "./spectrumHoverMath";

it("interpolates the WebGPU polyline and clamps dot height at display limits", () => {
  const frame = { center: 100e6, rate: 1e6, bins: new Float32Array([-100, -40, -20]), columns: 3, floor: -90, range: 60 };
  expect(sampleSpectrumTrace(frame, .5)).toEqual({ level: -40, y: expect.closeTo(.375 - 50 / 60 * .335) });
  expect(sampleSpectrumTrace(frame, .25)).toEqual({ level: -70, y: expect.closeTo(.375 - 25 / 60 * .335) });
  expect(sampleSpectrumTrace(frame, 1)?.y).toBeCloseTo(.04);
});

it("matches Canvas2D peak columns and their screen positions without losing a narrow peak", () => {
  const frame = { center: 0, rate: 1, bins: new Float32Array([-90, -30, -80, -70, -60, -65]), columns: 3, floor: -100, range: 100 };
  expect(sampleSpectrumTrace(frame, 0)?.level).toBe(-30);
  expect(sampleSpectrumTrace(frame, .5)?.level).toBe(-70);
  expect(sampleSpectrumTrace(frame, .75)?.level).toBe(-65);
  expect(sampleSpectrumTrace(frame, 1)?.level).toBe(-60);
});

it("omits missing, invalid and gap levels instead of inventing a trace measurement", () => {
  const frame = { center: 0, rate: 1, columns: 2, floor: -100, range: 100 };
  expect(sampleSpectrumTrace(frame, .5)).toBeUndefined();
  for (const value of [NaN, Infinity, -10000]) {
    expect(sampleSpectrumTrace({ ...frame, bins: new Float32Array([value, value]) }, .5)).toBeUndefined();
  }
});
