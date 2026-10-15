import { expect, it } from "vitest";
import { defaultModeSettings, normalizeModeSettings, createSignalsMode, validateModeSampleRate } from "./receiverConfig";
import { validateBookmark } from "./bookmarks";
import { createSettingsShareUrl, readSettingsShare, SETTINGS_SHARE_SCHEMA } from "./settingsShare";
import { defaultTextModemSettings, DEFAULT_IMAGE_SETTINGS, DEFAULT_CW_SETTINGS } from "../textmodem/settings";
import { imageCwRecordingFixture } from "../testing/imageCwRecordingFixture";
import { recordingMetadataJson, validateRecordingMetadata } from "./iqRecording";
import { planChannelCapture } from "./channelRecording";

it.each(["WEFAX", "SSTV", "CW-TEXT"] as const)("%s settings survive favorites, links, recordings and replay validation", mode => {
  const textModem = { ...defaultTextModemSettings(), image: { ...DEFAULT_IMAGE_SETTINGS, automatic: false, shiftHz: 850 as const }, cw: { ...DEFAULT_CW_SETTINGS, wpm: 25, autoSpeed: true } };
  const settings = { ...defaultModeSettings(mode), textModem };
  const bookmark = validateBookmark({ id: "00000000-0000-4000-8000-000000000001", name: mode, frequencyHz: 131037000, settings, tags: [], notes: "" });
  expect(bookmark.settings).toEqual(settings);
  const url = createSettingsShareUrl("https://browsersdr.com/", { schema: SETTINGS_SHARE_SCHEMA, frequencyHz: 131037000, settings, display: { compact: false, floorDb: -90, rangeDb: 60 } });
  expect(readSettingsShare(new URL(url).hash).settings?.settings).toEqual(settings);
  const fixture = imageCwRecordingFixture(mode, textModem);
  const metadata = validateRecordingMetadata(JSON.parse(recordingMetadataJson(fixture)), fixture.data.length);
  expect(metadata.textModem).toEqual(textModem);
  expect(metadata.beatToneHz).toBe(settings.beatToneHz);
  expect(() => validateModeSampleRate(mode, 192000)).toThrow(/1.024 or 2.4/);
  expect(() => normalizeModeSettings({ ...settings, textModem: { ...textModem, cw: { ...textModem.cw, wpm: 0 } } })).toThrow(/5–60/);
  expect(() => normalizeModeSettings({ ...settings, textModem: { ...textModem, image: { ...textModem.image, lpm: 30 as 60 } } })).toThrow(/image decoder/);
  const session = { actualSampleRateHz: metadata.sampleRateHz, hardwareCenterFrequencyHz: metadata.centerFrequencyHz, selectedChannelFrequencyHz: metadata.selectedChannelFrequencyHz, channelBandwidthHz: metadata.channelBandwidthHz, mode };
  expect(planChannelCapture(session).outputSampleRateHz).toBe(1_024_000);
  if (mode === "CW-TEXT") expect(createSignalsMode(settings)).toEqual({ scheme: "CW", bandwidth: 500 });
  else expect(() => createSignalsMode(settings)).toThrow(/digital receiver/);
});
