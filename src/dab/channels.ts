export interface DabChannel { label: string; frequencyHz: number }

/** ETSI Band III channel centres used by European DAB/DAB+ ensembles. */
export const DAB_BAND_III_CHANNELS: readonly DabChannel[] = [
  ["5A", 174_928_000], ["5B", 176_640_000], ["5C", 178_352_000], ["5D", 180_064_000],
  ["6A", 181_936_000], ["6B", 183_648_000], ["6C", 185_360_000], ["6D", 187_072_000],
  ["7A", 188_928_000], ["7B", 190_640_000], ["7C", 192_352_000], ["7D", 194_064_000],
  ["8A", 195_936_000], ["8B", 197_648_000], ["8C", 199_360_000], ["8D", 201_072_000],
  ["9A", 202_928_000], ["9B", 204_640_000], ["9C", 206_352_000], ["9D", 208_064_000],
  ["10A", 209_936_000], ["10B", 211_648_000], ["10C", 213_360_000], ["10D", 215_072_000],
  ["11A", 216_928_000], ["11B", 218_640_000], ["11C", 220_352_000], ["11D", 222_064_000],
  ["12A", 223_936_000], ["12B", 225_648_000], ["12C", 227_360_000], ["12D", 229_072_000],
  ["13A", 230_784_000], ["13B", 232_496_000], ["13C", 234_208_000], ["13D", 235_776_000],
  ["13E", 237_488_000], ["13F", 239_200_000],
].map(([label, frequencyHz]) => ({ label: label as string, frequencyHz: frequencyHz as number }));

export function dabChannelAt(frequencyHz: number): DabChannel | undefined {
  return DAB_BAND_III_CHANNELS.find((channel) => channel.frequencyHz === Math.round(frequencyHz));
}
