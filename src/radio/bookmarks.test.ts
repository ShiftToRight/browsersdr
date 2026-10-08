import { describe, expect, it } from "vitest";
import {
  bookmarkFromCandidate,
  exportBookmarks,
  importBookmarks,
  mergeBookmarks,
  validateBookmark,
  type Bookmark,
} from "./bookmarks";
import { defaultModeSettings, RECEIVER_MODES } from "./receiverConfig";
const favorite = (overrides: Partial<Bookmark> = {}): Bookmark => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Local station",
  frequencyHz: 100e6,
  settings: defaultModeSettings("WBFM"),
  tags: ["local"],
  notes: "Test fixture",
  ...overrides,
});
describe("bounded local favorite backups", () => {
  it("round trips every supported mode and independent nested SRD settings", () => {
    for (const mode of RECEIVER_MODES) {
      const item = favorite({ settings: defaultModeSettings(mode) });
      const restored = importBookmarks(exportBookmarks([item]));
      expect(restored).toEqual([item]);
      if (item.settings.srd) {
        restored[0]!.settings.srd!.threshold.carrierLevel = 2;
        expect(item.settings.srd.threshold.carrierLevel).toBe(0.2);
      }
    }
  });
  it("validates the whole import and does not mutate existing favorites", () => {
    const existing = [favorite()];
    for (const value of [
      "null",
      '{"schema":"future","bookmarks":[]}',
      exportBookmarks(existing).replace("100000000", "-1"),
      '{"schema":"browsersdr-bookmarks-v1","bookmarks":[{}]}',
      " ".repeat(256 * 1024 + 1),
    ])
      expect(() => importBookmarks(value)).toThrow();
    expect(existing).toEqual([favorite()]);
    expect(() =>
      importBookmarks(
        JSON.stringify({
          schema: "browsersdr-bookmarks-v1",
          bookmarks: Array.from({ length: 201 }, () => favorite()),
        }),
      ),
    ).toThrow();
    expect(() =>
      importBookmarks(
        JSON.stringify({
          schema: "browsersdr-bookmarks-v1",
          bookmarks: [favorite(), favorite()],
        }),
      ),
    ).toThrow(/Duplicate/);
  });
  it("rejects unsafe frequencies, names, mode parameters and malformed SRD enums", () => {
    for (const frequencyHz of [0, -1, Infinity, NaN, 6e9 + 1, 1.5])
      expect(() => validateBookmark(favorite({ frequencyHz }))).toThrow();
    for (const name of ["", " ", "x".repeat(101)])
      expect(() => validateBookmark(favorite({ name }))).toThrow();
    for (const settings of [
      { ...defaultModeSettings("AM"), bandwidthHz: 1 },
      { ...defaultModeSettings("CW"), beatToneHz: 100 },
      { ...defaultModeSettings("AM"), squelch: 7 },
    ])
      expect(() => validateBookmark(favorite({ settings }))).toThrow();
    const item = favorite({ settings: defaultModeSettings("SRD") });
    (item.settings.srd!.protocol as string) = "execute";
    expect(() => validateBookmark(item)).toThrow(/Unsupported SRD/);
  });
  it("keeps optional Atlas references unconfirmed and drops credentials/unknown fields from export", () => {
    const item = bookmarkFromCandidate({
      station_id: "00000000-0000-4000-8000-000000000012",
      station_name: "Catalog example",
      frequency_hz: 100e6,
      bandwidth_hz: 200000,
      mode: "WBFM",
    });
    expect(item.settings.bandwidthHz).toBe(150000);
    expect(item.atlasReference!.bandwidth_hz).toBe(200000);
    expect(importBookmarks(exportBookmarks([item]))).toEqual([item]);
    const polluted = {
      ...item,
      token: "secret",
      credentials: { password: "hidden" },
    };
    expect(exportBookmarks([polluted])).not.toMatch(
      /secret|hidden|credentials|token/,
    );
    expect(() => validateBookmark({ ...item, frequencyHz: 101e6 })).toThrow(
      /mismatched/,
    );
    const srd = favorite({
      settings: {
        ...defaultModeSettings("SRD"),
        srd: { ...defaultModeSettings("SRD").srd!, token: "secret" },
      } as Bookmark["settings"],
    });
    expect(exportBookmarks([srd])).not.toContain("secret");
  });
  it("merges in order, skips identical IDs and rejects conflicting IDs without partial changes", () => {
    const first = favorite(),
      second = favorite({
        id: "00000000-0000-4000-8000-000000000002",
        name: "Second",
      });
    expect(mergeBookmarks([first], [first, second])).toEqual([first, second]);
    expect(() =>
      mergeBookmarks([first], [second, { ...first, name: "Changed" }]),
    ).toThrow(/different contents/);
    expect(first.name).toBe("Local station");
  });
});
