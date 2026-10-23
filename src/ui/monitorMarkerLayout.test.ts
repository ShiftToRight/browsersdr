import { describe, expect, it } from "vitest";
import {
  layoutMonitorMarkers,
  layoutMonitorLabels,
  markerWidth,
  monitorMarkerState,
} from "./monitorMarkerLayout";
import type { MonitorSignal, MonitorSession } from "../radio/signalMonitor";
const signal = (i: number, hz = i): MonitorSignal =>
  ({ id: String(i), frequencyHz: hz }) as MonitorSignal;
describe("responsive detection marker layout", () => {
  it("keeps separated markers at their measured centers regardless of table order", () => {
    const result = layoutMonitorMarkers(
      [signal(3, 300), signal(1, 100), signal(2, 200)],
      (hz) => hz,
      0,
      400,
    );
    expect(result.map((g) => [g.x, g.signals[0]!.id])).toEqual([
      [100, "1"],
      [200, "2"],
      [300, "3"],
    ]);
  });
  it("merges colliding markers and reclamps group targets at both band edges", () => {
    const result = layoutMonitorMarkers(
      [signal(0, 0), signal(1, 10), signal(2, 90), signal(3, 100)],
      (hz) => hz,
      0,
      100,
    );
    expect(result.map((group) => [group.x, group.signals.length])).toEqual([
      [22, 2],
      [78, 2],
    ]);
  });
  it("keeps compact cluster badges disjoint, keeping every result selectable across 512 dense detections", () => {
    const signals = Array.from({ length: 512 }, (_, i) =>
      signal(i, (i * 1100) / 511),
    );
    const result = layoutMonitorMarkers(signals, (hz) => hz, 0, 1128);
    expect(result.flatMap((g) => g.signals.map((s) => s.id)).sort()).toEqual(
      signals.map((s) => s.id).sort(),
    );
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1]!,
        b = result[i]!;
      expect(b.x - a.x).toBeGreaterThanOrEqual(
        (markerWidth(a.signals.length) + markerWidth(b.signals.length)) / 2 + 6,
      );
    }
    expect(
      result.every(
        (g) =>
          g.x - markerWidth(g.signals.length) / 2 >= 0 &&
          g.x + markerWidth(g.signals.length) / 2 <= 1128,
      ),
    ).toBe(true);
  });
  it("reflows the same identities on a narrow plot and supports logarithmic positions", () => {
    const signals = [
      signal(1, 10),
      signal(2, 100),
      signal(3, 1000),
      signal(4, 10000),
    ];
    const wide = layoutMonitorMarkers(
      signals,
      (hz) => Math.log10(hz) * 80,
      0,
      400,
    );
    const narrow = layoutMonitorMarkers(
      signals,
      (hz) => Math.log10(hz) * 8,
      0,
      50,
    );
    expect(wide).toHaveLength(4);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]!.signals.map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
    expect(layoutMonitorMarkers(signals, (hz) => hz, 0, 0)).toEqual([]);
  });
  it("does not let a small cluster swallow an independently resolved neighbor", () => {
    const result = layoutMonitorMarkers(
      [signal(1, 100), signal(2, 110), signal(3, 165)],
      (hz) => hz,
      0,
      400,
    );
    expect(result.map((g) => g.signals.map((s) => s.id))).toEqual([
      ["1", "2"],
      ["3"],
    ]);
  });
  it("uses compact mouse targets to separate resolved signals while preserving touch targets", () => {
    const signals = [signal(1, 100), signal(2, 135), signal(3, 170)];
    expect(layoutMonitorMarkers(signals, (hz) => hz, 0, 400, 24)).toHaveLength(
      3,
    );
    expect(layoutMonitorMarkers(signals, (hz) => hz, 0, 400, 44)).toHaveLength(
      2,
    );
  });
  it("packs labels in independent lanes with priority and bounded edges", () => {
    const labels = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      x: i * 18,
      width: 100,
      priority: i === 5 ? 2 : 0,
    }));
    const placed = layoutMonitorLabels(labels, 20, 220);
    expect(placed.some((p) => p.id === "5")).toBe(true);
    expect(placed.length).toBeGreaterThan(1);
    expect(placed.length).toBeLessThan(labels.length);
    for (const a of placed) {
      expect(a.left).toBeGreaterThanOrEqual(20);
      expect(a.left + a.width).toBeLessThanOrEqual(220);
      for (const b of placed.filter((b) => b.id !== a.id && b.row === a.row))
        expect(
          a.left >= b.left + b.width + 6 || b.left >= a.left + a.width + 6,
        ).toBe(true);
    }
    expect(layoutMonitorLabels(labels, 0, 0)).toEqual([]);
  });
  it("keeps confirmation, age and latest-valid-visit presence separate, including legacy histories", () => {
    const s = {
      ...signal(1),
      bandId: "band",
      confirmed: false,
      misses: 1,
      lastSeen: new Date(0).toISOString(),
    };
    const session = {
      analysis: { version: 1, preset: "general" },
      windows: [],
    } as unknown as MonitorSession;
    expect(monitorMarkerState(session, s, 1000)).toMatchObject({
      confirmed: false,
      older: false,
    });
    expect(monitorMarkerState(session, s, 31000).label).toContain(
      "Older observation",
    );
    expect(monitorMarkerState(session, s, 1000).className).toContain(
      "is-tentative is-older",
    );
    expect(
      monitorMarkerState({ ...session, analysis: undefined }, s, 1000).label,
    ).toContain("Legacy detection");
  });
});
