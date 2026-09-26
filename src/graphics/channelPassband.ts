import type { SourceSessionMetadata } from "../radio/types";

export interface ChannelPassband {
  startFrequencyHz: number;
  endFrequencyHz: number;
  label: string;
}

const AIS_CHANNEL_OFFSET_HZ = 25_000;
const AIS_DECODER_BANDWIDTH_HZ = 40_000;

/** Returns the RF regions consumed by the active demodulation/decoding chain. */
export function channelPassbands(
  session: Pick<SourceSessionMetadata, "mode" | "selectedChannelFrequencyHz" | "channelBandwidthHz">,
): ChannelPassband[] {
  const center = session.selectedChannelFrequencyHz;
  const bandwidth = session.channelBandwidthHz;
  if (!Number.isFinite(center) || !Number.isFinite(bandwidth) || bandwidth <= 0) return [];
  if (session.mode === "OFF") return [];

  if (session.mode === "USB") {
    return [{ startFrequencyHz: center, endFrequencyHz: center + bandwidth, label: "USB" }];
  }
  if (session.mode === "LSB") {
    return [{ startFrequencyHz: center - bandwidth, endFrequencyHz: center, label: "LSB" }];
  }
  if (session.mode === "AIS") {
    const half = AIS_DECODER_BANDWIDTH_HZ / 2;
    return [
      {
        startFrequencyHz: center - AIS_CHANNEL_OFFSET_HZ - half,
        endFrequencyHz: center - AIS_CHANNEL_OFFSET_HZ + half,
        label: "AIS 1",
      },
      {
        startFrequencyHz: center + AIS_CHANNEL_OFFSET_HZ - half,
        endFrequencyHz: center + AIS_CHANNEL_OFFSET_HZ + half,
        label: "AIS 2",
      },
    ];
  }

  const half = bandwidth / 2;
  return [{ startFrequencyHz: center - half, endFrequencyHz: center + half, label: session.mode }];
}

export function formatPassbandWidth(widthHz: number): string {
  if (widthHz >= 1_000_000) return `${Number((widthHz / 1_000_000).toFixed(3))} MHz`;
  if (widthHz >= 1_000) return `${Number((widthHz / 1_000).toFixed(1))} kHz`;
  return `${Math.round(widthHz)} Hz`;
}
