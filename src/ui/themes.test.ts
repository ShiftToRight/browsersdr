// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initializeTheme, parseTheme, readTheme, setTheme, THEME_KEY } from "./themes";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); setTheme("classic"); });
it("retains safe defaults for old, malformed and unavailable preference storage", () => {
  for (const value of [null, "", "unknown", "{broken}", "prototype", 123]) expect(parseTheme(value)).toBe("classic");
  expect(readTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("classic");
  for (const value of ["field-deck", "vice-afterglow"]) expect(parseTheme(value)).toBe(value);
});
it("applies and persists appearance, follows cross-tab removal, and tolerates blocked writes", () => {
  localStorage.setItem(THEME_KEY, "field-deck");
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe("field-deck");
  setTheme("vice-afterglow");
  expect(localStorage.getItem(THEME_KEY)).toBe("vice-afterglow");
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: null, storageArea: localStorage }));
  expect(document.documentElement.dataset.theme).toBe("classic");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => setTheme("field-deck")).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe("field-deck");
});
