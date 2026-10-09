import { describe, expect, it } from "vitest";
import {
  audioFrame,
  configFrom,
  defaultTune,
  fftFrame,
  ImaDecoder,
  receiverUrl,
  tuneMessage,
} from "./openWebRxProtocol";
export const wireConfig = {
  center_freq: 10000000,
  samp_rate: 192000,
  fft_size: 128,
  audio_compression: "none",
  fft_compression: "none",
  start_freq: 10000000,
  start_mod: "am",
  sdr_id: "radio",
  profile_id: "hf",
};
const config = configFrom(wireConfig)!;
describe("OpenWebRX wire boundaries", () => {
  it("preserves installation paths and refuses credential-bearing or mixed-content addresses", () => {
    expect(receiverUrl("https://example.org/radio/", "https:")).toEqual({
      website: "https://example.org/radio/",
      socket: "wss://example.org/radio/ws/",
    });
    expect(receiverUrl("http://localhost:8080", "http:").socket).toBe(
      "ws://localhost:8080/ws/",
    );
    for (const input of [
      "ftp://example.org",
      "https://a:b@example.org",
      "https://example.org/?token=x",
      "https://example.org/#x",
      "http://example.org",
    ])
      expect(() => receiverUrl(input, "https:")).toThrow();
  });
  it("requires bounded complete configuration and a channel filter inside the advertised band", () => {
    expect(configFrom({ center_freq: 10e6 })).toBeUndefined();
    expect(() => configFrom({ ...wireConfig, fft_size: 32769 })).toThrow(
      /configuration/,
    );
    expect(() =>
      configFrom({ ...wireConfig, fft_compression: "other" }),
    ).toThrow(/unsupported/);
    expect(tuneMessage(config, defaultTune(config)).params.offset_freq).toBe(0);
    expect(() =>
      tuneMessage(config, { ...defaultTune(config), frequency: 10096000 }),
    ).toThrow(/fit inside/);
    expect(() =>
      tuneMessage(config, {
        ...defaultTune(config),
        lowCut: 9000,
        highCut: 3000,
      }),
    ).toThrow();
    expect(() =>
      tuneMessage(config, { ...defaultTune(config), frequency: NaN }),
    ).toThrow();
  });
  it("decodes unaligned little-endian PCM and rejects truncated samples", () => {
    const bytes = Uint8Array.of(2, 0, 128, 255, 127, 0, 0, 0, 64);
    expect(
      Array.from(audioFrame(bytes.buffer, "none", new ImaDecoder())),
    ).toEqual([-1, 32767 / 32768, 0, 0.5]);
    expect(() =>
      audioFrame(Uint8Array.of(2, 1).buffer, "none", new ImaDecoder()),
    ).toThrow(/PCM/);
  });
  it("reads exact declared FFT lengths and rejects nonfinite server levels", () => {
    const data = new ArrayBuffer(513),
      view = new DataView(data);
    view.setUint8(0, 1);
    for (let i = 0; i < 128; i++)
      view.setFloat32(1 + i * 4, -100 + i / 2, true);
    expect(fftFrame(data, config)[127]).toBe(-36.5);
    expect(() => fftFrame(data.slice(0, -1), config)).toThrow(/size/);
    view.setFloat32(1, Infinity, true);
    expect(() => fftFrame(data, config)).toThrow(/values/);
  });
  it("matches independently calculated IMA nibble values and split synchronization headers", () => {
    // Initial step=0; low nibble 7 => 0, step becomes 16; high nibble 7 => +30.
    expect(
      Array.from(new ImaDecoder().decode(Uint8Array.of(0x77, 0x88), false)),
    ).toEqual([0, 30, 26, 23]);
    const decoder = new ImaDecoder();
    expect(decoder.decode(Uint8Array.of(83, 89), true)).toHaveLength(0);
    expect(decoder.decode(Uint8Array.of(78, 67, 0, 0), true)).toHaveLength(0);
    expect(
      Array.from(decoder.decode(Uint8Array.of(232, 3, 0x77), true)),
    ).toEqual([1000, 1030]);
    const invalid = new ImaDecoder();
    expect(() =>
      invalid.decode(Uint8Array.of(83, 89, 78, 67, 89, 0, 0, 0), true),
    ).toThrow(/header/);
  });
  it("resynchronizes after 1001 compressed bytes across packet boundaries and discards FFT padding", () => {
    const decoder = new ImaDecoder();
    const first = Uint8Array.of(83, 89, 78, 67, 0, 0, 0, 0);
    expect(decoder.decode(first, true)).toHaveLength(0);
    expect(decoder.decode(new Uint8Array(1000), true)).toHaveLength(2000);
    expect(decoder.decode(Uint8Array.of(0, 83, 89, 78), true)).toHaveLength(2);
    expect(
      Array.from(decoder.decode(Uint8Array.of(67, 0, 0, 208, 7, 0), true)),
    ).toEqual([2000, 2000]);
    const compressed = { ...config, fftCompression: "adpcm" as const };
    expect(fftFrame(new Uint8Array(70).buffer, compressed)).toHaveLength(128);
  });
});

it("tunes the RF CW carrier separately from its 700 Hz beat oscillator and preserves passband bounds", () => {
  const request = tuneMessage(config, defaultTune(config, "cw"));
  expect(request.params).toMatchObject({
    mod: "cw",
    offset_freq: -700,
    low_cut: 300,
    high_cut: 1100,
  });
  expect(request.params.offset_freq + request.params.low_cut).toBe(-400);
  expect(request.params.offset_freq + request.params.high_cut).toBe(400);
  expect(() =>
    tuneMessage(config, {
      ...defaultTune(config, "cw"),
      frequency: config.center + config.rate / 2,
    }),
  ).toThrow(/fit inside/);
});
