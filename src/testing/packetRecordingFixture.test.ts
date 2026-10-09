import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { packetRecordingFixture } from "./packetRecordingFixture";
import { validateRecordingMetadata } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import {
  createSettingsShareUrl,
  readSettingsShare,
  SETTINGS_SHARE_SCHEMA,
} from "../radio/settingsShare";
import { validateBookmark } from "../radio/bookmarks";

// Export generated local review files only when explicitly requested by the test operator.
describe("packet mode portable settings and metadata", () => {
  it.each(["APRS", "RS41"] as const)(
    "round-trips %s without inferring its mode or copying arbitrary data",
    async (mode) => {
      const fixture = packetRecordingFixture(mode);
      expect(
        validateRecordingMetadata(fixture.metadata, fixture.data.byteLength)
          .mode,
      ).toBe(mode);
      const settings = defaultModeSettings(mode);
      const url = createSettingsShareUrl("https://browsersdr.com/", {
        schema: SETTINGS_SHARE_SCHEMA,
        frequencyHz: 144_800_000,
        settings,
        display: { compact: true, floorDb: -80, rangeDb: 60 },
      });
      expect(readSettingsShare(new URL(url).hash).settings?.settings).toEqual(
        settings,
      );
      expect(
        validateBookmark({
          id: "00000000-0000-4000-8000-000000000000",
          name: "Test",
          frequencyHz: 144_800_000,
          settings,
          tags: [],
          notes: "",
        }).settings,
      ).toEqual(settings);
      if (process.env.PACKET_REVIEW_FILES === "1") {
        await mkdir(".local/aprs-rs41-2026-10-09/fixtures", {
          recursive: true,
        });
        await writeFile(
          `.local/aprs-rs41-2026-10-09/fixtures/${mode}.cu8`,
          fixture.data,
        );
        await writeFile(
          `.local/aprs-rs41-2026-10-09/fixtures/${mode}.json`,
          JSON.stringify(fixture.metadata, null, 2),
        );
      }
    },
  );
});
