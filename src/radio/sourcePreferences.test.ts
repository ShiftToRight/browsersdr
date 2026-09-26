import { describe, expect, it } from "vitest";
import { compatibleSourceRate, loadSourceSelection, loadSourcePreferences, saveSourcePreferences, sourcePreferenceDefaults } from "./sourcePreferences";
import { defaultModeSettings } from "./receiverConfig";
function storage(values: Record<string, string> = {}) {
  return { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; }, values };
}
describe("source preferences", () => {
  it("migrates legacy RTL settings without sharing them with Pro or synthetic", () => {
    const saved = storage({ "browsersdr.gainDb": "49.6", "browsersdr.sampleRateHz": "2400000", "browsersdr.mode": "ADS-B", "browsersdr.channelFrequencyMhz": "1090" });
    expect(loadSourcePreferences(saved, "rtl-sdr")).toMatchObject({ gainDb: 49.6, sampleRateHz: 2_400_000, modeSettings: { mode: "ADS-B" } });
    expect(loadSourcePreferences(saved, "hackrf")).toEqual(sourcePreferenceDefaults("hackrf"));
    expect(loadSourcePreferences(saved, "synthetic")).toEqual(sourcePreferenceDefaults("synthetic"));
  });
  it("round trips independent settings above 4.3 GHz", () => {
    const saved = storage();
    const pro = { ...sourcePreferenceDefaults("hackrf"), frequencyHz: 5_600_000_001, hardwareSettings: { ...sourcePreferenceDefaults("hackrf").hardwareSettings!, rxVgaGainDb: 62 } };
    saveSourcePreferences(saved, "hackrf", pro);
    saveSourcePreferences(saved, "rtl-sdr", { ...sourcePreferenceDefaults("rtl-sdr"), gainDb: 25 });
    expect(loadSourcePreferences(saved, "hackrf")).toEqual(pro);
    expect(loadSourcePreferences(saved, "rtl-sdr").gainDb).toBe(25);
  });
  it("persists CW filter and beat-tone settings", () => {
    const saved = storage();
    const preferences = { ...sourcePreferenceDefaults("rtl-sdr"), modeSettings: { mode: "CW" as const, bandwidthHz: 250, squelch: 0, beatToneHz: 750 } };
    saveSourcePreferences(saved, "rtl-sdr", preferences);
    expect(loadSourcePreferences(saved, "rtl-sdr").modeSettings).toEqual(preferences.modeSettings);
  });
  it("persists validated SRD modulation and decoder settings", () => {
    const saved = storage();
    const modeSettings = defaultModeSettings("SRD");
    modeSettings.srd = {
      ...modeSettings.srd!,
      modulation: "2fsk",
      protocol: "fineoffset-wh51",
    };
    saveSourcePreferences(saved, "rtl-sdr", {
      ...sourcePreferenceDefaults("rtl-sdr"),
      modeSettings,
    });
    expect(loadSourcePreferences(saved, "rtl-sdr").modeSettings).toEqual(modeSettings);
  });
  it.each(["not json", "null", '{"sampleRateHz":2400000}', JSON.stringify({ ...sourcePreferenceDefaults("hackrf"), gainDb: null }), JSON.stringify({ ...sourcePreferenceDefaults("hackrf"), sampleRateHz: 10_000_000 }), JSON.stringify({ ...sourcePreferenceDefaults("hackrf"), hardwareSettings: { ...sourcePreferenceDefaults("hackrf").hardwareSettings, rxVgaGainDb: 3 } })])("rejects incompatible saved settings %s", (value) => {
    expect(loadSourcePreferences(storage({ "browsersdr.source.v1.hackrf": value }), "hackrf")).toEqual(sourcePreferenceDefaults("hackrf"));
  });
  it("does not overwrite valid preferences with incomplete drafts", () => {
    const saved = storage();
    saveSourcePreferences(saved, "hackrf", sourcePreferenceDefaults("hackrf"));
    const previous = saved.values["browsersdr.source.v1.hackrf"];
    saveSourcePreferences(saved, "hackrf", { ...sourcePreferenceDefaults("hackrf"), frequencyHz: NaN });
    expect(saved.values["browsersdr.source.v1.hackrf"]).toBe(previous);
  });
  it("uses source rate capabilities for digital selection", () => {
    expect(compatibleSourceRate("hackrf", "DAB", 1_024_000)).toBe(2_400_000);
    expect(compatibleSourceRate("hackrf", "ADS-B", 1_024_000)).toBe(2_400_000);
    expect(compatibleSourceRate("synthetic", "AIS", 1_024_000)).toBeUndefined();
    expect(compatibleSourceRate("replay", "DAB", 1_024_000)).toBeUndefined();
    const saved = storage({ "browsersdr.source.v1.hackrf": JSON.stringify({ ...sourcePreferenceDefaults("hackrf"), modeSettings: defaultModeSettings("DAB") }) });
    expect(loadSourcePreferences(saved, "hackrf").modeSettings.mode).toBe("WBFM");
  });
  it("tolerates unavailable storage", () => {
    const saved = { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); } };
    expect(loadSourcePreferences(saved, "hackrf")).toEqual(sourcePreferenceDefaults("hackrf"));
    expect(() => saveSourcePreferences(saved, "hackrf", sourcePreferenceDefaults("hackrf"))).not.toThrow();
  });
});


it("does not let extra stored keys override source or frequency validation", () => {
  const saved = storage({ "browsersdr.source.v1.hackrf": JSON.stringify({ ...sourcePreferenceDefaults("hackrf"), source: "rtl-sdr", channelFrequencyHz: 100_000_000, frequencyHz: 7_000_000_000 }) });
  expect(loadSourcePreferences(saved, "hackrf")).toEqual(sourcePreferenceDefaults("hackrf"));
});
it("remembers a valid live source and requires explicit replay file selection", () => {
  const saved = storage();
  saveSourcePreferences(saved, "hackrf", sourcePreferenceDefaults("hackrf"));
  expect(loadSourceSelection(saved)).toBe("hackrf");
  saved.setItem("browsersdr.selectedSource", "replay");
  expect(loadSourceSelection(saved)).toBe("rtl-sdr");
});
