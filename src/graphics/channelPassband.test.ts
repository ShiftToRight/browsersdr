import { describe, expect, it } from "vitest";
import { channelPassbands, formatPassbandWidth } from "./channelPassband";

const session = (mode: "OFF" | "WBFM" | "USB" | "LSB" | "AIS", bandwidthHz: number) => ({
  mode,
  selectedChannelFrequencyHz: 100_000_000,
  channelBandwidthHz: bandwidthHz,
});

describe("channel passband display", () => {
  it("shows no decoder passband in spectrum-only mode", () => {
    expect(channelPassbands(session("OFF", 1))).toEqual([]);
  });

  it("centers ordinary modulation bandwidth around the selected channel", () => {
    expect(channelPassbands(session("WBFM", 150_000))).toEqual([{
      startFrequencyHz: 99_925_000,
      endFrequencyHz: 100_075_000,
      label: "WBFM",
    }]);
  });

  it("places single-sideband bandwidth on the decoded side of the carrier", () => {
    expect(channelPassbands(session("USB", 2_800))[0]).toMatchObject({ startFrequencyHz: 100_000_000, endFrequencyHz: 100_002_800 });
    expect(channelPassbands(session("LSB", 2_800))[0]).toMatchObject({ startFrequencyHz: 99_997_200, endFrequencyHz: 100_000_000 });
  });

  it("shows the two actual AIS decoder filters independently", () => {
    expect(channelPassbands(session("AIS", 100_000))).toEqual([
      { startFrequencyHz: 99_955_000, endFrequencyHz: 99_995_000, label: "AIS 1" },
      { startFrequencyHz: 100_005_000, endFrequencyHz: 100_045_000, label: "AIS 2" },
    ]);
  });

  it("formats widths without insignificant trailing zeroes", () => {
    expect(formatPassbandWidth(1_536_000)).toBe("1.536 MHz");
    expect(formatPassbandWidth(150_000)).toBe("150 kHz");
    expect(formatPassbandWidth(500)).toBe("500 Hz");
  });
});
