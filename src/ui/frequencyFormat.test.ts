import { expect, it } from "vitest";
import { editableFrequencyMHz, formatFrequencyMHz } from "./frequencyFormat";

it("keeps HF and accepted hardware Hz visible without adding zeros to ordinary MHz", () => {
  expect(formatFrequencyMHz(10_100_800)).toBe("10.1008");
  expect(formatFrequencyMHz(99_999_983)).toBe("99.999983");
  expect(formatFrequencyMHz(100_123_456)).toBe("100.123456");
  expect(formatFrequencyMHz(99_700_000)).toBe("99.700");
  expect(editableFrequencyMHz(10_100_800)).toBe("10.100800");
  expect(formatFrequencyMHz(NaN)).toBe("");
});
