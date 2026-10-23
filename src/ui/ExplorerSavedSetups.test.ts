// @vitest-environment jsdom
import { expect, it } from "vitest";
import { validateExplorerSetup } from "./ExplorerSavedSetups";
const setup = () => ({
  settings: {
    monitorTargetMode: "range",
    monitorPreset: "narrow",
    dwellMs: 750,
    thresholdDb: 9,
    detector: "average",
  },
  profile: {
    version: 1,
    name: "Test",
    site: { label: "Test" },
    bands: [
      {
        id: "fm",
        name: "FM",
        startFrequencyHz: 84e6,
        endFrequencyHz: 108e6,
        dwellMs: 350,
        thresholdDb: 10,
        detector: "average",
        captureSeconds: 2,
      },
    ],
  },
  enabledBandIds: ["fm"],
  custom: { lower: "84 MHz", upper: "108 MHz" },
  analyze: true,
  budget: 20,
});
it("retains the complete independently validated setup without run or receiver state", () => {
  expect(
    validateExplorerSetup({
      ...setup(),
      running: true,
      receiver: { source: "hardware" },
    }),
  ).toEqual(setup());
});
it("rejects invalid targets, incomplete presets, unsupported analysis budgets and oversized saved setups", () => {
  const value = setup();
  expect(() =>
    validateExplorerSetup({
      ...value,
      custom: { lower: "108 MHz", upper: "84 MHz" },
    }),
  ).toThrow();
  expect(() =>
    validateExplorerSetup({
      ...value,
      settings: { ...value.settings, monitorPreset: "__proto__" },
    }),
  ).toThrow();
  expect(() => validateExplorerSetup({ ...value, budget: 9999 })).toThrow();
  expect(() =>
    validateExplorerSetup({
      ...value,
      custom: { lower: "84 MHz", upper: "108 MHz", padding: "x".repeat(40000) },
    }),
  ).toThrow();
});
it("retains frequency lists while rejecting malformed and duplicate frequencies", () => {
  const value = setup();
  const frequencies = {
    ...value,
    settings: { ...value.settings, monitorTargetMode: "frequencies" },
    custom: {
      rows: [
        { id: "one", frequency: "99.7 MHz", width: "200 kHz", label: "Local" },
      ],
    },
  };
  expect(validateExplorerSetup(frequencies).custom).toEqual(frequencies.custom);
  expect(() =>
    validateExplorerSetup({
      ...frequencies,
      custom: {
        rows: [...frequencies.custom.rows, ...frequencies.custom.rows],
      },
    }),
  ).toThrow();
  expect(() =>
    validateExplorerSetup({
      ...frequencies,
      custom: { rows: [{ frequency: "unfinished", width: "0 Hz" }] },
    }),
  ).toThrow();
});
