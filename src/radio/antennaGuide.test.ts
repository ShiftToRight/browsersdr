import { expect, it } from "vitest";
import {
  antennaLengths,
  antennaLengthLabel,
  antennaGuideFor,
} from "./antennaGuide";
import { parseDiscoveryFrequency } from "./discoveryGuides";

it.each([
  [100e6, 0.749481145],
  [137e6, 0.5470665291970803],
  [220e6, 0.34067324772727275],
  [403e6, 0.18597547022332506],
  [1090e6, 0.0687597380733945],
])(
  "calculates free-space quarter wave at %s Hz from physical reference values",
  (hz, expected) => {
    const length = antennaLengths(hz);
    expect(length.quarterWaveM).toBeCloseTo(expected, 12);
    expect(length.halfWaveM).toBeCloseTo(expected * 2, 12);
  },
);
it("keeps a practical dipole arm distinct from total span and an ideal whip", () => {
  const lengths = antennaLengths(100e6);
  expect(lengths.practicalDipoleM).toBeCloseTo(1.426464, 9);
  expect(lengths.practicalArmM).toBeCloseTo(0.713232, 9);
  expect(lengths.practicalDipoleM).toBeLessThan(lengths.halfWaveM);
  expect(antennaLengths(137e6).practicalArmM).not.toBe(0.534);
});
it.each([0, -1, NaN, Infinity, 0.5, 1e12 + 1])(
  "rejects unusable calculation input %s",
  (value) => expect(() => antennaLengths(value)).toThrow(),
);
it("accepts explicit units and decimal comma without treating a DAB block as a raw MHz number", () => {
  expect(parseDiscoveryFrequency("0,1 GHz").frequencyHz).toBe(100e6);
  expect(parseDiscoveryFrequency("100000 kHz").frequencyHz).toBe(100e6);
  expect(parseDiscoveryFrequency("11C").frequencyHz).toBe(220.352e6);
  expect(parseDiscoveryFrequency("100,000,000 Hz").error).toBeTruthy();
});
it("formats metric, imperial and very short elements without rounding them to zero", () => {
  expect(antennaLengthLabel(0.749481145, "metric")).toBe("74.9 cm");
  expect(antennaLengthLabel(1.5, "metric")).toBe("1.50 m");
  expect(antennaLengthLabel(0.002, "metric")).toBe("2.00 mm");
  expect(antennaLengthLabel(0.0254, "imperial")).toBe("1.00 in");
  expect(antennaLengthLabel(0.3048, "imperial")).toBe("1.00 ft");
  expect(
    antennaLengthLabel(antennaLengths(1e12).quarterWaveM, "imperial"),
  ).toBe("0.0030 in");
});
it("requires an explicit supported mode and its appropriate band rather than inferring a satellite from frequency", () => {
  expect(antennaGuideFor("WBFM", 100e6)?.id).toBe("fm");
  expect(antennaGuideFor("DAB", 225.648e6)?.id).toBe("dab");
  expect(antennaGuideFor("ADS-B", 1090e6)?.id).toBe("adsb");
  expect(antennaGuideFor("NBFM", 137.9e6)).toBeUndefined();
  expect(antennaGuideFor("WBFM", 403e6)).toBeUndefined();
  expect(antennaGuideFor(undefined, undefined)).toBeUndefined();
});
