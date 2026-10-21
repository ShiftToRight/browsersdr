import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { it, expect, vi, afterEach } from "vitest";
import { PocsagReceiver } from "./pocsagReceiver";
import { pocsagConfiguration, defaultPocsagSettings } from "./settings";
import { pocsagRecordingFixture } from "../testing/pocsagRecordingFixture";
import {
  decodeRecordingSamples,
  validateRecordingMetadata,
} from "../radio/iqRecording";
import { planChannelCapture } from "../radio/channelRecording";
import { createSigmfExport } from "../radio/sigmf";
import { importSigmfRecording } from "../radio/sigmfImport";
import {
  createSettingsShareUrl,
  readSettingsShare,
  SETTINGS_SHARE_SCHEMA,
} from "../radio/settingsShare";
import { defaultModeSettings } from "../radio/receiverConfig";
for (const inputRate of [1_024_000, 2_400_000, 3_200_000])
  for (const rate of [512, 1200, 2400] as const)
    it(`full I/Q reducer and recording metadata ${rate} at ${inputRate}`, () => {
      const recording = pocsagRecordingFixture(rate, true, inputRate);
      validateRecordingMetadata(recording.metadata, recording.data.length);
      const r = new PocsagReceiver();
      r.configure(
        pocsagConfiguration(recording.metadata.pocsag, inputRate, 7, 37000),
      );
      for (let n = 0; n < recording.metadata.sampleCount; n += 16381) {
        const samples = decodeRecordingSamples(
          recording.data.subarray(n * 2, (n + 16381) * 2),
          recording.metadata,
        );
        r.receive({ ...samples, firstSampleIndex: n, generation: 7 });
      }
      r.flush();
      const message = r.snapshot().value.messages.find((m) => m.complete);
      expect(message).toMatchObject({
        rate,
        address: 123456,
        function: 3,
        text: `POCSAG ${rate} DEMO <script>literal text</script>`,
      });
      expect(message?.provenance).toMatchObject({
        generation: 7,
        actualInputSampleRateHz: inputRate,
        selectedChannelOffsetHz: 37000,
      });
      expect(JSON.stringify(r.snapshot()).length).toBeLessThan(128 * 1024);
    });
it("native/channel capture retains a compatible decoder input clock", () => {
  expect(
    planChannelCapture({
      actualSampleRateHz: 2_400_000,
      hardwareCenterFrequencyHz: 440e6,
      selectedChannelFrequencyHz: 440e6,
      channelBandwidthHz: 20000,
      mode: "POCSAG",
    }).outputSampleRateHz,
  ).toBe(2_400_000);
});
it("settings links and SigMF carry strict POCSAG settings without message content", async () => {
  const settings = {
    ...defaultModeSettings("POCSAG"),
    pocsag: {
      ...defaultPocsagSettings(),
      rate: 2400 as const,
      polarity: "inverted" as const,
    },
  };
  const url = createSettingsShareUrl("https://example.com", {
    schema: SETTINGS_SHARE_SCHEMA,
    frequencyHz: 439987500,
    settings,
    display: { compact: false, floorDb: -100, rangeDb: 80 },
  });
  expect(readSettingsShare(new URL(url).hash).settings?.settings).toEqual(
    settings,
  );
  const recording = createDeterministicRecordingFixture(4096);
  recording.metadata = {
    ...recording.metadata,
    mode: "POCSAG",
    sampleRateHz: 1_024_000,
    channelBandwidthHz: 20000,
    durationSeconds: 4096 / 1_024_000,
    pocsag: settings.pocsag,
  };
  const exported = await createSigmfExport(recording);
  const imported = await importSigmfRecording(
    exported.metadataJson,
    recording.data,
    { modeSettings: { mode: "POCSAG", bandwidthHz: 20000, squelch: 0 } },
  );
  expect(imported.metadata.pocsag).toEqual(settings.pocsag);
  expect(
    Buffer.compare(Buffer.from(imported.data), Buffer.from(recording.data)),
  ).toBe(0);
});
afterEach(() => vi.unstubAllGlobals());
it("worker returns credits on bad/stale input and publishes before flush acknowledgement", async () => {
  const port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: undefined as unknown as (e: MessageEvent) => void,
  };
  vi.stubGlobal("self", port);
  await import("../workers/pocsag.worker");
  port.onmessage({
    data: {
      type: "configure",
      configuration: pocsagConfiguration(undefined, 1_024_000, 3),
    },
  } as MessageEvent);
  port.postMessage.mockClear();
  const I = new Float32Array(2),
    Q = new Float32Array(1);
  port.onmessage({
    data: {
      type: "samples",
      generation: 3,
      sequence: 42,
      firstSampleIndex: 0,
      I,
      Q,
    },
  } as MessageEvent);
  expect(port.postMessage.mock.calls.map(([m]) => m.type)).toEqual([
    "error",
    "consumed",
  ]);
  port.postMessage.mockClear();
  port.onmessage({
    data: {
      type: "samples",
      generation: 2,
      sequence: 43,
      firstSampleIndex: 0,
      I,
      Q,
    },
  } as MessageEvent);
  expect(port.postMessage.mock.calls[0]?.[0]).toMatchObject({
    type: "consumed",
    generation: 2,
  });
  port.postMessage.mockClear();
  port.onmessage({
    data: { type: "flush", generation: 3, sequence: 44 },
  } as MessageEvent);
  expect(port.postMessage.mock.calls.map(([m]) => m.type)).toEqual([
    "snapshot",
    "flushed",
  ]);
});
