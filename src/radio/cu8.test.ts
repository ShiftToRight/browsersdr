import { describe, expect, it } from "vitest";
import type { RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { AcknowledgedRtlSource } from "./acknowledgedRtlSource";
import {
  CU8_FORMAT,
  decodeRecordingSamples,
  signedByteToFloat,
} from "./iqRecording";
import {
  cu8ByteToFloat,
  floatToCu8Byte,
} from "./cu8";
import { importSigmfRecording } from "./sigmfImport";
import { defaultModeSettings } from "./receiverConfig";

describe("canonical CU8 conversion", () => {
  it("decodes all 256 codes and the four reference codes exactly", () => {
    for (let byte = 0; byte < 256; byte += 1) {
      expect(cu8ByteToFloat(byte)).toBe((byte - 127.5) / 128);
    }
    expect([0, 127, 128, 255].map(cu8ByteToFloat)).toEqual([
      -0.99609375,
      -0.00390625,
      0.00390625,
      0.99609375,
    ]);
  });

  it("round-trips every byte through canonical decode and encode", () => {
    for (let byte = 0; byte < 256; byte += 1) {
      expect(floatToCu8Byte(cu8ByteToFloat(byte))).toBe(byte);
    }
  });

  it("makes live RTL, BrowserSDR replay, and ordinary SigMF CU8 agree", async () => {
    const bytes = Uint8Array.from([0, 255, 127, 128, 64, 192, 32, 224]);
    const device = {
      readSamples: async () => ({
        data: bytes.buffer.slice(0),
        frequency: 12_000_000,
        directSampling: false,
      }),
    } as unknown as RtlDevice;
    const live = await new AcknowledgedRtlSource(device).readSamples(4);
    const replay = decodeRecordingSamples(bytes, CU8_FORMAT);
    const sigmf = await importSigmfRecording(JSON.stringify({
      global: {
        "core:datatype": "cu8",
        "core:version": "1.2.6",
        "core:sample_rate": 48_000,
      },
      captures: [{
        "core:sample_start": 0,
        "core:frequency": 12_000_000,
        "core:datetime": "2026-09-28T00:00:00.000Z",
      }],
      annotations: [],
    }), bytes, { modeSettings: defaultModeSettings("AM") });
    const imported = decodeRecordingSamples(sigmf.data, sigmf.metadata);

    expect({ I: live.I, Q: live.Q }).toEqual(replay);
    expect(imported).toEqual(replay);
  });

  it("retains positive tone orientation and expected quantized amplitude and power", () => {
    const size = 4096;
    const bin = 37;
    const expectedAmplitude = 0.5;
    const bytes = new Uint8Array(size * 2);
    for (let index = 0; index < size; index += 1) {
      const phase = 2 * Math.PI * bin * index / size;
      bytes[index * 2] = floatToCu8Byte(expectedAmplitude * Math.cos(phase));
      bytes[index * 2 + 1] = floatToCu8Byte(expectedAmplitude * Math.sin(phase));
    }
    const { I, Q } = decodeRecordingSamples(bytes, CU8_FORMAT);
    const coefficient = (targetBin: number) => {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < size; index += 1) {
        const phase = -2 * Math.PI * targetBin * index / size;
        real += I[index]! * Math.cos(phase) - Q[index]! * Math.sin(phase);
        imaginary += I[index]! * Math.sin(phase) + Q[index]! * Math.cos(phase);
      }
      return Math.hypot(real, imaginary) / size;
    };
    const positive = coefficient(bin);
    const negative = coefficient(size - bin);
    expect(positive).toBeCloseTo(expectedAmplitude, 3);
    expect(positive ** 2).toBeCloseTo(expectedAmplitude ** 2, 3);
    expect(positive).toBeGreaterThan(negative * 100);
  });

  it("leaves signed CI8 conversion unchanged", () => {
    expect([0, 127, 128, 255].map(signedByteToFloat)).toEqual([
      0,
      127 / 128,
      -1,
      -1 / 128,
    ]);
  });
});
