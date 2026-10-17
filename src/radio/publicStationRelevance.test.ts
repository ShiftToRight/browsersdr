import { expect, it } from "vitest";
import { rankPublicStations } from "./publicStationRelevance";
import { publicStationFixture } from "../testing/publicStationFixture";
it("puts exact names before incidental matches on a page without dropping or changing server results", () => {
  const sample = publicStationFixture.queries[0]!.response.items[0]!;
  const items = [
    {...sample, station: {...sample.station, name: "Český rozhlas Plus", aliases: [], call_sign: null, network: null, service: null}},
    {...sample, station: {...sample.station, name: "Airport ATIS", aliases: [], call_sign: null}},
    {...sample, station: {...sample.station, name: "ATIS", aliases: []}},
  ];
  const ordered = rankPublicStations(items, "ATIS");
  expect(ordered.map(item => item.station.name)).toEqual(["ATIS", "Airport ATIS", "Český rozhlas Plus"]);
  expect(ordered[2]!.relevance.label).toContain("Other catalog text match");
  expect(items[0]!.station.name).toBe("Český rozhlas Plus");
  expect(rankPublicStations(items).map(item => item.station)).toEqual(items.map(item => item.station));
});
