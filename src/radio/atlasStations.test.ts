import { describe, expect, it, vi } from "vitest";
import fixture from "../testing/fixtures/atlas/browsersdr-station-search-v1.json";
import { AtlasClient } from "./atlasClient";
import {
  parseAtlasStationPage,
  parseAtlasStation,
  stationQueryFromMHz,
  stationQueryParams,
} from "./atlasStations";
import {
  atlasStationListUrl,
  atlasStationUrl,
  atlasStationWebBase,
} from "./atlasStationNavigation";
import {
  atlasReceptionCandidate,
  atlasReferenceMode,
} from "./atlasStationSelection";
import { legacyAtlasPageRedirect } from "./atlasWebNavigation";
const station = parseAtlasStation(fixture.pages.first.items[0]);
describe("station catalog contract", () => {
  it("validates both fixture pages and retains decimal evidence coordinates and HTML-like text", () => {
    expect(parseAtlasStationPage(fixture.pages.first).items[0]!.name).toBe(
      "Example <Radio>",
    );
    expect(
      parseAtlasStationPage(fixture.pages.last).items[0]!.transmissions,
    ).toEqual([]);
    const row = structuredClone(station);
    row.reception.sample_start = "9007199254740999";
    expect(parseAtlasStation(row).reception.sample_start).toBe(
      "9007199254740999",
    );
  });
  it.each([
    { id: "wrong" },
    { version: 0 },
    { transmissions: [{ ...station.transmissions[0], frequency_hz: NaN }] },
    { transmissions: [{ ...station.transmissions[0], bandwidth_hz: -1 }] },
    {
      transmissions: [
        { ...station.transmissions[0], verification_state: "reviewed" },
      ],
    },
    { reception: { ...station.reception, recording_id: "private-invalid" } },
    { transmissions: Array(51).fill(station.transmissions[0]) },
  ])("rejects malformed station fields %j", (patch) =>
    expect(() => parseAtlasStation({ ...station, ...patch })).toThrow(
      "invalid station response",
    ),
  );
  it("rejects unbounded pages, duplicate IDs and malformed next cursors", () => {
    expect(() =>
      parseAtlasStationPage({
        items: Array(51).fill(station),
        next_cursor: null,
      }),
    ).toThrow();
    expect(() =>
      parseAtlasStationPage({ items: [station, station], next_cursor: null }),
    ).toThrow();
    expect(() =>
      parseAtlasStationPage({ items: [], next_cursor: "x".repeat(33) }),
    ).toThrow();
  });
  it("converts labeled MHz bounds to Hz, encodes text/cursor and preserves half-open bounds", () => {
    const q = stationQueryFromMHz(" Radio & <test> ", "99.95", "100.05");
    expect(q).toMatchObject({
      min_frequency_hz: 99_950_000,
      max_frequency_hz: 100_050_000,
    });
    const params = stationQueryParams({ ...q, cursor: "MQ==" });
    expect(params.get("q")).toBe("Radio & <test>");
    expect(params.get("limit")).toBe("50");
    expect(params.get("cursor")).toBe("MQ==");
    expect(stationQueryFromMHz("", "0", "1000000")).toMatchObject({
      min_frequency_hz: 0,
      max_frequency_hz: 1e12,
    });
  });
  it.each([
    ["", "1"],
    ["1", ""],
    ["1", "1"],
    ["2", "1"],
    ["NaN", "2"],
    ["-1", "1"],
    ["0", "1000001"],
  ])("rejects invalid MHz %s–%s", (min, max) =>
    expect(() => stationQueryFromMHz("", min, max)).toThrow(),
  );
  it("rejects a receiver HTML fallback instead of accepting it as a station page", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          "<!doctype html><html><body>Receiver shell</body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    const client = new AtlasClient({ fetch: fetcher });
    await expect(
      client.listStations({ q: "missing proxy" }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.getStation(station.id)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("validates query text, paired bounds and cursor limits before any request", async () => {
    const fetcher = vi.fn();
    const client = new AtlasClient({ fetch: fetcher });
    await expect(client.listStations({ q: "x".repeat(201) })).rejects.toThrow();
    await expect(
      client.listStations({ min_frequency_hz: 1 }),
    ).rejects.toThrow();
    await expect(client.listStations({ cursor: "" })).rejects.toThrow();
    await expect(client.getStation("bad/id")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads list/detail same-origin with no-store and rejects a wrong detail ID", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(fixture.pages.first)),
    );
    const client = new AtlasClient({ fetch: fetcher });
    await client.listStations({ q: "a&b" });
    expect(fetcher.mock.calls[0]).toMatchObject([
      "/api/v1/stations?limit=50&q=a%26b",
      { credentials: "same-origin", cache: "no-store" },
    ]);
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify(station)),
    );
    await expect(client.getStation(station.id)).resolves.toMatchObject({
      id: station.id,
    });
    await expect(
      client.getStation("00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow("different station");
  });
});
describe("station web links and proposals", () => {
  it("builds stable station/reference links and encoded list MHz filters at both production origins", () => {
    for (const origin of [
      "https://browsersdr.com",
      "https://www.browsersdr.com",
    ]) {
      const link = new URL(
        atlasStationUrl(
          station.id,
          station.transmissions[0]!.id,
          origin,
          "http://127.0.0.1:8000",
        ),
      );
      expect(link.origin).toBe("https://sigintatlas.com");
      expect(link.hash).toContain(
        `station_id=${station.id}&transmission_id=${station.transmissions[0]!.id}`,
      );
      const list = atlasStationListUrl(
        {
          q: "<x>&#token",
          min_frequency_hz: 99e6,
          max_frequency_hz: 101e6,
          cursor: "MQ",
        },
        origin,
      );
      expect(list).toContain("q=%3Cx%3E%26%23token&min_mhz=99&max_mhz=101");
      expect(list).not.toContain("cursor");
    }
  });
  it("uses trusted development web origins without widening the legacy redirect or permitting URL credentials", () => {
    expect(
      atlasStationWebBase("http://localhost:43173", "http://127.0.0.1:8000"),
    ).toBe("http://127.0.0.1:8000");
    expect(atlasStationWebBase("http://localhost:43173", "")).toBe(
      "https://sigintatlas.com",
    );
    for (const base of [
      "not a URL",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
      "https://example.com/path",
      "https://example.com/?token=x",
      "http://example.com",
    ])
      expect(() =>
        atlasStationWebBase("http://localhost:43173", base),
      ).toThrow();
    expect(() => atlasStationUrl("https://evil.test")).toThrow();
    expect(() => atlasStationUrl(station.id, "foreign/id")).toThrow();
    expect(
      legacyAtlasPageRedirect({
        origin: "https://browsersdr.com",
        pathname: "/",
        search: "",
        hash: `#/database/stations?station_id=${station.id}`,
      }),
    ).toBeUndefined();
  });
  it("uses only the agreed analog format mappings and requires a matching explicit reference", () => {
    for (const f of ["FM", " wfm ", "WBFM"])
      expect(atlasReferenceMode(f)).toBe("WBFM");
    expect(atlasReferenceMode("am")).toBe("AM");
    expect(atlasReferenceMode("nfm")).toBe("NBFM");
    for (const f of [null, "Unknown", "DRM", "DAB", "QPSK"])
      expect(atlasReferenceMode(f)).toBeUndefined();
    expect(
      atlasReceptionCandidate(station, station.transmissions[1]!.id)
        .bandwidth_hz,
    ).toBe(12500);
    expect(() =>
      atlasReceptionCandidate(station, "00000000-0000-4000-8000-000000000099"),
    ).toThrow("belonging");
    expect(() =>
      atlasReceptionCandidate(station, station.transmissions[2]!.id),
    ).toThrow("explicitly");
    expect(
      atlasReceptionCandidate(station, station.transmissions[2]!.id, "AM"),
    ).toMatchObject({ mode: "AM", bandwidth_hz: 10000 });
  });
});
