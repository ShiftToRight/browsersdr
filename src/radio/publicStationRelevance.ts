import type { PublicStation, PublicStationPage } from "./publicStations";

const words = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function publicStationRelevance(station: PublicStation, query = "") {
  const terms = words(query);
  if (!terms.length) return {score: 0, label: "Catalog order"};
  const names = [station.name, ...station.aliases, station.call_sign ?? ""];
  if (names.some(name => words(name).join(" ") === terms.join(" ")))
    return {score: 0, label: "Exact name, alias or call sign"};
  if (names.some(name => terms.every(term => words(name).some(word => word.startsWith(term)))))
    return {score: 1, label: "Name, alias or call-sign match"};
  if ([station.network, station.service].some(value => value && terms.every(term => words(value).some(word => word.startsWith(term)))))
    return {score: 2, label: "Network or service match"};
  return {score: 3, label: "Other catalog text match; check the published context"};
}

/** Rank only the returned page; keep every server result and its original match evidence. */
export function rankPublicStations(items: PublicStationPage["items"], query?: string) {
  return items.map((item, index) => ({...item, index, relevance: publicStationRelevance(item.station, query)}))
    .sort((a,b) => a.relevance.score - b.relevance.score || a.index - b.index);
}
