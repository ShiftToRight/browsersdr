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
          for (let n = 0; n < count; n++) {
            expect(aI[n]).toBeCloseTo(bI[n]!, 5);
            expect(aQ[n]).toBeCloseTo(bQ[n]!, 5);
          }
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
      for (let n = 0; n < count; n++) {
        for (const [before, after] of [
          [I[n]!, copyI[n]!],
          [Q[n]!, copyQ[n]!],
        ] as const) {
          expect(Math.abs(before - after)).toBeLessThan(1e-6);
          for (const scale of [128, 32768]) {
            const quantize = (x: number) =>
              Math.max(-scale, Math.min(scale - 1, Math.round(x * scale)));
            expect(
              Math.abs(quantize(before) - quantize(after)),
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  },
);
