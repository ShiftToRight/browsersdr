import { expect, it } from "vitest";
import { snapChannelFrequency as snap } from "./channelRaster";
it("uses mode and selected region, preserving free bands and precise HF dials", () => {
  expect(snap(99_702_000, "WBFM", "DE")).toBe(99_700_000);
  expect(snap(99_702_000, "WBFM", "US")).toBe(99_700_000);
  expect(snap(99_600_000, "WBFM", "US")).toBe(99_700_000);
  expect(snap(599_800, "AM", "DE")).toBe(603_000);
  expect(snap(599_800, "AM", "US")).toBe(600_000);
  expect(snap(178_350_000, "DAB", "DE")).toBe(178_352_000);
  expect(snap(99_702_000, "WBFM", "general")).toBe(99_702_000);
  expect(snap(99_702_000, "WBFM", "unknown")).toBe(99_702_000);
  for (const mode of ["USB", "LSB", "RTTY", "PSK31", "CW", "AM"] as const)
    expect(snap(10_100_800, mode, "DE")).toBe(10_100_800);
  expect(snap(100_000_000, "DAB", "DE")).toBe(100_000_000);
});
