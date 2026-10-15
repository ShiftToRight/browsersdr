import { describe, expect, it } from "vitest";
import {
  CAPTURE_EDGE_GUARD_HZ,
  createSignalsMode,
  defaultModeSettings,
  modeCapabilities,
  planChannelTune,
  RECEIVER_MODES,
  validateModeSampleRate,
} from "./receiverConfig";

describe("receiver mode configuration", () => {
  it("uses the constraints exposed by every installed Signals mode", () => {
    expect(RECEIVER_MODES).toEqual(["OFF", "WBFM", "NBFM", "AM", "USB", "LSB", "CW", "DAB", "ADS-B", "AIS", "SRD", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"]);
    expect(defaultModeSettings("OFF")).toEqual({ mode: "OFF", bandwidthHz: 1, squelch: 0 });
    expect(modeCapabilities("OFF")).toMatchObject({ bandwidthSettable: false, squelchSettable: false });
    expect(() => createSignalsMode(defaultModeSettings("OFF"))).toThrow(/does not use the analog demodulator/);
    expect(defaultModeSettings("WBFM")).toEqual({ mode: "WBFM", bandwidthHz: 150_000, squelch: 0 });
    expect(defaultModeSettings("NBFM").bandwidthHz).toBe(10_000);
    expect(defaultModeSettings("DAB")).toEqual({ mode: "DAB", bandwidthHz: 1_536_000, squelch: 0 });
    expect(defaultModeSettings("ADS-B").bandwidthHz).toBe(2_000_000);
    expect(defaultModeSettings("AIS").bandwidthHz).toBe(100_000);
    expect(defaultModeSettings("AM").bandwidthHz).toBe(15_000);
    expect(defaultModeSettings("USB").bandwidthHz).toBe(2_800);
    expect(defaultModeSettings("CW")).toEqual({ mode: "CW", bandwidthHz: 500, squelch: 0, beatToneHz: 600 });
    expect(modeCapabilities("WBFM").squelchSettable).toBe(false);
    expect(modeCapabilities("LSB")).toMatchObject({ minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true });
    expect(modeCapabilities("CW")).toMatchObject({ minimumBandwidthHz: 100, maximumBandwidthHz: 1_000, squelchSettable: false });
    expect(createSignalsMode({ mode: "NBFM", bandwidthHz: 9_000, squelch: 2.5 })).toEqual({ scheme: "NBFM", maxF: 4_500, squelch: 2.5 });
  });
  it("normalizes bounded SRD defaults without routing them through Signals", () => {
    const settings = defaultModeSettings("SRD");
    expect(settings).toMatchObject({
      mode: "SRD",
      bandwidthHz: 32_000,
      squelch: 0,
      srd: { modulation: "ook", protocol: "none" },
    });
    expect(() => createSignalsMode(settings)).toThrow(/digital receiver path/);
    expect(() => validateModeSampleRate("SRD", 192_000)).toThrow(/1.024 or 2.4/);
  });

  it("accepts only the CW receive presets and bounded beat tones", () => {
    expect(createSignalsMode({ mode: "CW", bandwidthHz: 250, squelch: 4, beatToneHz: 1_000 })).toEqual({ scheme: "CW", bandwidth: 250 });
    expect(() => createSignalsMode({ mode: "CW", bandwidthHz: 300, squelch: 0, beatToneHz: 600 })).toThrow(/100, 250, 500 or 1,000/);
    expect(() => createSignalsMode({ mode: "CW", bandwidthHz: 500, squelch: 0, beatToneHz: 299 })).toThrow(/300–1000/);
  });

  it("keeps a channel digital at the exact guarded boundary and retunes beyond it", () => {
    const center = 100_000_000;
    const rate = 1_024_000;
    const bandwidth = 150_000;
    const boundary = rate / 2 - bandwidth / 2 - CAPTURE_EDGE_GUARD_HZ;
    expect(planChannelTune(center, center + boundary, rate, bandwidth)).toMatchObject({
      hardwareCenterFrequencyHz: center,
      frequencyOffsetHz: boundary,
      hardwareRetuneRequired: false,
    });
    expect(planChannelTune(center, center - boundary, rate, bandwidth).hardwareRetuneRequired).toBe(false);
    expect(planChannelTune(center, center + boundary + 1, rate, bandwidth)).toMatchObject({
      hardwareCenterFrequencyHz: center + boundary + 1,
      frequencyOffsetHz: 0,
      hardwareRetuneRequired: true,
    });
  });
});


describe("independent receiver tuning", () => {
  it("moves the capture center while retaining the absolute channel and signed offset", () => {
    expect(planChannelTune(100e6, 100.1e6, 1_024_000, 150_000,
      { centerFrequencyHz: 100.2e6 })).toMatchObject({
      hardwareCenterFrequencyHz: 100.2e6, frequencyOffsetHz: -100_000, hardwareRetuneRequired: true,
    });
  });
  it("keeps the complete channel and edge guard inside a fixed window", () => {
    const edge = 1_024_000 / 2 - 150_000 / 2 - CAPTURE_EDGE_GUARD_HZ;
    for (const sign of [-1, 1]) {
      expect(planChannelTune(100e6, 100e6 + sign * edge, 1_024_000, 150_000,
        { autoRecenter: false }).hardwareRetuneRequired).toBe(false);
      expect(() => planChannelTune(100e6, 100e6 + sign * (edge + 1), 1_024_000, 150_000,
        { autoRecenter: false })).toThrow(/complete channel/);
    }
    expect(() => planChannelTune(100e6, 100.1e6, 1_024_000, 150_000,
      { centerFrequencyHz: 101e6 })).toThrow(/selected channel outside/);
    expect(planChannelTune(100e6, 101e6, 1_024_000, 150_000).hardwareCenterFrequencyHz).toBe(101e6);
  });
});
