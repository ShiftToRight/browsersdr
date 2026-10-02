import { expect, it } from "vitest";
import { spectrumDisplayScale } from "./spectrumDisplayScale";
it("places the noise floor below the signal and reserves peak headroom", () => {
  expect(
    spectrumDisplayScale(new Float32Array([-90, -91, -89, -90, -40])),
  ).toEqual({ floorDb: -99, rangeDb: 65 });
});
it("ignores invalid bins and bounds display settings", () => {
  expect(
    spectrumDisplayScale(new Float32Array([NaN, Infinity])),
  ).toBeUndefined();
  expect(spectrumDisplayScale(new Float32Array([-500, 500]))).toEqual({
    floorDb: -120,
    rangeDb: 120,
  });
  expect(spectrumDisplayScale(new Float32Array([0]))).toEqual({
    floorDb: -30,
    rangeDb: 36,
  });
});
