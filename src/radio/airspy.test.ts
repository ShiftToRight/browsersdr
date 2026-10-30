import { airspyGainStages } from "./airspyGain";
import { describe, expect, it, vi } from "vitest";
import { fakeRecordingStorage } from "../testing/fakeRecordingStorage";
import { listRecordings, openRecording } from "./recordingLibrary";
import { CHANNEL_RECORDING_FORMAT } from "./channelRecording";
import { AirspyConversion } from "./airspyConversion";
import { AirspyChannelFilter } from "./airspyChannel";
import { AirspyResampler } from "./airspyResampler";
import { getIqResampler } from "@jtarrio/signals/dsp/resamplers.js";
import { AIRSPY_OUTPUT_RATES, airspyChannelRate } from "./airspySettings";
import {
  DEFAULT_AIRSPY_SETTINGS,
  validateAirspySettings,
  type AirspySettings,
} from "./airspySettings";
import { defaultModeSettings } from "./receiverConfig";
import {
  validateSourceConfiguration,
  validateSourceRoute,
  channelSampleRate,
} from "./sourceCapabilities";
import { airspyRecordingFormat } from "./airspyRecording";
import {
  IqRecorder,
  decodeRecordingSamples,
  recordingSampleFormat,
  validateRecordingMetadata,
  recordingRoutingSampleRate,
} from "./iqRecording";
import { createSigmfExport } from "./sigmf";
import { importSigmfRecording } from "./sigmfImport";
import {
  loadSourcePreferences,
  saveSourcePreferences,
} from "./sourcePreferences";
import type { SourceSessionMetadata } from "./types";
import oracle from "../testing/fixtures/airspy/conversion-oracle.json";

