import { describe, expect, it } from "vitest";
import {
  CAPTURE_EDGE_GUARD_HZ,
  createSignalsMode,
  defaultModeSettings,
  modeCapabilities,
  planChannelTune,
  RECEIVER_MODES,
} from "./receiverConfig";

describe("receiver mode configuration", () => {
  it("uses the constraints exposed by every installed Signals mode", () => {
    expect(RECEIVER_MODES).toEqual(["WBFM", "NBFM", "AM", "USB", "LSB", "DAB", "ADS-B", "AIS"]);
    expect(defaultModeSettings("WBFM")).toEqual({ mode: "WBFM", bandwidthHz: 150_000, squelch: 0 });
    expect(defaultModeSettings("NBFM").bandwidthHz).toBe(10_000);
    expect(defaultModeSettings("DAB")).toEqual({ mode: "DAB", bandwidthHz: 1_536_000, squelch: 0 });
    expect(defaultModeSettings("ADS-B").bandwidthHz).toBe(2_000_000);
    expect(defaultModeSettings("AIS").bandwidthHz).toBe(100_000);
    expect(defaultModeSettings("AM").bandwidthHz).toBe(15_000);
    expect(defaultModeSettings("USB").bandwidthHz).toBe(2_800);
    expect(modeCapabilities("WBFM").squelchSettable).toBe(false);
    expect(modeCapabilities("LSB")).toMatchObject({ minimumBandwidthHz: 10, maximumBandwidthHz: 15_000, squelchSettable: true });
    expect(createSignalsMode({ mode: "NBFM", bandwidthHz: 9_000, squelch: 2.5 })).toEqual({ scheme: "NBFM", maxF: 4_500, squelch: 2.5 });
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
