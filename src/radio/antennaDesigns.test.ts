import { expect, it } from "vitest";
import {
  ant500Preset,
  convertWhipLimits,
  parseWhipLimits,
  whipFit,
} from "./antennaDesigns";

it("compares targets against the ANT500 envelope without assuming its advertised band is resonant", () => {
  const preset = ant500Preset("metric");
  const limits = parseWhipLimits(preset.minimum, preset.maximum, "metric");
  expect(whipFit(0.9993, limits)).toBe("too-long");
  expect(whipFit(0.7495, limits)).toBe("fits");
  expect(whipFit(0.1731, limits)).toBe("too-short");
  expect(whipFit(0.2, limits)).toBe("fits");
  expect(whipFit(0.88, limits)).toBe("fits");
});
it.each([
  ["", "", "unknown"],
  ["20", "", "too-short"],
  ["", "10", "too-long"],
  ["5", "20", "fits"],
])("handles unknown or one-sided limits %s/%s", (min, max, result) => {
  expect(whipFit(0.15, parseWhipLimits(min, max, "metric"))).toBe(result);
});
it.each([
  ["0", "88"],
  ["90", "20"],
  ["-1", "2"],
  ["1e2", "1000"],
  ["Infinity", ""],
  ["1", "100001"],
  ["1.2.3", ""],
])("rejects invalid limits %s/%s without declaring fit", (min, max) => {
  const limits = parseWhipLimits(min, max, "metric");
  expect(limits.error).toBeTruthy();
  expect(whipFit(0.75, limits)).toBe("invalid");
});
it("preserves physical limits through result-unit changes and accepts decimal commas", () => {
  const original = {
    ...ant500Preset("metric"),
    preset: "custom" as const,
    minimum: "20,5",
  };
  const inches = convertWhipLimits(original, "metric", "imperial");
  const parsed = parseWhipLimits(inches.minimum, inches.maximum, "imperial");
  expect(parsed.minimumM).toBeCloseTo(0.205, 7);
  expect(parsed.maximumM).toBeCloseTo(0.88, 7);
  const roundTrip = convertWhipLimits(inches, "imperial", "metric");
  expect(Number(roundTrip.minimum)).toBeCloseTo(20.5, 5);
  expect(Number(roundTrip.maximum)).toBeCloseTo(88, 5);
});
it("keeps invalid drafts invalid and converts reversed limits without clearing them", () => {
  const converted = convertWhipLimits(
    {
      ...ant500Preset("metric"),
      preset: "custom",
      minimum: "90",
      maximum: "20",
    },
    "metric",
    "imperial",
  );
  expect(
    parseWhipLimits(converted.minimum, converted.maximum, "imperial").error,
  ).toContain("Minimum");
  expect(
    convertWhipLimits({ ...converted, minimum: "bad" }, "imperial", "metric")
      .minimum,
  ).toBe("bad");
});
it("restores exact published ANT500 limits after unit round trips", () => {
  const converted = convertWhipLimits(
    ant500Preset("metric"),
    "metric",
    "imperial",
  );
  const restored = convertWhipLimits(converted, "imperial", "metric");
  expect(restored.minimum).toBe("20");
  expect(restored.maximum).toBe("88");
});
