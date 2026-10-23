// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  retryPreferences,
  preferenceFailures,
  savePresentation,
  presentationValue,
  EXPLORER_PREFERENCES_KEY,
  loadExplorerPreferences,
  readPreference,
  storePreference,
} from "./explorerPreferences";
afterEach(() => {
  vi.restoreAllMocks();
  retryPreferences();
  localStorage.clear();
});
it("retains an arbitrary frequency range and detector choices independently of measurement history", () => {
  storePreference(EXPLORER_PREFERENCES_KEY, {
    activity: "monitor",
    monitorTargetMode: "range",
    monitorPreset: "narrow",
    dwellMs: 750,
    thresholdDb: 9,
    detector: "average",
    selectedBandId: "fm",
    startMhz: 84,
    endMhz: 108,
  });
  expect(loadExplorerPreferences()).toMatchObject({
    activity: "monitor",
    monitorTargetMode: "range",
    monitorPreset: "narrow",
    dwellMs: 750,
    thresholdDb: 9,
    startMhz: 84,
    endMhz: 108,
  });
});
it("rejects malformed, unsupported and nonfinite stored settings without losing valid preferences", () => {
  localStorage.setItem(EXPLORER_PREFERENCES_KEY, "{");
  expect(loadExplorerPreferences()).toEqual({});
  storePreference(EXPLORER_PREFERENCES_KEY, {
    activity: "monitor",
    monitorTargetMode: "all",
    monitorPreset: "__proto__",
    dwellMs: -1,
    thresholdDb: 400,
    detector: "invalid",
    startMhz: null,
    endMhz: 108,
  });
  expect(loadExplorerPreferences()).toEqual({
    activity: "monitor",
    endMhz: 108,
  });
});
it("continues without optional storage access", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full");
  });
  expect(readPreference(EXPLORER_PREFERENCES_KEY)).toEqual({});
  expect(() => storePreference(EXPLORER_PREFERENCES_KEY, {})).not.toThrow();
});
it("reports failed preference writes and retries the exact retained value", () => {
  const original = Storage.prototype.setItem;
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota exceeded");
  });
  expect(storePreference("test.retry", { lower: "unfinished MHz" })).toBe(
    false,
  );
  save.mockImplementation(original);
  retryPreferences();
  expect(readPreference("test.retry")).toEqual({ lower: "unfinished MHz" });
  expect(preferenceFailures()).toBe(0);
});
it("bounds presentation values to supported choices independently of acquisition settings", () => {
  savePresentation("filter", "all");
  expect(presentationValue("filter", "confirmed", ["all", "confirmed"])).toBe(
    "all",
  );
  savePresentation("filter", "unsupported");
  expect(presentationValue("filter", "confirmed", ["all", "confirmed"])).toBe(
    "confirmed",
  );
  expect(loadExplorerPreferences()).toEqual({});
});
