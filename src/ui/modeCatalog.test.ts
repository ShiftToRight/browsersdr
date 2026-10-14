import { expect, it } from "vitest";
import { RECEIVER_MODES } from "../radio/receiverConfig";
import { CATALOG_MODES, matchingModes } from "./modeCatalog";
import {
  DEFAULT_QUICK_MODES,
  QUICK_MODES_KEY,
  readQuickModes,
  quickModesWithCurrent,
} from "./modeQuickList";

it("describes exactly the implemented modes and searches aliases within categories", () => {
  expect([...CATALOG_MODES].sort()).toEqual([...RECEIVER_MODES].sort());
  expect(matchingModes("balloon", "All modes")).toEqual(["RS41"]);
  expect(matchingModes("adsb", "Aviation")).toEqual(["ADS-B"]);
  expect(matchingModes("radio", "Marine")).not.toContain("WBFM");
  expect(matchingModes("FT8", "All modes")).toEqual([]);
});
it("rejects corrupt, duplicate, unknown and oversized quick preferences", () => {
  for (const raw of [
    "{",
    "null",
    "{}",
    '["AM","AM"]',
    '["FT8"]',
    JSON.stringify(RECEIVER_MODES),
  ]) {
    expect(
      readQuickModes({
        getItem: (key) => (key === QUICK_MODES_KEY ? raw : null),
      }),
    ).toEqual(DEFAULT_QUICK_MODES);
  }
  expect(
    readQuickModes({
      getItem: () => {
        throw new Error("storage denied");
      },
    }),
  ).toEqual(DEFAULT_QUICK_MODES);
});
it("preserves explicit custom and empty pins and retains an unpinned current mode", () => {
  expect(readQuickModes({ getItem: () => '["AIS","DAB"]' })).toEqual([
    "AIS",
    "DAB",
  ]);
  expect(readQuickModes({ getItem: () => "[]" })).toEqual([]);
  expect(quickModesWithCurrent(["AM", "OFF"], "RS41")).toEqual([
    "RS41",
    "AM",
    "OFF",
  ]);
  expect(quickModesWithCurrent(["AM", "OFF"], "AM")).toEqual(["AM", "OFF"]);
});
