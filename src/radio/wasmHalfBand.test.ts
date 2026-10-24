import { expect, it } from "vitest";
import { WasmHalfBandStage } from "./wasmHalfBand";
import { HalfBandStage } from "../testing/halfBandReference";

it.each(
  [false, true].flatMap((compact) =>
    [15, 31, 95].map((taps) => ({ taps, compact })),
  ),
)(
  "matches the original $taps-tap filter (compact=$compact) across offsets, odd blocks and reset",
  ({ taps, compact }) => {
    for (const offset of [0, 137_000, -500_000]) {
      const fast = new WasmHalfBandStage(offset, 4_800_000, taps, compact);
      const reference = new HalfBandStage(offset, 4_800_000, taps);
      for (let pass = 0; pass < 2; pass++) {
        let at = 0;
        for (const length of [1, 3, 4095, 32768, 137, 2]) {
          const I = Float32Array.from(
            { length },
            (_, n) =>
              Math.cos((at + n) * 0.037) + 0.1 * Math.sin((at + n) * 1.9),
          );
          const Q = Float32Array.from({ length }, (_, n) =>
            Math.sin((at + n) * 0.037),
          );
          const aI = I.slice(),
            aQ = Q.slice(),
            bI = I.slice(),
            bQ = Q.slice();
          const count = fast.process(aI, aQ);
          expect(count).toBe(reference.process(bI, bQ));
          // Check every component with the original five-decimal tolerance.
          // Aggregating the error avoids thousands of matcher allocations per
          // block; NaN and Infinity still fail the strict bound below.
          let maxError = 0;
          for (let n = 0; n < count; n++) {
            maxError = Math.max(
              maxError,
              Math.abs(aI[n]! - bI[n]!),
              Math.abs(aQ[n]! - bQ[n]!),
            );
          }
          expect(maxError).toBeLessThan(0.5 * 10 ** -5);
          at += length;
        }
        fast.reset();
        reference.reset(offset);
      }
    }
  },
);

it.each([15, 31, 95])(
  "bounds compact %i-tap rounding for CI8 and CI16 output",
  (taps) => {
    const dense = new WasmHalfBandStage(137_000, 4_800_000, taps);
    const compact = new WasmHalfBandStage(137_000, 4_800_000, taps, true);
    let seed = 0x4badbeef;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 31 - 1;
    };
    for (const length of [1, 4095, 32768, 137, 3]) {
      const I = Float32Array.from({ length }, noise),
        Q = Float32Array.from({ length }, noise);
      const copyI = I.slice(),
        copyQ = Q.slice();
      const count = dense.process(I, Q);
      expect(compact.process(copyI, copyQ)).toBe(count);
      let maxRoundingError = 0;
      let maxQuantizationError = 0;
      for (let n = 0; n < count; n++) {
        for (const [before, after] of [
          [I[n]!, copyI[n]!],
          [Q[n]!, copyQ[n]!],
        ] as const) {
          maxRoundingError = Math.max(
            maxRoundingError,
            Math.abs(before - after),
          );
          for (const scale of [128, 32768]) {
            const quantize = (x: number) =>
              Math.max(-scale, Math.min(scale - 1, Math.round(x * scale)));
            maxQuantizationError = Math.max(
              maxQuantizationError,
              Math.abs(quantize(before) - quantize(after)),
            );
          }
        }
      }
      expect(maxRoundingError).toBeLessThan(1e-6);
      expect(maxQuantizationError).toBeLessThanOrEqual(1);
    }
  },
);
