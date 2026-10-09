import { describe, expect, it } from "vitest";
import {
  kiwiAudio,
  kiwiTune,
  kiwiUrls,
  kiwiWaterfall,
  kiwiWindow,
  KIWI_COUNTER,
} from "./kiwiProtocol";
const tune = {
  frequency: 7100000,
  mode: "usb" as const,
  lowCut: 300,
  highCut: 2700,
  squelch: -150,
};
describe("KiwiSDR literal wire contracts", () => {
  it("uses two streams under one session and refuses credentials and HTTPS downgrade", () => {
    expect(kiwiUrls("https://receiver.example/radio", 123, "https:")).toEqual({
      website: "https://receiver.example/radio/",
      sound: "wss://receiver.example/radio/ws/kiwi/123/SND",
      waterfall: "wss://receiver.example/radio/ws/kiwi/123/W/F",
    });
    expect(() =>
      kiwiUrls("http://receiver.example:8073", 123, "https:"),
    ).toThrow("HTTPS");
    expect(() =>
      kiwiUrls("https://user:secret@receiver.example", 123, "https:"),
    ).toThrow("credentials");
  });
  it("maps MHz UI Hz into kHz wire tuning, offset and CW oscillator; rejects filters outside RF/audio", () => {
    expect(kiwiTune(tune, 30000000, 0, 12000)).toBe(
      "SET mod=usb low_cut=300 high_cut=2700 freq=7100.000",
    );
    expect(
      kiwiTune({ ...tune, frequency: 107100000 }, 30000000, 100000000, 12000),
    ).toContain("freq=7100.000");
    expect(
      kiwiTune(
        { ...tune, mode: "cw", lowCut: 300, highCut: 1100 },
        30000000,
        0,
        12000,
      ),
    ).toContain("freq=7099.300");
    expect(
      kiwiTune(
        { ...tune, mode: "nfm", lowCut: -5000, highCut: 5000 },
        30000000,
        0,
        12000,
      ),
    ).toContain("mod=nbfm");
    for (const bad of [
      { frequency: 30000000 },
      { lowCut: 6001 },
      { mode: "wfm" },
      { frequency: NaN },
    ])
      expect(() =>
        kiwiTune({ ...tune, ...bad } as typeof tune, 30000000, 0, 12000),
      ).toThrow();
  });
  it("reads signed BE/LE mono PCM and the LE sequence without confusing meter/header bytes", () => {
    const frame = Uint8Array.of(
      83,
      78,
      68,
      0,
      0x78,
      0x56,
      0x34,
      0x12,
      0xff,
      0xff,
      0x40,
      0,
      0x80,
      0,
    );
    expect(kiwiAudio(frame.buffer)).toMatchObject({
      sequence: 0x12345678,
      restart: false,
      samples: Float32Array.of(0.5, -1),
    });
    frame[3] = 0xa0;
    frame.set([0, 0x40, 0, 0x80], 10);
    expect(kiwiAudio(frame.buffer)).toMatchObject({
      restart: true,
      samples: Float32Array.of(0.5, -1),
    });
    for (const flags of [8, 16, 24]) {
      frame[3] = flags;
      expect(() => kiwiAudio(frame.buffer)).toThrow("mono");
    }
    expect(() => kiwiAudio(frame.slice(0, 9).buffer)).toThrow();
  });
  it("uses the frame's actual range, zoom and relative level, refusing malformed/compressed ranges", () => {
    const frame = new Uint8Array(1040);
    frame.set([87, 47, 70, 32, 0, 0, 128, 0, 1, 0, 0, 0, 7, 0, 0, 0]);
    frame.fill(155, 16);
    frame[16] = 255;
    frame[17] = 55;
    const result = kiwiWaterfall(frame.buffer, 30000000, 100000000, 14);
    expect(result).toMatchObject({
      start: KIWI_COUNTER / 2,
      zoom: 1,
      center: 122500000,
      span: 15000000,
      sequence: 7,
    });
    expect(Array.from(result.bins.slice(0, 3))).toEqual([0, -200, -100]);
    expect(kiwiWindow(200000000, 0, 30000000, 100000000)).toMatchObject({
      start: 0,
      span: 30000000,
      center: 115000000,
    });
    expect(kiwiWindow(100000000, 14, 30000000, 100000000).start).toBe(0);
    frame[10] = 1;
    expect(() => kiwiWaterfall(frame.buffer, 30000000, 0, 14)).toThrow();
    expect(() =>
      kiwiWaterfall(frame.slice(1).buffer, 30000000, 0, 14),
    ).toThrow();
  });
});