const settings = (patch: Partial<AirspySettings> = {}): AirspySettings => ({
  ...DEFAULT_AIRSPY_SETTINGS,
  ...patch,
});
function raw(values: number[], packed = false) {
  const bytes = new Uint8Array(values.length * (packed ? 1.5 : 2)),
    view = new DataView(bytes.buffer);
  if (!packed) values.forEach((value, n) => view.setUint16(n * 2, value, true));
  else
    for (let n = 0; n < values.length; n += 8) {
      // Literal vendor word layout, distinct from the converter's unpacking operations.
      const bits = values
        .slice(n, n + 8)
        .map((value) => value.toString(2).padStart(12, "0"))
        .join("");
      for (let word = 0; word < 3; word++)
        view.setUint32(
          (n / 8) * 12 + word * 4,
          parseInt(bits.slice(word * 32, word * 32 + 32), 2),
          true,
        );
    }
  return bytes;
}
export function airspyTestSession(rate = 2_500_000): SourceSessionMetadata {
  return {
    source: "airspy",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: 100_000_000,
    selectedChannelFrequencyHz: 100_000_000,
    mode: "WBFM",
    channelBandwidthHz: 150_000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
    airspy: {
      identity: {
        boardId: 0,
        firmware: "AirSpy fixture",
        serial: "0000000000000001",
        sampleRates: [10_000_000, 2_500_000],
        rateProfile: "r2",
      },
      settings: settings(),
      deviceSampleRateHz: rate,
      adcSampleRateHz: rate * 2,
      outputSampleRateHz: rate,
      requestedCenterFrequencyHz: 100_000_000,
      correctedDeviceFrequencyHz: 100_000_000,
      rateEvidence: "firmware-advertised-and-usb-acknowledged",
      conversion: "airspy-fs4-real-to-iq-v1",
    },
  };
}
it.each([2_500_000, 10_000_000, 3_000_000, 6_000_000])(
  "retains and reimports APRS channel I/Q with its actual clock from %i Hz Airspy input",
  async (rate) => {
    fakeRecordingStorage();
    try {
      const session = airspyTestSession(rate);
      if (rate === 3_000_000 || rate === 6_000_000) {
        session.airspy!.identity.sampleRates = [6_000_000, 3_000_000];
        session.airspy!.identity.rateProfile = "mini";
      }
      session.mode = "APRS";
      session.channelBandwidthHz = 20_000;
      session.selectedChannelFrequencyHz += 100_000;
      const recorder = new IqRecorder(
        session,
        undefined,
        131_072,
        undefined,
        undefined,
        airspyRecordingFormat(session.airspy!),
        "opfs",
        { captureCurrentChannel: true },
      );
      const bytes = new Uint8Array(32_768 * 4);
      const view = new DataView(bytes.buffer);
      for (let n = 0; n < 32_768; n++) {
        const phase = (2 * Math.PI * 101_000 * n) / rate;
        view.setInt16(n * 4, Math.round(8192 * Math.cos(phase)), true);
        view.setInt16(n * 4 + 2, Math.round(8192 * Math.sin(phase)), true);
      }
      recorder.appendCi16(bytes.subarray(0, 12_004));
      recorder.appendCi16(bytes.subarray(12_004));
      const recording = recorder.finish();
      const data = new Uint8Array(
        await (await recording.dataBlob!).arrayBuffer(),
      );
      const outputRate =
        rate === 3_000_000 || rate === 6_000_000 ? 3_000_000 : 2_500_000;
      expect(recording.metadata.format).toBe(CHANNEL_RECORDING_FORMAT);
      expect(recording.metadata.sampleRateHz).toBe(outputRate);
      expect(recording.metadata.sampleCount).toBe(32_768 / (rate / outputRate));
      expect(data.length).toBe(recording.metadata.sampleCount * 4);
      expect(
        channelSampleRate(recordingRoutingSampleRate(recording.metadata)),
      ).toBe(2_400_000);
      if (recording.metadata.format !== CHANNEL_RECORDING_FORMAT)
        throw new Error("Expected channel recording");
      const channelMetadata = recording.metadata;
      expect(() =>
        validateRecordingMetadata(
          {
            ...channelMetadata,
            sampleRateHz: 2_600_000,
            durationSeconds: recording.metadata.sampleCount / 2_600_000,
            channelCapture: {
              ...channelMetadata.channelCapture,
              inputSampleRateHz:
                2_600_000 * channelMetadata.channelCapture.decimation,
              outputSampleRateHz: 2_600_000,
              dspSampleRateHz: 2_600_000,
            },
          },
          data.length,
        ),
      ).toThrow(/Digital channel input rate/);
      const exported = await createSigmfExport(recording);
      expect(exported.metadata.global["core:sample_rate"]).toBe(outputRate);
      const imported = await importSigmfRecording(exported.metadataJson, data, {
        modeSettings: defaultModeSettings("APRS"),
      });
      expect(imported.data).toEqual(data);
      expect(imported.metadata.sampleRateHz).toBe(outputRate);
      await recording.releaseData!();
      expect((await listRecordings())[0]?.state).toBe("ready");
      const retained = await openRecording(recording.libraryId!);
      expect(retained.metadata.mode).toBe("APRS");
      expect(
        new Uint8Array(await (await retained.dataBlob!).arrayBuffer()),
      ).toEqual(data);
      await retained.releaseData!();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

describe("Airspy ADC and clock contract", () => {
  for (const rate of AIRSPY_OUTPUT_RATES)
    it(`matches the general rational FIR across split blocks at ${rate} Hz`, () => {
      const output = airspyChannelRate(rate);
      let intermediate = rate;
      while (intermediate >= output * 2) intermediate /= 2;
      let gcd = intermediate,
        remainder = output;
      while (remainder) {
        const next = gcd % remainder;
        gcd = remainder;
        remainder = next;
      }
      const up = output / gcd,
        down = intermediate / gcd;
      const coefficients = Float32Array.from(
        { length: 63 * down + 1 },
        (_, n) => Math.sin(n * 0.17) / (63 * down),
      );
      const reference = getIqResampler(intermediate, output, {
        kernel: coefficients,
      });
      const optimized = new AirspyResampler(up, down, coefficients);
      let offset = 0;
      for (const length of [4096, 1, 7, 256, 128, 513, 4096]) {
        const I = Float32Array.from({ length }, (_, n) =>
          Math.sin((offset + n) * 0.31),
        );
        const Q = Float32Array.from({ length }, (_, n) =>
          Math.cos((offset + n) * 0.19),
        );
        const [expectedI, expectedQ] = reference.resample(I, Q);
        const count = optimized.process(I, Q);
        expect(count).toBe(expectedI.length);
        for (let n = 0; n < count; n++) {
          expect(I[n]).toBeCloseTo(expectedI[n]!, 6);
          expect(Q[n]).toBeCloseTo(expectedQ[n]!, 6);
        }
        offset += length;
      }
    });
  it("resets warm-up DC, FIR, delay and decimation histories before acquisition", () => {
    const input = raw(
      Array.from({ length: 512 }, (_, n) => (n * 73 + n * n * 19) % 4096),
    );
    const converter = new AirspyConversion(
      settings({ decimation: 4 }),
      10_000_000,
    );
    const expected = new AirspyConversion(
      settings({ decimation: 4 }),
      10_000_000,
    ).process(input);
    for (let n = 0; n < 8; n++) converter.process(input);
    converter.reset();
    const actual = converter.process(input);
    expect(actual.I).toEqual(expected.I);
    expect(actual.Q).toEqual(expected.Q);
  });
  for (const packing of [false, true])
    it(`matches independently compiled MIT libairspy conversion, packing=${packing}, arbitrary USB boundaries`, () => {
      const values = Array.from(
        { length: 512 },
        (_, n) => (n * 73 + n * n * 19) % 4096,
      );
      const input = raw(values, packing),
        converter = new AirspyConversion(settings({ packing }), 2_500_000);
      const I: number[] = [],
        Q: number[] = [];
      for (let start = 0; start < input.length; start += 53) {
        const block = converter.process(input.subarray(start, start + 53));
        I.push(...block.I);
        Q.push(...block.Q);
      }
      expect(I).toHaveLength(256);
      expect(Q).toHaveLength(256);
      for (let n = 0; n < I.length; n++) {
        expect(I[n]).toBeCloseTo(oracle.I[n]!, 6);
        expect(Q[n]).toBeCloseTo(oracle.Q[n]!, 6);
      }
    });
  it("rejects malformed ADC words instead of displaying corrupted samples", () => {
    expect(() =>
      new AirspyConversion(settings(), 2_500_000).process(
        raw([0, 4096, 2048, 2048]),
      ),
    ).toThrow(/12 bits/);
  });
  for (const factor of [1, 2, 4, 8, 16, 32, 64] as const)
    it(`retains exact count and phase through decimation ${factor}`, () => {
      const values = Array.from({ length: 32768 }, (_, n) =>
        Math.round(2048 + 500 * Math.cos((Math.PI * n) / 2)),
      );
      const block = new AirspyConversion(
        settings({ decimation: factor }),
        10_000_000,
      ).process(raw(values));
      expect(block.I.length).toBe(16384 / factor);
      expect(block.Q.length).toBe(block.I.length);
      expect([...block.I, ...block.Q].every(Number.isFinite)).toBe(true);
    });
  for (const rate of [2_500_000, 3_000_000, 6_000_000, 10_000_000])
    it(`resamples actual ${rate} Hz clock to 2.4 MS/s without rate relabelling`, () => {
      const filter = new AirspyChannelFilter(rate);
      let count = 0;
      for (let n = 0; n < 10; n++)
        count += filter.process(
          new Float32Array(16384),
          new Float32Array(16384),
        );
      expect(Math.abs(count - (163840 * 2_400_000) / rate)).toBeLessThanOrEqual(
        1,
      );
    });
  for (const rate of [2_500_000, 3_000_000, 6_000_000, 10_000_000])
    it(`qualifies channel passband and alias rejection at ${rate}`, () => {
      function rms(tone: number) {
        const filter = new AirspyChannelFilter(rate);
        let power = 0,
          total = 0;
        for (let block = 0; block < 8; block++) {
          const I = new Float32Array(16384),
            Q = new Float32Array(16384);
          for (let n = 0; n < I.length; n++) {
            const angle = (2 * Math.PI * tone * (block * 16384 + n)) / rate;
            I[n] = Math.cos(angle);
            Q[n] = Math.sin(angle);
          }
          const count = filter.process(I, Q);
          if (block > 3)
            for (let n = 0; n < count; n++) {
              power += I[n]! ** 2 + Q[n]! ** 2;
              total++;
            }
        }
        return Math.sqrt(power / total);
      }
      expect(rms(800_000)).toBeGreaterThan(0.98);
      expect(rms(1_220_000)).toBeLessThan(0.001);
    });
  it("uses the full preset schedules and disables AGC for both presets", () => {
    expect(airspyGainStages(settings({ gain: 0 }))).toEqual({
      lna: 0,
      mixer: 0,
      vga: 4,
      lnaAgc: false,
      mixerAgc: false,
    });
    expect(airspyGainStages(settings({ gain: 21, lnaAgc: true }))).toEqual({
      lna: 14,
      mixer: 12,
      vga: 13,
      lnaAgc: false,
      mixerAgc: false,
    });
    expect(
      airspyGainStages(settings({ gainMode: "sensitivity", gain: 10 })),
    ).toMatchObject({ lna: 12, mixer: 4, vga: 5 });
    expect(
      airspyGainStages(
        settings({ gainMode: "manual", lnaAgc: true, mixerAgc: true }),
      ),
    ).toMatchObject({ lnaAgc: true, mixerAgc: true });
  });
  it("rejects invalid stage/format values before hardware access and respects reduced passband", () => {
    for (const patch of [
      { lna: 15 },
      { mixer: -1 },
      { vga: 1.5 },
      { gain: 22 },
      { ppm: NaN },
      { decimation: 3 },
    ])
      expect(() =>
        validateAirspySettings(settings(patch as Partial<AirspySettings>)),
      ).toThrow();
    expect(() =>
      validateSourceConfiguration({
        source: "airspy",
        channelFrequencyHz: 100e6,
        modeSettings: defaultModeSettings("WBFM"),
        airspySettings: settings({ decimation: 64 }),
      }),
    ).toThrow();
    expect(() =>
      validateSourceRoute(
        "airspy",
        defaultModeSettings("DAB"),
        2_500_000,
        200e6,
      ),
    ).not.toThrow();
    expect(() =>
      validateSourceRoute(
        "airspy",
        defaultModeSettings("DAB"),
        1_250_000,
        200e6,
      ),
    ).toThrow();
  });
  it("never restores saved antenna power", () => {
    const map = new Map<string, string>(),
      storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
      };
    saveSourcePreferences(storage, "airspy", {
      frequencyHz: 100e6,
      sampleRateHz: 2_500_000,
      modeSettings: defaultModeSettings("WBFM"),
      airspySettings: settings({ biasTee: true, packing: true }),
    });
    expect(
      loadSourcePreferences(storage, "airspy").airspySettings,
    ).toMatchObject({ biasTee: false, packing: true });
  });
  for (const rate of [2_500_000, 10_000_000])
    it(`round trips converted int16 capture at ${rate} through SigMF with exact bytes and honest provenance`, async () => {
      const session = airspyTestSession(rate),
        format = airspyRecordingFormat(session.airspy!);
      const recorder = new IqRecorder(
        session,
        "2026-10-28T12:00:00.000Z",
        4096,
        "Converted ADC test",
        undefined,
        format,
      );
      const bytes = new Uint8Array([0, 128, 255, 127, 0, 64, 0, 192]);
      recorder.appendCi16(bytes);
      const recording = recorder.finish("user");
      const parsed = validateRecordingMetadata(recording.metadata, 8);
      const decoded = decodeRecordingSamples(
        bytes,
        recordingSampleFormat(parsed),
      );
      expect(decoded.I[0]).toBe(-1);
      expect(decoded.Q[0]).toBe(32767 / 32768);
      const exported = await createSigmfExport(recording);
      expect(exported.metadata.global["core:description"]).toContain(
        "not unchanged ADC bytes",
      );
      const imported = await importSigmfRecording(
        exported.metadataJson,
        bytes,
        { modeSettings: defaultModeSettings("WBFM") },
      );
      expect(imported.data).toEqual(bytes);
      expect(imported.metadata.sampleRateHz).toBe(rate);
      expect(imported.metadata.format).toBe(format.format);
    });
});
