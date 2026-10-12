import { fakeRecordingStorage } from "../testing/fakeRecordingStorage";
import { deleteRecording, listRecordings } from "./recordingLibrary";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_RECORDING_FORMAT,
  ChannelCaptureFilter,
  planChannelCapture,
} from "./channelRecording";
import {
  CU8_FORMAT,
  IqRecorder,
  decodeRecordingSamples,
  parseRecording,
  recordingMetadataJson,
  recordingRoutingSampleRate,
  validateRecordingMetadata,
} from "./iqRecording";
import { hackrfRecordingFixture } from "../testing/hackrfRecordingFixture";
import { bladeRfRecordingFixture } from "../testing/bladerfRecordingFixture";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import { usrpB205Ci16RecordingFormat } from "./ci16Recording";
import {
  HACKRF_SAMPLE_RATES_HZ,
  BLADERF_SAMPLE_RATES_HZ,
} from "./sourceCapabilities";
import { USRP_B205_SAMPLE_RATES_HZ } from "./usrpB205Capabilities";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import { prepareRecordingExport } from "./recordingExportFormat";
import {
  defaultModeSettings,
  RECEIVER_MODES,
  validateModeSampleRate,
} from "./receiverConfig";
import type { SourceSessionMetadata } from "./types";

const session: SourceSessionMetadata = {
  source: "rtl-sdr",
  sessionGeneration: 1,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_100_000,
  mode: "AM",
  channelBandwidthHz: 15_000,
  squelch: 6,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
function tones(
  rate: number,
  count: number,
  frequencies: number[],
  amplitude = 0.3,
) {
  const I = new Float32Array(count),
    Q = new Float32Array(count);
  for (let n = 0; n < count; n++)
    for (const frequency of frequencies) {
      const angle = (2 * Math.PI * frequency * n) / rate;
      I[n] = I[n]! + amplitude * Math.cos(angle);
      Q[n] = Q[n]! + amplitude * Math.sin(angle);
    }
  return { I, Q };
}
function amplitude(
  I: Float32Array,
  Q: Float32Array,
  frequency: number,
  rate: number,
  skip = 200,
) {
  let re = 0,
    im = 0;
  for (let n = skip; n < I.length; n++) {
    const angle = (-2 * Math.PI * frequency * n) / rate;
    re += I[n]! * Math.cos(angle) - Q[n]! * Math.sin(angle);
    im += I[n]! * Math.sin(angle) + Q[n]! * Math.cos(angle);
  }
  return Math.hypot(re, im) / (I.length - skip);
}

it("preserves an offset station and rejects an out-of-band signal that would alias into it", () => {
  const plan = planChannelCapture(session);
  const input = tones(plan.inputSampleRateHz, 65_536, [101_000, 165_000]);
  const filter = new ChannelCaptureFilter(plan);
  const blocks = [
    filter.process(input.I.subarray(0, 32_768), input.Q.subarray(0, 32_768)),
    filter.process(input.I.subarray(32_768), input.Q.subarray(32_768)),
  ];
  const I = Float32Array.from(blocks.flatMap((b) => Array.from(b.I))),
    Q = Float32Array.from(blocks.flatMap((b) => Array.from(b.Q)));
  expect(plan.outputSampleRateHz).toBe(64_000);
  expect(amplitude(I, Q, 1000, plan.outputSampleRateHz)).toBeCloseTo(0.3, 2);
  expect(amplitude(I, Q, 1000, plan.outputSampleRateHz)).toBeLessThan(0.31); // aliased interferer adds < 0.01
  expect(input.I[0]).toBeCloseTo(0.6); // borrowed input remains intact
});
it("keeps DSP state across odd chunk boundaries", () => {
  const input = tones(session.actualSampleRateHz, 25_003, [102_000]);
  const whole = new ChannelCaptureFilter(planChannelCapture(session)).process(
    input.I,
    input.Q,
  );
  const split = new ChannelCaptureFilter(planChannelCapture(session));
  const blocks = [
    split.process(input.I.subarray(0, 123), input.Q.subarray(0, 123)),
    split.process(input.I.subarray(123, 4567), input.Q.subarray(123, 4567)),
    split.process(input.I.subarray(4567), input.Q.subarray(4567)),
  ];
  expect(Float32Array.from(blocks.flatMap((b) => Array.from(b.I)))).toEqual(
    whole.I,
  );
  expect(Float32Array.from(blocks.flatMap((b) => Array.from(b.Q)))).toEqual(
    whole.Q,
  );
});
it("converts gaps to the output clock and resets the filter instead of joining across missing input", () => {
  const recorder = new IqRecorder(
    session,
    undefined,
    8192,
    undefined,
    undefined,
    CU8_FORMAT,
    "memory",
    { captureCurrentChannel: true },
  );
  const block = tones(session.actualSampleRateHz, 2048, [101_000]);
  recorder.appendNormalized(block);
  recorder.addGap(17, "USB gap");
  recorder.addGap(15, "USB gap");
  recorder.appendNormalized(block);
  const result = recorder.finish();
  expect(result.metadata.knownGaps).toMatchObject([
    { afterSample: 128, missingSamples: 1 },
    { afterSample: 128, missingSamples: 1 },
  ]);
  expect(result.data.subarray(0, 256)).toEqual(result.data.subarray(256));
  validateRecordingMetadata(result.metadata, result.data.length);
});
it("honors reduced byte capacity and returns complete I/Q pairs", () => {
  const recorder = new IqRecorder(
    session,
    undefined,
    9,
    undefined,
    undefined,
    CU8_FORMAT,
    "memory",
    { captureCurrentChannel: true },
  );
  recorder.appendNormalized(tones(session.actualSampleRateHz, 2048, [101_000]));
  expect(recorder.status()).toMatchObject({
    state: "capacity-reached",
    sampleCount: 4,
    bytes: 8,
    sampleRateHz: 64_000,
  });
  expect(recorder.finish().metadata.stopReason).toBe("capacity");
});
it("rejects OFF, out-of-span channels and inconsistent processed provenance", () => {
  expect(() => planChannelCapture({ ...session, mode: "OFF" })).toThrow(
    /Select a channel/,
  );
  expect(() =>
    planChannelCapture({ ...session, selectedChannelFrequencyHz: 101_000_000 }),
  ).toThrow(/outside/);
  const recorder = new IqRecorder(
    session,
    undefined,
    8192,
    undefined,
    undefined,
    CU8_FORMAT,
    "memory",
    { captureCurrentChannel: true },
  );
  recorder.appendNormalized(tones(session.actualSampleRateHz, 2048, [101_000]));
  const result = recorder.finish();
  expect(() =>
    validateRecordingMetadata(
      { ...result.metadata, sampleRateHz: 48_000 },
      result.data.length,
    ),
  ).toThrow(/provenance/);
});
it.each(RECEIVER_MODES.filter((mode) => mode !== "OFF"))(
  "chooses a replay-compatible Auto rate for %s",
  (mode) => {
    const settings = defaultModeSettings(mode);
    const plan = planChannelCapture({
      ...session,
      actualSampleRateHz: 19_200_000,
      mode,
      channelBandwidthHz: settings.bandwidthHz,
    });
    expect(() =>
      validateModeSampleRate(mode, plan.dspSampleRateHz),
    ).not.toThrow();
    expect(plan.bandwidthHz).toBeLessThan(plan.outputSampleRateHz);
  },
);

const devices = [
  ...[1_024_000, 2_400_000].map((rate) => ({
    device: "rtl-sdr",
    rate,
    model: "",
  })),
  ...HACKRF_SAMPLE_RATES_HZ.map((rate) => ({
    device: "hackrf",
    rate,
    model: "",
  })),
  ...BLADERF_SAMPLE_RATES_HZ.flatMap((rate) =>
    ["xA4", "xA5", "xA9"].map((model) => ({ device: "bladerf", rate, model })),
  ),
  ...USRP_B205_SAMPLE_RATES_HZ.map((rate) => ({
    device: "usrp-b205",
    rate,
    model: "",
  })),
];
describe("device encoding and sample-rate matrix", () => {
  it.each(devices)(
    "captures and round-trips $device $model at $rate samples/s",
    async ({ device, rate, model }) => {
      let sourceSession: SourceSessionMetadata = {
        ...session,
        actualSampleRateHz: rate,
        requestedSampleRateHz: rate,
      };
      let format = CU8_FORMAT as import("./iqRecording").RecordingSampleFormat;
      if (device === "hackrf") {
        const fixture = await hackrfRecordingFixture(
          undefined,
          rate as (typeof HACKRF_SAMPLE_RATES_HZ)[number],
        );
        sourceSession = {
          ...fixture.session,
          selectedChannelFrequencyHz:
            fixture.session.hardwareCenterFrequencyHz + 100_000,
        };
        format = fixture.recording.metadata;
      } else if (device === "bladerf") {
        const fixture = await bladeRfRecordingFixture(
          undefined,
          rate as (typeof BLADERF_SAMPLE_RATES_HZ)[number],
          model as "xA4" | "xA5" | "xA9",
          5,
          -1,
        );
        sourceSession = {
          ...fixture.session,
          mode: "AM",
          channelBandwidthHz: 15_000,
          selectedChannelFrequencyHz:
            fixture.session.hardwareCenterFrequencyHz + 100_000,
        };
        format = fixture.format;
      } else if (device === "usrp-b205") {
        const details = usrpB205SessionDetails(
          100_000_000,
          rate as (typeof USRP_B205_SAMPLE_RATES_HZ)[number],
        );
        sourceSession = {
          ...sourceSession,
          source: "usrp-b205",
          usrpB205: details,
        };
        format = usrpB205Ci16RecordingFormat(details);
      }
      const count = 65_536;
      const input = tones(sourceSession.actualSampleRateHz, count, [
        sourceSession.selectedChannelFrequencyHz -
          sourceSession.hardwareCenterFrequencyHz +
          1000,
      ]);
      const bytes = new Uint8Array(count * format.bytesPerComplexSample);
      const view = new DataView(bytes.buffer);
      for (let n = 0; n < count; n++) {
        if (device === "rtl-sdr") {
          bytes[n * 2] = Math.round(input.I[n]! * 128 + 127.5);
          bytes[n * 2 + 1] = Math.round(input.Q[n]! * 128 + 127.5);
        } else if (device === "hackrf") {
          view.setInt8(n * 2, Math.round(input.I[n]! * 128));
          view.setInt8(n * 2 + 1, Math.round(input.Q[n]! * 128));
        } else {
          const scale =
            device === "bladerf" ? 2048 : 32767 / 0.9999997558594347;
          view.setInt16(
            n * 4 + (device === "usrp-b205" ? 2 : 0),
            Math.round(input.I[n]! * scale),
            true,
          );
          view.setInt16(
            n * 4 + (device === "usrp-b205" ? 0 : 2),
            Math.round(input.Q[n]! * scale),
            true,
          );
        }
      }
      const original = bytes.slice();
      const recorder = new IqRecorder(
        sourceSession,
        "2026-09-30T00:00:00.000Z",
        131072,
        undefined,
        undefined,
        format,
        "memory",
        { captureCurrentChannel: true },
      );
      if (device === "rtl-sdr") recorder.appendCu8(bytes);
      else if (device === "hackrf") recorder.appendCi8(bytes);
      else if (device === "bladerf") recorder.appendBladeRfSc16(bytes);
      else recorder.appendUsrpSc16(bytes);
      const result = recorder.finish();
      expect(bytes).toEqual(original);
      expect(result.metadata.format).toBe(CHANNEL_RECORDING_FORMAT);
      expect(result.data.length).toBeLessThan(bytes.length / 8);
      expect(result.metadata.centerFrequencyHz).toBe(
        sourceSession.selectedChannelFrequencyHz,
      );
      expect(result.metadata.sampleCount).toBe(
        Math.floor(count / planChannelCapture(sourceSession).decimation),
      );
      expect(result.metadata.durationSeconds).toBeCloseTo(
        count / sourceSession.actualSampleRateHz,
        3,
      );
      const decoded = decodeRecordingSamples(result.data, result.metadata);
      expect(
        amplitude(
          decoded.I,
          decoded.Q,
          1000,
          result.metadata.sampleRateHz,
          Math.min(100, decoded.I.length / 2),
        ),
      ).toBeCloseTo(0.3, 2);
      expect(
        parseRecording(recordingMetadataJson(result), result.data).metadata,
      ).toEqual(result.metadata);
      const browserExport = await prepareRecordingExport(result, "browsersdr");
      expect(browserExport.files[0].name).toMatch(
        format.bytesPerComplexSample === 4 ? /\.ci16$/ : /\.ci8$/,
      );
      const sigmf = await createSigmfExport(result);
      expect(sigmf.metadata.global["core:sample_rate"]).toBe(
        result.metadata.sampleRateHz,
      );
      const imported = await importSigmfRecording(
        sigmf.metadataJson,
        result.data,
        { modeSettings: defaultModeSettings("AM") },
      );
      expect(imported.data).toEqual(result.data);
      expect(recordingRoutingSampleRate(imported.metadata)).toBe(
        recordingRoutingSampleRate(result.metadata),
      );
    },
  );
});

it("rejects a neighboring station as well as signals outside the reduced Nyquist span", () => {
  const plan = planChannelCapture(session);
  const input = tones(plan.inputSampleRateHz, 32768, [120_000, 165_000]);
  const output = new ChannelCaptureFilter(plan).process(input.I, input.Q);
  expect(
    amplitude(output.I, output.Q, 20_000, plan.outputSampleRateHz),
  ).toBeLessThan(0.003);
  expect(
    amplitude(output.I, output.Q, 1000, plan.outputSampleRateHz),
  ).toBeLessThan(0.003);
});

it.each([false, true])(
  "streams reduced channel bytes to OPFS (16-bit = %s)",
  async (wide) => {
    const fixture = wide ? await bladeRfRecordingFixture() : undefined;
    const inputSession = fixture
      ? { ...fixture.session, mode: "AM" as const, channelBandwidthHz: 15_000 }
      : session;
    const { getDirectory } = fakeRecordingStorage();
    try {
      const capture = () =>
        new IqRecorder(
          inputSession,
          "2026-09-30T00:00:00.000Z",
          131072,
          undefined,
          undefined,
          fixture?.format,
          "opfs",
          { captureCurrentChannel: true },
        );
      const recorder = capture();
      const memory = new IqRecorder(
        inputSession,
        "2026-09-30T00:00:00.000Z",
        131072,
        undefined,
        undefined,
        fixture?.format,
        "memory",
        { captureCurrentChannel: true },
      );
      if (wide) {
        const bytes = new Uint8Array(32768 * 4),
          view = new DataView(bytes.buffer);
        for (let n = 0; n < 32768; n++) {
          view.setInt16(n * 4, 512, true);
          view.setInt16(n * 4 + 2, -256, true);
        }
        recorder.appendBladeRfSc16(bytes);
        memory.appendBladeRfSc16(bytes);
        bytes.fill(0);
      } else {
        const input = tones(session.actualSampleRateHz, 32768, [101000]);
        recorder.appendNormalized(input);
        memory.appendNormalized(input);
        input.I.fill(0);
        input.Q.fill(0);
      }
      const result = recorder.finish(),
        expected = memory.finish();
      const blob = await result.dataBlob!;
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected.data);
      expect(result.metadata).toEqual(expected.metadata);
      expect(result.data).toHaveLength(0);
      expect(
        (await createSigmfExport(result)).metadata.global["core:sample_rate"],
      ).toBe(result.metadata.sampleRateHz);
      await result.releaseData!();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await listRecordings())[0]?.state).toBe("ready");
      await deleteRecording(result.libraryId!);
      expect(await listRecordings()).toEqual([]);
      getDirectory.mockClear();
      expect(
        () =>
          new IqRecorder(
            { ...inputSession, mode: "OFF" },
            undefined,
            131072,
            undefined,
            undefined,
            fixture?.format,
            "opfs",
            { captureCurrentChannel: true },
          ),
      ).toThrow(/Select a channel/);
      expect(getDirectory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
