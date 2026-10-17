import { expect, it } from "vitest";
import { spectrumFrequencyTicks } from "./spectrumFrequencyTicks";
it("adapts even tick spacing to available width and retains exact edges, center and Hz precision", () => {
  const narrow = spectrumFrequencyTicks(10_100_800, 1_024_000, 320);
  const wide = spectrumFrequencyTicks(10_100_800, 1_024_000, 1200);
  expect(narrow).toHaveLength(3); expect(wide).toHaveLength(9);
  for (const ticks of [narrow, wide]) {
    expect(ticks[0]!.frequencyHz).toBe(9_588_800);
    expect(ticks.at(-1)!.frequencyHz).toBe(10_612_800);
    expect(ticks[(ticks.length - 1) / 2]!.label).toBe("10.1008 MHz");
  }
  expect(spectrumFrequencyTicks(NaN, 2e6, 500)).toEqual([]);
});
