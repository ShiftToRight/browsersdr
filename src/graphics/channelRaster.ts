import type { ReceiverMode } from "../radio/receiverConfig";
import { DAB_BAND_III_CHANNELS } from "../dab/channels";

/** Conservative broadcast rasters. Other regions/bands/modes stay freely tuned.
 * Region is the explicitly selected band-guide plan, never browser location. */
export function snapChannelFrequency(
  frequencyHz: number,
  mode: ReceiverMode,
  region: string,
): number {
  if (mode === "DAB") {
    const channels = DAB_BAND_III_CHANNELS.map((c) => c.frequencyHz);
    if (
      frequencyHz < channels[0]! - 856_000 ||
      frequencyHz > channels.at(-1)! + 856_000
    )
      return frequencyHz;
    return channels.reduce((best, hz) =>
      Math.abs(hz - frequencyHz) < Math.abs(best - frequencyHz) ? hz : best,
    );
  }
  if (region === "general") return frequencyHz;
  if (mode === "WBFM") {
    if (
      region === "US" &&
      frequencyHz >= 88_100_000 &&
      frequencyHz <= 107_900_000
    )
      return (
        88_100_000 + Math.round((frequencyHz - 88_100_000) / 200_000) * 200_000
      );
    if (
      region === "DE" &&
      frequencyHz >= 87_500_000 &&
      frequencyHz <= 108_000_000
    )
      return Math.round(frequencyHz / 100_000) * 100_000;
  }
  if (mode === "AM") {
    if (region === "US" && frequencyHz >= 530_000 && frequencyHz <= 1_700_000)
      return Math.round(frequencyHz / 10_000) * 10_000;
    if (region === "DE" && frequencyHz >= 531_000 && frequencyHz <= 1_602_000)
      return Math.round(frequencyHz / 9_000) * 9_000;
  }
  return frequencyHz;
}
