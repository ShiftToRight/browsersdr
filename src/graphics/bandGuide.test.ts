import { expect, it } from "vitest";
import {
  BAND_GUIDE_PLANS,
  BAND_GUIDE_SOURCES,
  GERMAN_GUIDE_BANDS,
  guideBands,
  guideSegments,
  isBandGuidePlan,
  segmentLabel,
  type BandGuidePlan,
} from "./bandGuide";

it("clips an actual band boundary to proportional RF coordinates", () => {
  const segments = guideSegments(107e6, 109.4e6, "DE");
  expect(segments.map(segmentLabel)).toEqual([
    "FM broadcast",
    "Air navigation",
  ]);
  expect(segments[0]!.endHz).toBe(108e6);
  expect(segments[0]!.widthPercent).toBeCloseTo(100 / 2.4);
  expect(segments[1]!.leftPercent).toBeCloseTo(100 / 2.4);
  expect(segments[1]!.bands[0]!.endHz).toBe(117.975e6);
});

it("keeps country bounds independent of the common European profile", () => {
  const amateur = (plan: BandGuidePlan, start: number, end: number) =>
    guideSegments(start * 1e6, end * 1e6, plan).some((s) =>
      s.bands.some((b) => b.label.includes("amateur")),
    );
  expect(amateur("CEPT", 146, 148)).toBe(false);
  for (const plan of ["DE", "GB", "FR", "CH", "ES", "IN", "ZA"] as const)
    expect(amateur(plan, 146, 148)).toBe(false);
  for (const plan of ["US", "CA", "AU", "NZ", "CN", "BR"] as const)
    expect(amateur(plan, 146, 148)).toBe(true);
  expect(amateur("US", 420, 430)).toBe(true);
  expect(amateur("CA", 420, 430)).toBe(false);
  expect(amateur("GB", 420, 430)).toBe(false);
});

it("uses application bounds instead of translating Canada's allocation to FM", () => {
  expect(guideSegments(87e6, 89e6, "CA").map(segmentLabel)).toEqual([
    "No guide data",
    "FM broadcast",
  ]);
  expect(guideSegments(87e6, 89e6, "US").map(segmentLabel)).toEqual([
    "No guide data",
    "FM broadcast",
  ]);
  expect(guideSegments(87e6, 89e6, "CEPT")[0]!.endHz).toBe(87.5e6);
  const brazil = guideSegments(76e6, 89e6, "BR");
  expect(brazil.some((s) => s.startHz === 87.4e6 && !s.bands.length)).toBe(
    true,
  );
  expect(guideSegments(7e6, 8e6, "GB").every((s) => !s.bands.length)).toBe(
    true,
  );
});

