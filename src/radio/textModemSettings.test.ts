import { describe, it, expect } from "vitest";
import {
  defaultModeSettings,
  normalizeModeSettings,
  validateModeSampleRate,
} from "./receiverConfig";
import { defaultTextModemSettings } from "../textmodem/settings";
import { validateBookmark } from "./bookmarks";
import {
  createSettingsShareUrl,
  readSettingsShare,
  SETTINGS_SHARE_SCHEMA,
} from "./settingsShare";
import { textModemRecordingFixture } from "../testing/textModemRecordingFixture";
import {
  validateRecordingMetadata,
  recordingMetadataJson,
} from "./iqRecording";
import { planChannelCapture } from "./channelRecording";
import { textModemExport } from "./textModemExport";
import { TextModemCore } from "../textmodem/receiver";
import { textModemConfiguration } from "../textmodem/settings";
import { decoderRecords, decoderViewExport } from "../ui/decoderViewModel";
import type { ReceiverSnapshot } from "./receiverController";

describe("text mode portable settings and provenance", () => {
  for (const mode of ["RTTY", "PSK31", "NAVTEX", "ACARS"] as const)
    it(`${mode} round-trips customized favorites, settings links and recording metadata`, () => {
      const settings = {
        ...defaultModeSettings(mode),
        textModem: {
          ...defaultTextModemSettings(),
          tuningOffsetHz: 1212,
          baud: 45.45 as const,
          shiftHz: 170 as const,
          inverted: true,
          stopBits: 2 as const,
        },
      };
      expect(normalizeModeSettings(settings)).toEqual(settings);
      const bookmark = validateBookmark({
        id: "00000000-0000-4000-8000-000000000001",
        name: mode,
        frequencyHz: 131037000,
        settings,
        tags: [],
        notes: "",
      });
      expect(bookmark.settings).toEqual(settings);
      const url = createSettingsShareUrl("https://browsersdr.com/", {
        schema: SETTINGS_SHARE_SCHEMA,
        frequencyHz: 131037000,
        settings,
        display: { compact: false, floorDb: -90, rangeDb: 60 },
      });
      expect(readSettingsShare(new URL(url).hash).settings?.settings).toEqual(
        settings,
      );
      const recording = textModemRecordingFixture(
        mode,
        1_024_000,
        false,
        settings.textModem,
      );
      expect(
        validateRecordingMetadata(
          JSON.parse(recordingMetadataJson(recording)),
          recording.data.length,
        ).textModem,
      ).toEqual(settings.textModem);
      expect(() =>
        validateRecordingMetadata(
          {
            ...recording.metadata,
            textModem: { ...settings.textModem, tuningOffsetHz: Infinity },
          },
          recording.data.length,
        ),
      ).toThrow(/text modem/);
      expect(() => validateModeSampleRate(mode, 48_000)).toThrow(
        /1\.024, 2\.4 or 3\.2/,
      );
      expect(
        planChannelCapture({
          actualSampleRateHz: 9_600_000,
          hardwareCenterFrequencyHz: 131000000,
          selectedChannelFrequencyHz: 131037000,
          channelBandwidthHz: settings.bandwidthHz,
          mode,
        }).dspSampleRateHz,
      ).toBe(2_400_000);
    });
  it("exports only matching generation/modem data and uses acquisition-clock metadata", () => {
    const core = new TextModemCore();
    core.configure(
      textModemConfiguration("RTTY", undefined, 1_024_000, 3, 37_000),
    );
    const receiver: ReceiverSnapshot = {
      lifecycle: "idle",
      message: "EOF",
      sessionGeneration: 3,
      session: {
        source: "replay",
        sessionGeneration: 3,
        requestedSampleRateHz: 1_024_000,
        actualSampleRateHz: 1_024_000,
        hardwareCenterFrequencyHz: 131000000,
        selectedChannelFrequencyHz: 131037000,
        mode: "RTTY",
        channelBandwidthHz: 8000,
        squelch: 0,
        gainDb: null,
        sampleFormat: "planar-f32-iq-normalized",
      },
      textModem: core.snapshot().value,
      textModemWorker: {
        generation: 3,
        queuedBlocks: 0,
        queueCapacityBlocks: 8,
        peakQueuedBlocks: 1,
        droppedInputBlocks: 0,
        droppedInputSamples: 0,
        staleResults: 0,
      },
    };
    expect(textModemExport(receiver)?.clock).toContain(
      "export time is not receive time",
    );
    expect(
      textModemExport({
        ...receiver,
        textModemWorker: { ...receiver.textModemWorker!, generation: 2 },
      }),
    ).toBeUndefined();
    receiver.textModem!.messages = [
      {
        sequence: 1,
        text: "<script>literal</script>",
        complete: false,
        integrity: "no checksum",
        provenance: core.snapshot().provenance,
      },
    ];
    const rows = decoderRecords(receiver, "RTTY");
    expect(rows[0]?.summary).toBe("<script>literal</script>");
    expect(
      JSON.parse(decoderViewExport(receiver, "RTTY", rows, "retained", false))
        .records,
    ).toHaveLength(1);
  });
});
