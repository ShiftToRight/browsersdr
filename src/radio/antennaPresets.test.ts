import { expect, it } from "vitest";
import { antennaLengths } from "./antennaGuide";
import { DEFAULT_WHIP, parseWhipLimits, whipFit } from "./antennaDesigns";
import {
  presetSettings,
  convertPresetDimensions,
  customPresetFromSettings,
  sanitizeCustomPresets,
  MAX_CUSTOM_PRESETS,
  fixedSectionM,
} from "./antennaPresets";

it("loads ANT700 and RaTLSnake with their own mounting and known or unknown limits", () => {
  const small = presetSettings("ant700", "metric")!;
  expect(small.antenna).toBe("whip");
  expect(small.minimum).toBe("9.5");
  expect(small.maximum).toBe("24.5");
  expect(
    whipFit(
      antennaLengths(433e6).quarterWaveM,
      parseWhipLimits(small.minimum, small.maximum, "metric"),
    ),
  ).toBe("fits");
  const magnetic = presetSettings("ratlsnake", "metric")!;
  expect(magnetic.antenna).toBe("telescopic");
  expect(magnetic.minimum).toBe("");
  expect(magnetic.maximum).toBe("");
  expect(
    whipFit(
      0.75,
      parseWhipLimits(magnetic.minimum, magnetic.maximum, "metric"),
    ),
  ).toBe("unknown");
});
it("separates the listed per-arm extension from provisional internal metal and total span", () => {
  const long = presetSettings("rtl-long", "metric")!,
    short = presetSettings("rtl-short", "metric")!;
  expect([long.minimum, long.maximum, long.fixedSection]).toEqual([
    "23",
    "100",
    "2",
  ]);
  expect([short.minimum, short.maximum, short.fixedSection]).toEqual([
    "5",
    "13",
    "2",
  ]);
  const arm = antennaLengths(100e6).practicalArmM;
  expect(arm - fixedSectionM(long, "metric")!).toBeCloseTo(0.693232, 8);
  const uhfExtension =
    antennaLengths(550e6).practicalArmM - fixedSectionM(short, "metric")!;
  expect(
    whipFit(
      uhfExtension,
      parseWhipLimits(short.minimum, short.maximum, "metric"),
    ),
  ).toBe("fits");
  expect(
    whipFit(
      uhfExtension,
      parseWhipLimits(long.minimum, long.maximum, "metric"),
    ),
  ).toBe("too-short");
});
it.each(["ant500", "ant700", "rtl-long", "rtl-short", "ratlsnake"])(
  "preserves canonical %s dimensions after unit changes",
  (id) => {
    const initial = presetSettings(id, "metric")!;
    const inches = convertPresetDimensions(initial, "metric", "imperial");
    const restored = convertPresetDimensions(inches, "imperial", "metric");
    expect([restored.minimum, restored.maximum, restored.fixedSection]).toEqual(
      [initial.minimum, initial.maximum, initial.fixedSection],
    );
  },
);
it("saves named profiles in canonical metres and restores the chosen geometry and eighth-wave flag", () => {
  const data = customPresetFromSettings(
    "saved-test",
    " Desk dipole ",
    "dipole",
    { ...presetSettings("rtl-long", "metric")!, showEighth: true },
    "metric",
  );
  expect(typeof data).not.toBe("string");
  if (typeof data === "string") throw Error(data);
  expect(data.name).toBe("Desk dipole");
  expect(data.minimumM).toBe(0.23);
  expect(data.fixedSectionM).toBe(0.02);
  const loaded = presetSettings(data.id, "imperial", [data])!;
  expect(loaded.antenna).toBe("dipole");
  expect(loaded.showEighth).toBe(true);
  expect(fixedSectionM(loaded, "imperial")).toBeCloseTo(0.02, 7);
});
it("rejects invalid names, dimensions and generic recommendations before saving", () => {
  expect(
    customPresetFromSettings("saved-a", "", "whip", DEFAULT_WHIP, "metric"),
  ).toContain("name");
  expect(
    customPresetFromSettings("saved-a", "a\nb", "whip", DEFAULT_WHIP, "metric"),
  ).toContain("control");
  expect(
    customPresetFromSettings(
      "saved-a",
      "Desk",
      "recommended",
      DEFAULT_WHIP,
      "metric",
    ),
  ).toContain("specific");
  expect(
    customPresetFromSettings(
      "saved-a",
      "Desk",
      "dipole",
      { ...DEFAULT_WHIP, minimum: "90", maximum: "20" },
      "metric",
    ),
  ).toContain("Minimum");
  expect(
    customPresetFromSettings(
      "saved-a",
      "Desk",
      "dipole",
      { ...DEFAULT_WHIP, fixedSection: "-2" },
      "metric",
    ),
  ).toContain("non-negative");
});
it("bounds stored profiles and discards corrupt, duplicate and incompatible records", () => {
  const valid = customPresetFromSettings(
    "saved-test",
    "Desk",
    "whip",
    DEFAULT_WHIP,
    "metric",
  );
  if (typeof valid === "string") throw Error(valid);
  expect(
    sanitizeCustomPresets([
      null,
      {},
      valid,
      { ...valid, id: "saved-other", name: "DESK" },
      { ...valid, id: "saved-other", name: "Invalid", maximumM: -1 },
      { ...valid, id: "bad-id", name: "Bad" },
    ]),
  ).toEqual([valid]);
  const restored = sanitizeCustomPresets([
    { ...valid, originPreset: "rtl-long" },
  ]);
  expect(restored[0]!.originPreset).toBe("");
  expect(
    sanitizeCustomPresets(
      Array.from({ length: 30 }, (_, i) => ({
        ...valid,
        id: `saved-${i}`,
        name: `Setup ${i}`,
      })),
    ),
  ).toHaveLength(MAX_CUSTOM_PRESETS);
});
