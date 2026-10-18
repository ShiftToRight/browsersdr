import { describe, expect, it } from "vitest";
import {
  alternatingMonitorSession,
  monitorCoverageWindows,
  monitorSweepIndices,
} from "./monitorSchedule";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
  setMonitorBaseline,
  monitorTargetObservation,
} from "./signalMonitor";
import { analyzeMonitorWindow } from "./monitorDetection";
import type { SurveyProfile } from "./fieldSurvey";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";

const receiver: SourceSessionMetadata = {
  source: "synthetic",
  sessionGeneration: 1,
  requestedSampleRateHz: 1024000,
  actualSampleRateHz: 1024000,
  hardwareCenterFrequencyHz: 100768000,
  selectedChannelFrequencyHz: 100768000,
  mode: "OFF",
  channelBandwidthHz: 200000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
const at = (n: number) =>
  new Date(Date.UTC(2026, 9, 18, 12, 0, n)).toISOString();
const profile: SurveyProfile = {
  version: 1,
  name: "Shifted sweep",
  site: { label: "Generated" },
  bands: [
    {
      id: "band",
      name: "Band",
      startFrequencyHz: 100000000,
      endFrequencyHz: 101536000,
      dwellMs: 150,
      thresholdDb: 10,
      detector: "average",
      captureSeconds: 2,
    },
  ],
};
const create = (p = profile, r = receiver, alternate = true) =>
  createMonitorSession(
    p,
    r,
    at(0),
    undefined,
    { version: 2, preset: "general" },
    alternate,
  );
function visit(
  s: ReturnType<typeof create>,
  spans: [number, number][],
  time: number,
  status: "complete" | "failed" = "complete",
  level = -40,
) {
  const index = s.nextWindow,
    plan = s.windows[index]!.plan;
  const bins = new Float32Array(4096).fill(-100);
  for (let i = 0; i < bins.length; i++) {
    const hz =
      plan.centerFrequencyHz +
      ((i - bins.length / 2) * receiver.actualSampleRateHz) / bins.length;
    if (spans.some(([a, b]) => hz >= a && hz <= b)) bins[i] = level;
  }
  const frame = {
    bins,
    centerFrequencyHz: plan.centerFrequencyHz,
    sampleRateHz: receiver.actualSampleRateHz,
  } as SpectrumFrame;
  const result = analyzeMonitorWindow(
    plan,
    {
      frames: [frame],
      targetSamples: 153600,
      sourceSamples: 153600,
      missingSamples: 0,
      coverage: 1,
      status: "complete",
    },
    10,
    "average",
    s.analysis!,
  );
  if (status === "failed") {
    result.status = "failed";
    result.candidates = [];
    result.coverage = 0;
  }
  return recordMonitorVisit(s, index, result, 150, at(time));
}

describe("alternating half-window monitor grids", () => {
  it("retains sustained real change evidence across intervening clipped observations", () => {
    let s = create();
    const span: [number, number] = [100748000, 100788000];
    for (let n = 1; n <= 5; n++) s = visit(s, [span], n);
    s = setMonitorBaseline(s, at(5));
    for (let n = 6; n <= 20; n++) s = visit(s, [span], n, "complete", -25);
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]!.change).toBe("changed");
    expect(s.signals[0]!.changeStreak).toBe(3);
  });
  it("covers the full interval on each phase and moves its seam by half the actual grid width", () => {
    for (const range of [1536000, 1800123, 3000001]) {
      const p = structuredClone(profile);
      p.bands[0]!.endFrequencyHz = 100000000 + range;
      const s = create(p);
      for (const sweep of [0, 1, 2, 3]) {
        const w = monitorSweepIndices(s, sweep).map((i) => s.windows[i]!);
        expect(w[0]!.plan.lowerFrequencyHz).toBe(100000000);
        expect(w.at(-1)!.plan.upperFrequencyHz).toBe(100000000 + range);
        for (let i = 1; i < w.length; i++)
          expect(w[i]!.plan.lowerFrequencyHz).toBe(
            w[i - 1]!.plan.upperFrequencyHz,
          );
        for (const { plan } of w) {
          expect(
            plan.upperFrequencyHz - plan.lowerFrequencyHz,
          ).toBeLessThanOrEqual(768001);
          expect(plan.lowerFrequencyHz).toBeGreaterThanOrEqual(
            plan.centerFrequencyHz - 384001,
          );
          expect(plan.upperFrequencyHz).toBeLessThanOrEqual(
            plan.centerFrequencyHz + 384001,
          );
        }
      }
      const a = monitorSweepIndices(s, 0),
        b = monitorSweepIndices(s, 1);
      expect(b).toHaveLength(a.length + 1);
      expect(s.windows[b[0]!]!.plan.upperFrequencyHz - 100000000).toBeCloseTo(
        range / a.length / 2,
        5,
      );
      expect(validateMonitorSession(s)).toEqual(s);
    }
  });
  it("counts each full grid as one sweep and preserves a seam signal ID, baseline and observations across both phases", () => {
    let s = create();
    const span: [number, number] = [100748000, 100788000];
    s = visit(s, [span], 1);
    const id = s.signals[0]!.id;
    s = visit(s, [span], 2);
    expect(s.sweeps).toBe(1);
    expect(s.signals).toHaveLength(1);
    s = setMonitorBaseline(s, at(2));
    const baseline = structuredClone(s.signals[0]!.baseline);
    s = visit(s, [span], 3); // Smaller leading endpoint does not observe this signal.
    s = visit(s, [span], 4); // Shifted middle measures the whole emission.
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]).toMatchObject({
      id,
      detections: 3,
      misses: 0,
      baseline,
      firstSeen: at(1),
      lastSeen: at(4),
    });
    expect(s.signals[0]!.centerEvidence).toHaveLength(1);
    expect(
      s.signals[0]!.upperFrequencyHz! - s.signals[0]!.lowerFrequencyHz!,
    ).toBeGreaterThan(39000);
    s = visit(s, [span], 5);
    expect(s.sweeps).toBe(2);
    expect(s.nextWindow).toBe(0);
    expect(validateMonitorSession(s)).toEqual(s);
    const restored = validateMonitorSession(JSON.parse(JSON.stringify(s)));
    expect(visit(restored, [span], 6).signals[0]!.id).toBe(id);
  });
  it("never records false absence/change from a partial footprint and keeps resolved neighbors separate", () => {
    let s = create();
    const spans: [number, number][] = [
      [100738000, 100746000],
      [100790000, 100798000],
    ];
    for (let n = 1; n <= 10; n++) s = visit(s, spans, n);
    expect(s.signals).toHaveLength(2);
    const ids = s.signals.map((x) => x.id).sort();
    s = setMonitorBaseline(s, at(10));
    for (let n = 11; n <= 15; n++) s = visit(s, spans, n);
    expect(s.signals.map((x) => x.id).sort()).toEqual(ids);
    expect(s.signals.every((x) => x.change === "known")).toBe(true);
    // A broad track learned in B is not absent merely because only a piece is visited in A.
    let broad = create();
    const span: [number, number] = [100748000, 100788000];
    for (let n = 1; n <= 5; n++) broad = visit(broad, [span], n);
    broad = visit(broad, [], 6);
    broad = visit(broad, [], 7);
    expect(broad.signals[0]!.misses).toBe(0);
    broad = visit(broad, [], 8);
    broad = visit(broad, [], 9, "failed");
    expect(broad.signals[0]!.misses).toBe(0);
  });
  it("recovers exact phase/cursor and rejects corrupted phase, grid or scheduling provenance", () => {
    let s = create();
    for (let n = 1; n <= 3; n++) s = visit(s, [], n);
    expect(s.sweeps).toBe(1);
    expect(s.nextWindow).toBe(3);
    expect(validateMonitorSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
    for (const mutate of [
      (v: typeof s) => {
        v.nextWindow = 0;
      },
      (v: typeof s) => {
        v.sweepPattern!.version = 2 as 1;
      },
      (v: typeof s) => {
        v.sweepPattern!.startedAtSweep = 2;
      },
      (v: typeof s) => {
        v.windows[3]!.sweepPhase = 0;
      },
      (v: typeof s) => {
        v.windows[3]!.plan.lowerFrequencyHz++;
      },
    ]) {
      const forged = structuredClone(s);
      mutate(forged);
      expect(() => validateMonitorSession(forged)).toThrow();
    }
  });
  it("upgrades an existing adaptive history without changing identity, signals, baseline, cursor or measurements", () => {
    let old = create(profile, receiver, false);
    old = visit(old, [[100748000, 100788000]], 1);
    old = visit(old, [[100748000, 100788000]], 2);
    old = visit(old, [], 3);
    expect(old.sweeps).toBe(1);
    const upgraded = alternatingMonitorSession(old);
    expect(upgraded.id).toBe(old.id);
    expect(upgraded.nextWindow).toBe(old.nextWindow);
    expect(upgraded.signals).toEqual(old.signals);
    expect(upgraded.sweepPattern?.startedAtSweep).toBe(1);
    expect(validateMonitorSession(upgraded)).toEqual(upgraded);
    expect(validateMonitorSession(old)).toEqual(old);
  });
  it("keeps single-window bands shared and endpoint acquisition passbands legal near device limits", () => {
    const p = structuredClone(profile);
    p.bands[0]!.startFrequencyHz = 70200000;
    p.bands[0]!.endFrequencyHz = 71736000;
    p.bands.push({
      ...p.bands[0]!,
      id: "single",
      startFrequencyHz: 80e6,
      endFrequencyHz: 80.1e6,
    });
    const s = create(p, { ...receiver, source: "bladerf" });
    for (const w of s.windows)
      expect(
        w.plan.centerFrequencyHz - receiver.actualSampleRateHz / 2,
      ).toBeGreaterThanOrEqual(70e6);
    const single = s.windows.findIndex((w) => w.bandId === "single");
    expect(monitorSweepIndices(s, 0)).toContain(single);
    expect(monitorSweepIndices(s, 1)).toContain(single);
    const one = create({
      ...profile,
      bands: [{ ...profile.bands[0]!, endFrequencyHz: 100.1e6 }],
    });
    expect(one.sweepPattern).toBeUndefined();
    expect(one.windows).toHaveLength(1);
  });
  it("reports full target coverage after either grid, and a newer failure rather than an unvisited alternative", () => {
    let s = create();
    const target = {
      id: "range",
      kind: "range" as const,
      label: "Range",
      startFrequencyHz: 100000000,
      endFrequencyHz: 101536000,
    };
    s = visit(s, [], 1);
    s = visit(s, [], 2);
    expect(
      monitorCoverageWindows(
        s,
        target.startFrequencyHz,
        target.endFrequencyHz,
      ).every((w) => w.lastValidAt),
    ).toBe(true);
    expect(monitorTargetObservation(s, target, Date.parse(at(2))).status).toBe(
      "No activity during last valid visit",
    );
    s = visit(s, [], 3, "failed");
    expect(monitorTargetObservation(s, target, Date.parse(at(3))).status).toBe(
      "Observation failed / incomplete",
    );
  });
  it("enforces the per-sweep bound including the extra endpoint and retains the DC caution", () => {
    const p = structuredClone(profile);
    p.bands[0]!.endFrequencyHz = 100000000 + 768000 * 256;
    expect(() => create(p)).toThrow("including endpoint");
    let s = create();
    const span: [number, number] = [100767750, 100768250];
    for (let n = 1; n <= 4; n++) s = visit(s, [span], n);
    expect(s.signals.some((x) => x.caution?.includes("possible DC"))).toBe(
      true,
    );
  });
});
