import type { FrequencySnapshot } from "./publicFrequencyCatalog";
import metadata from "./shared-frequency-snapshot.json";
import data from "./shared-frequency-guides.json";
import { parseDiscoveryFrequency } from "./discoveryGuides";

export interface SharedFrequencyGuide {
  id: string;
  family: string;
  name: string;
  aliases: string[];
  regions: string[];
  frequencyHz: number;
  bandwidthHz: number | null;
  spreadingFactor: number | null;
  codingRate: string | null;
  channel: string | null;
  context: string;
  notes: string;
  publisher: string;
  url: string;
  reviewedOn: string;
  sourceRevision: string | null;
  plan: string | null;
  direction: string | null;
  frequencyMeaning: string;
  recommendedMode: "USB" | "NBFM" | "AM" | null;
  channelSpacingHz: number | null;
}
const profiles = data as SharedFrequencyGuide[];
export const bundledFrequencySnapshot: FrequencySnapshot = {
  ...metadata,
  schema_version: "public-frequency-catalog-v1",
  profiles,
};
const regionNames: Record<string, string[]> = {
  EU: [
    "Europe",
    "European Union",
    "Germany",
    "Deutschland",
    "UK",
    "United Kingdom",
  ],
  US: ["US", "USA", "United States", "America"],
  CA: ["Canada"],
  MX: ["Mexico"],
  AU: ["Australia"],
  NZ: ["New Zealand"],
  GLOBAL: ["worldwide", "global", "Europe", "US"],
  BR: ["Brazil"],
  CN: ["China"],
  JP: ["Japan"],
  KR: ["Korea"],
  TW: ["Taiwan"],
  RU: ["Russia"],
  IN: ["India"],
  TH: ["Thailand"],
  UA: ["Ukraine"],
  MY: ["Malaysia"],
  SG: ["Singapore"],
  PH: ["Philippines"],
  KZ: ["Kazakhstan"],
  NP: ["Nepal"],
  VN: ["Vietnam"],
  CR: ["Costa Rica"],
  GB: ["UK", "United Kingdom"],
  CZ: ["Czech Republic", "Czechia"],
  HU: ["Hungary"],
  NL: ["Netherlands"],
  PT: ["Portugal"],
  SK: ["Slovakia"],
  CH: ["Switzerland"],
  DE: ["Germany", "Deutschland"],
  IL: ["Israel"],
  AS923_1: ["Asia", "AS923-1"],
  AS923_2: ["Asia", "AS923-2"],
  AS923_3: ["Asia", "AS923-3"],
  IARU_R1: ["IARU region 1", "Europe", "Africa"],
  IARU_R2: ["IARU region 2", "Americas"],
  IARU_R3: ["IARU region 3", "Asia", "Oceania"],
};
const words = (value: string): string[] =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
export function matchingSharedFrequencies(
  query: string,
  interpretation: "auto" | "text" = "auto",
  catalog: readonly SharedFrequencyGuide[] = profiles,
) {
  const parsed =
    interpretation === "auto" ? parseDiscoveryFrequency(query) : { notice: "" };
  if (parsed.error) return [];
  const tokens = words(query);
  if (!tokens.length && parsed.frequencyHz === undefined) return [...catalog];
  const channelNumber = query
    .toLowerCase()
    .match(/\b(?:channel|ch)\s+(\d+)\b/)?.[1];
  return catalog.filter((profile) => {
    if (parsed.frequencyHz !== undefined)
      return Math.abs(profile.frequencyHz - parsed.frequencyHz) <= 500;
    if (channelNumber && !words(profile.channel ?? "").includes(channelNumber))
      return false;
    const terms = words(
      [
        profile.name,
        profile.family,
        profile.channel ?? "",
        profile.plan ?? "",
        profile.direction ?? "",
        profile.frequencyHz / 1e6,
        ...profile.aliases,
        ...(profile.family === "thread"
          ? ["Matter", "802.15.4"]
          : profile.family === "zigbee"
            ? ["802.15.4"]
            : ["meshcore", "meshtastic", "lorawan"].includes(profile.family)
              ? ["LoRa"]
              : []),
        ...profile.regions.flatMap((r) => [
          r,
          ...(r === "GLOBAL"
            ? Object.values(regionNames).flat()
            : (regionNames[r] ?? [])),
        ]),
      ].join(" "),
    );
    return tokens.every((token) =>
      terms.some((term) =>
        /^\d+$/.test(token) ? term === token : term.startsWith(token),
      ),
    );
  });
}
export const SHARED_FREQUENCY_FAMILIES = [
  ["meshcore", "MeshCore"],
  ["meshtastic", "Meshtastic"],
  ["zigbee", "Zigbee · 2.4 GHz"],
  ["thread", "Thread · 2.4 GHz"],
  ["lorawan", "LoRaWAN · regional channel plans"],
  ["bluetooth-le", "Bluetooth LE · advertising"],
  ["gnss", "GNSS · satellite carriers"],
  ["pmr446", "PMR446 · Europe"],
  ["freenet", "Freenet · Germany"],
  ["frs", "FRS · United States"],
  ["gmrs", "GMRS · United States"],
  ["murs", "MURS · United States"],
  ["cb", "CB · national channel plans"],
  ["uhf-cb", "UHF CB / PRS · Australia and New Zealand"],
  ["weather", "NOAA Weather Radio · United States"],
  ["marine", "Maritime VHF · voice and DSC"],
  ["hf-ft8", "FT8 · USB dial conventions"],
  ["hf-ft4", "FT4 · USB dial conventions"],
  ["hf-wspr", "WSPR · USB dial conventions"],
  ["hf-js8", "JS8Call · USB dial conventions"],
] as const;