it("retains inspectable provenance for every curated interval and excludes proposals", () => {
  for (const [id, plan] of Object.entries(BAND_GUIDE_PLANS)) {
    expect(isBandGuidePlan(id)).toBe(true);
    expect(plan.scope).not.toBe("");
    const bands = guideBands(id as BandGuidePlan);
    expect(new Set(bands.map((b) => b.id)).size).toBe(bands.length);
    for (const band of bands) {
      expect(Number.isSafeInteger(band.startHz)).toBe(true);
      expect(Number.isSafeInteger(band.endHz)).toBe(true);
      expect(band.endHz).toBeGreaterThan(band.startHz);
      expect(["broadcast", "navigation", "amateur", "shared"]).toContain(
        band.category,
      );
      expect(band.references.length).toBeGreaterThan(0);
      for (const ref of band.references) {
        expect(ref.section).not.toBe("");
        const source = BAND_GUIDE_SOURCES[ref.sourceId]!;
        expect(source).toBeDefined();
        expect(new URL(source.url).protocol).toBe("https:");
        expect(source.edition).not.toBe("");
        expect(source.inspected).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(source.inspected).toISOString().slice(0, 10)).toBe(
          source.inspected,
        );
        if (source.sha256) expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  }
  expect(BAND_GUIDE_SOURCES.CA!.edition).toContain("2022");
  expect(BAND_GUIDE_SOURCES.BR!.edition).toContain("789");
  for (const bad of [
    null,
    1,
    "world",
    "JP",
    "NL",
    "toString",
    "__proto__",
    "constructor",
  ])
    expect(isBandGuidePlan(bad)).toBe(false);
});
it("preserves gaps and gives the upper band ownership at an exact boundary", () => {
  expect(guideSegments(108e6, 109e6, "DE").map(segmentLabel)).toEqual([
    "Air navigation",
  ]);
  expect(guideSegments(0.14e6, 0.15e6, "DE").map(segmentLabel)).toEqual([
    "No guide data",
    "Longwave broadcast",
  ]);
  expect(guideSegments(144e6, 146e6, "general").map(segmentLabel)).toEqual([
    "No guide data",
  ]);
});

it("covers the 868 MHz neighborhood with the official application boundaries", () => {
  const edges = [
    862, 863, 865, 868, 868.6, 868.7, 869.2, 869.25, 869.3, 869.4, 869.65,
    869.7, 870,
  ].map((mhz) => Math.round(mhz * 1e6));
  const ids = [
    "de-srd-862",
    "de-srd-audio",
    "de-srd-rfid",
    "de-srd-868",
    "de-alarm-8686",
    "de-srd-8687",
    "de-social-alarm",
    "de-alarm-86925",
    "de-alarm-8693",
    "de-srd-8694",
    "de-alarm-86965",
    "de-srd-8697",
  ];
  const segments = guideSegments(862e6, 870e6, "DE");
  expect(segments.map((s) => s.startHz)).toEqual(edges.slice(0, -1));
  expect(segments.map((s) => s.endHz)).toEqual(edges.slice(1));
  expect(segments.map((s) => s.bands.map((b) => b.id))).toEqual(
    ids.map((id) => [id]),
  );
  for (let i = 1; i < edges.length - 1; i++) {
    const edge = edges[i]!;
    const at = guideSegments(edge, edge + 1, "DE");
    expect(at[0]!.bands[0]!.id).toBe(ids[i]);
    expect(guideSegments(edge - 1, edge, "DE")[0]!.bands[0]!.id).toBe(
      ids[i - 1],
    );
  }
  expect(segmentLabel(guideSegments(868e6, 868.5e6, "DE")[0]!)).toBe(
    "SRD / shared uses",
  );
  expect(segmentLabel(guideSegments(869.2e6, 869.25e6, "DE")[0]!)).toBe(
    "SRD / social alarms",
  );
  expect(segments.reduce((n, s) => n + s.widthPercent, 0)).toBeCloseTo(100);
});

it("keeps mobile directions, railway sharing and uncatalogued gaps distinct", () => {
  const label = (mhz: number) =>
    segmentLabel(guideSegments(mhz * 1e6, mhz * 1e6 + 1, "DE")[0]!);
  expect(label(710)).toBe("700 MHz mobile uplink");
  expect(label(760)).toBe("700 MHz mobile downlink");
  expect(label(800)).toBe("800 MHz mobile downlink");
  expect(label(850)).toBe("800 MHz mobile uplink");
  expect(label(900)).toBe("900 MHz mobile uplink");
  expect(label(950)).toBe("900 MHz mobile downlink");
  expect(label(874)).toBe("Railway / military shared");
  expect(label(879)).toBe("Railway mobile");
  expect(label(919)).toBe("Railway / military shared");
  expect(label(924)).toBe("Railway mobile");
  // The requested audit did not establish a current general application here.
  expect(label(7000)).toBe("No guide data");
  expect(guideSegments(868e6, 869e6, "general")[0]!.bands).toEqual([]);
  expect(guideSegments(868e6, 869e6, "US")[0]!.bands).toEqual([]);
});

it("adds sourced national context across HF, VHF, UHF and microwave", () => {
  const cases = [
    [0.136, "de-lf-amateur"],
    [0.475, "de-mf-amateur"],
    [3.6, "de-80m"],
    [5.36, "de-60m"],
    [24.95, "de-12m"],
    [28.5, "de-10m"],
    [50.5, "de-6m"],
    [5, "de-time5"],
    [5.5, "de-hf-aviation"],
    [156.2, "de-156-marine"],
    [403.5, "de-400-weather"],
    [406.05, "de-406-rescue"],
    [433.92, "de-srd433"],
    [446.1, "de-pmr446"],
    [448.425, "de-pager448a"],
    [1255, "de-1250-amateur"],
    [1575.42, "de-gnss-l1"],
    [1695, "de-weather-l"],
    [1890, "de-dect"],
    [2530, "de-2600-up"],
    [2600, "de-2600-tdd"],
    [2660, "de-2600-down"],
    [3500, "de-3500-mobile"],
    [4300, "de-altimeter"],
    [5200, "de-wlan5150"],
    [5300, "de-wlan5250"],
    [5500, "de-wlan5470"],
    [6000, "de-wlan6"],
  ] as const;
  for (const [mhz, id] of cases) {
    const segment = guideSegments(mhz * 1e6, mhz * 1e6 + 1, "DE")[0]!;
    expect(
      segment.bands.map((b) => b.id),
      `${mhz} MHz`,
    ).toContain(id);
  }
  const shared = guideSegments(433.9e6, 434e6, "DE")[0]!;
  expect(shared.bands.map((b) => b.id)).toEqual(["70cm", "de-srd433"]);
  expect(segmentLabel(shared)).toBe("Shared uses");
  // Expired temporary 4 m amateur permission is not imported as current.
  expect(guideSegments(70.18e6, 70.19e6, "DE")[0]!.bands).toEqual([]);
});

it("pins new official editions without rewriting historical source inspections", () => {
  expect(BAND_GUIDE_SOURCES.DE!.inspected).toBe("2026-10-13");
  expect(BAND_GUIDE_SOURCES["DE-PLAN-2026"]!.sourceDate).toBe("2026-08");
  expect(BAND_GUIDE_SOURCES["DE-PLAN-2026"]!.sha256).toBe(
    "460078ec84536316b038e2f56bec3aceb7205bdb663f19a62d85d6889bacb8cd",
  );
  for (const band of GERMAN_GUIDE_BANDS.filter((b) => b.id.startsWith("de-"))) {
    expect(band.references.some((r) => r.sourceId.startsWith("DE-"))).toBe(
      true,
    );
    for (const ref of band.references) {
      expect(BAND_GUIDE_SOURCES[ref.sourceId]!.inspected).toBe("2026-10-25");
      expect(BAND_GUIDE_SOURCES[ref.sourceId]!.sha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }
  }
});
it("retains overlapping entries rather than assigning one identity", () => {
  const base = GERMAN_GUIDE_BANDS[0]!;
  const segments = guideSegments(0, 30, "DE", [
    { ...base, startHz: 0, endHz: 20 },
    { ...base, id: "other", startHz: 10, endHz: 30 },
  ]);
  expect(segments.map((s) => s.bands.length)).toEqual([1, 2, 1]);
  expect(segmentLabel(segments[1]!)).toBe("Shared uses");
  expect(segments.reduce((sum, s) => sum + s.widthPercent, 0)).toBeCloseTo(100);
});
it("rejects invalid windows and retains unique valid source intervals", () => {
  expect(guideSegments(NaN, 10, "DE")).toEqual([]);
  expect(guideSegments(20, 10, "DE")).toEqual([]);
  expect(new Set(GERMAN_GUIDE_BANDS.map((b) => b.id)).size).toBe(
    GERMAN_GUIDE_BANDS.length,
  );
  for (const band of GERMAN_GUIDE_BANDS) {
    expect(band.startHz).toBeLessThan(band.endHz);
    expect(Number.isInteger(band.startHz)).toBe(true);
    expect(band.notes).not.toBe("");
  }
});
