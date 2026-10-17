import { expect, it } from "vitest";
import { WasmHalfBandStage } from "./wasmHalfBand";
import { HalfBandStage } from "../testing/halfBandReference";

it.each([15, 31, 95])(
  "matches the original %i-tap channel filter across offsets, odd blocks and reset",
  (taps) => {
    for (const offset of [0, 137_000, -500_000]) {
      const fast = new WasmHalfBandStage(offset, 4_800_000, taps);
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
