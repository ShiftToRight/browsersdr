import { describe, expect, it } from "vitest";
import {
  bladeRfGainRange,
  bladeRfSettingsAtFrequency,
  DEFAULT_BLADERF_RX_SETTINGS,
  validateBladeRfRxSettings,
} from "./bladerfSettings";
import {
  loadSourcePreferences,
  saveSourcePreferences,
  sourcePreferenceDefaults,
} from "./sourcePreferences";

describe("bladeRF RX settings", () => {
  it.each([
    [100e6, -16, -17],
    [1.3e9, -16, -17],
    [1.3e9 + 1, -15, -11],
    [4e9, -15, -11],
    [4e9 + 1, -12, -2],
  ])("uses Nuand gain tables at %s Hz", (hz, min, offset) => {
    expect(bladeRfGainRange(hz)).toEqual({ min, max: 60, offset });
  });
  it("rejects malformed settings and clamps retained gain only when retuning", () => {
    for (const patch of [
      { rxInput: "TX1" },
      { rxInput: "RX3" },
      { gainMode: "toString" },
      { manualGainDb: NaN },
      { manualGainDb: 1.5 },
      { manualGainDb: 61 },
    ])
      expect(() =>
        validateBladeRfRxSettings(
          { ...DEFAULT_BLADERF_RX_SETTINGS, ...patch } as never,
          100e6,
        ),
      ).toThrow();
    expect(() =>
      validateBladeRfRxSettings(
        { ...DEFAULT_BLADERF_RX_SETTINGS, manualGainDb: -16 },
        5e9,
      ),
    ).toThrow();
    expect(
      bladeRfSettingsAtFrequency(
        { ...DEFAULT_BLADERF_RX_SETTINGS, manualGainDb: -16 },
        5e9,
      ).manualGainDb,
    ).toBe(-12);
  });
  it("persists RX input and gain independently of other receivers, with legacy defaults", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    const settings = {
      ...DEFAULT_BLADERF_RX_SETTINGS,
      rxInput: "RX2" as const,
      gainMode: "manual" as const,
      manualGainDb: -10,
    };
    saveSourcePreferences(storage, "bladerf", {
      ...sourcePreferenceDefaults("bladerf"),
      bladerfSettings: settings,
    });
    expect(loadSourcePreferences(storage, "bladerf").bladerfSettings).toEqual(
      settings,
    );
    expect(
      loadSourcePreferences(storage, "rtl-sdr").bladerfSettings,
    ).toBeUndefined();
    saved.set(
      "browsersdr.source.v1.bladerf",
      JSON.stringify({
        ...sourcePreferenceDefaults("bladerf"),
        bladerfSettings: undefined,
      }),
    );
    expect(loadSourcePreferences(storage, "bladerf").bladerfSettings).toEqual(
      DEFAULT_BLADERF_RX_SETTINGS,
    );
  });
});
