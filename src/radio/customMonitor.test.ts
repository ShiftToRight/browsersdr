import { describe, expect, it, vi } from "vitest";
import {
  frequencyTarget,
  parseMonitorFrequency,
  validateMonitorTargets,
  validateWatchlists,
  saveWatchlists,
  loadWatchlists,
  WATCHLIST_KEY,
} from "./customMonitor";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
  monitorContext,
  monitorTargetObservation,
  monitorTargetsCsv,
} from "./signalMonitor";
import { analyzeScanWindow, type ScanWindowResult } from "./spectrumScan";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import type { SurveyProfile } from "./fieldSurvey";
const receiver: SourceSessionMetadata = {
  source: "synthetic",
  sessionGeneration: 1,
  requestedSampleRateHz: 1024000,
  actualSampleRateHz: 1024000,
  hardwareCenterFrequencyHz: 100e6,
  selectedChannelFrequencyHz: 100e6,
  mode: "OFF",
  channelBandwidthHz: 200000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
const profile: SurveyProfile = {
  version: 1,
  name: "Monitor",
  site: { label: "Site" },
  bands: [
    {
      id: "x",
      name: "x",
      startFrequencyHz: 99e6,
      endFrequencyHz: 101e6,
      dwellMs: 150,
      thresholdDb: 6,
      detector: "average",
      captureSeconds: 5,
    },
  ],
};
const targets = () => [
  frequencyTarget(99.77e6, 25000, "Active"),
  frequencyTarget(100.125e6, 25000, "Second"),
  frequencyTarget(102e6, 25000, "Quiet"),
];
const now = "2026-10-17T18:00:00.000Z";
function visit(
  s: ReturnType<typeof createMonitorSession>,
  frequencies: number[],
  status: ScanWindowResult["status"] = "complete",
): ScanWindowResult {
  return {
    plan: s.windows[0]!.plan,
    points: [],
    candidates: frequencies.map((frequencyHz) => ({
      frequencyHz,
      bandwidthHz: 1000,
      peakDb: -40,
      noiseFloorDb: -90,
    })),
    noiseFloorDb: -90,
    frameCount: 4,
    coverage: status === "complete" ? 1 : 0.4,
    missingSamples: 0,
    status,
  };
}
describe("custom monitor planning and evidence", () => {
  it("requires explicit units and positive whole-Hz input", () => {
    expect(parseMonitorFrequency("99.77 MHz")).toBe(99770000);
    expect(parseMonitorFrequency("12.5 kHz")).toBe(12500);
    for (const value of [
      "99.77",
      "99,77 MHz",
      "-2 Hz",
      "1e8 Hz",
      "0 Hz",
      "1.1 Hz",
    ])
      expect(() => parseMonitorFrequency(value)).toThrow();
  });
  it("shares nearby targets, schedules distant ones, and offsets narrow acquisitions inside guarded spans", () => {
    const s = createMonitorSession(profile, receiver, now, targets());
    expect(s.version).toBe(2);
    expect(s.windows).toHaveLength(2);
    const w = s.windows[0]!.plan;
    expect(w.centerFrequencyHz).not.toBe(
      (w.lowerFrequencyHz + w.upperFrequencyHz) / 2,
    );
    expect(w.lowerFrequencyHz).toBeGreaterThanOrEqual(
      w.centerFrequencyHz - receiver.actualSampleRateHz * 0.375,
    );
    expect(w.upperFrequencyHz).toBeLessThanOrEqual(
      w.centerFrequencyHz + receiver.actualSampleRateHz * 0.375,
    );
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("records overlapping target associations once, ignores gap detections, and keeps silent targets", () => {
    const t = targets();
    t.splice(1, 0, frequencyTarget(99.775e6, 30000, "Overlap"));
    let s = createMonitorSession(profile, receiver, now, t);
    s = recordMonitorVisit(s, 0, visit(s, [99.77e6, 99.9e6]), 150, now);
    expect(s.targets).toHaveLength(4);
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]).toMatchObject({
      targetIds: [t[0]!.id, t[1]!.id],
      validMs: 150,
      detections: 1,
    });
    s = recordMonitorVisit(s, 0, visit(s, [], "insufficient"), 150, now);
    expect(s.signals[0]!.misses).toBe(0);
    s = recordMonitorVisit(s, 0, visit(s, []), 150, now);
    expect(s.signals[0]!.misses).toBe(1);
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("keeps quiet, incomplete, failed and stale observations distinct in UI and target exports", () => {
    let s = createMonitorSession(profile, receiver, now, [targets()[0]!]);
    const target = s.targets![0]!;
    expect(monitorTargetObservation(s, target, Date.parse(now)).status).toBe(
      "Not yet observed",
    );
    expect(monitorTargetsCsv(s, Date.parse(now))).toContain("Not yet observed");
    s = recordMonitorVisit(s, 0, visit(s, []), 150, now);
    expect(monitorTargetObservation(s, target, Date.parse(now)).status).toBe(
      "No activity during last valid visit",
    );
    expect(
      monitorTargetObservation(s, target, Date.parse(now) + 31000).status,
    ).toBe("Observation stale");
    s = recordMonitorVisit(s, 0, visit(s, [], "failed"), 150, now);
    expect(monitorTargetObservation(s, target, Date.parse(now)).status).toBe(
      "Observation failed / incomplete",
    );
    expect(s.windows[0]!.validMs).toBe(150);
  });
  it("preserves v1 histories and makes target edits a new comparison boundary", () => {
    const legacy = createMonitorSession(profile, receiver, now);
    expect(validateMonitorSession(legacy)).toEqual(legacy);
    expect(legacy.version).toBe(1);
    const s = createMonitorSession(profile, receiver, now, targets());
    const edited = s.targets!.map((t, i) =>
      i === 0 ? { ...t, label: "Changed annotation" } : t,
    );
    expect(monitorContext(s.snapshot.profile, receiver, edited)).not.toBe(
      s.context,
    );
    const bad = structuredClone(s);
    bad.targets![0]!.endFrequencyHz = 0;
    expect(() => validateMonitorSession(bad)).toThrow();
  });
  it("splits wide ranges and rejects duplicates, tiny/overwide frequency regions and source limits before tuning", () => {
    const range = {
      id: "r",
      kind: "range" as const,
      label: "Range",
      startFrequencyHz: 99e6,
      endFrequencyHz: 101e6,
    };
    expect(
      createMonitorSession(profile, receiver, now, [range]).windows,
    ).toHaveLength(3);
    const t = frequencyTarget(100e6, 25000);
    expect(() => validateMonitorTargets([t, { ...t, id: "another" }])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      createMonitorSession(profile, receiver, now, [frequencyTarget(100e6, 1)]),
    ).toThrow(/FFT/);
    expect(() =>
      createMonitorSession(profile, receiver, now, [
        frequencyTarget(100e6, 2e6),
      ]),
    ).toThrow(/width/);
    expect(() =>
      createMonitorSession(profile, { ...receiver, source: "bladerf" }, now, [
        frequencyTarget(10e6, 25000),
      ]),
    ).toThrow(/passband/);
    expect(() =>
      validateMonitorTargets(
        Array.from({ length: 65 }, (_, i) =>
          frequencyTarget(100e6 + i * 1000, 500),
        ),
      ),
    ).toThrow(/64/);
  });
  it("uses capture noise for narrow targets occupied across their entire watch width", () => {
    const s = createMonitorSession(profile, receiver, now, [
        frequencyTarget(100e6, 1000),
      ]),
      plan = s.windows[0]!.plan;
    const bins = new Float32Array(4096).fill(-100);
    for (let i = 0; i < bins.length; i++) {
      const f = plan.centerFrequencyHz + (i - 2048) * 250;
      if (f >= plan.lowerFrequencyHz && f <= plan.upperFrequencyHz)
        bins[i] = -40;
    }
    const frame = {
      bins,
      centerFrequencyHz: plan.centerFrequencyHz,
      sampleRateHz: 1024000,
    } as SpectrumFrame;
    expect(
      analyzeScanWindow(plan, [frame], 6, "average", undefined, "capture")
        .candidates,
    ).toHaveLength(1);
  });
  it("round-trips named watchlists and reports invalid or unavailable storage", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    });
    localStorage.removeItem(WATCHLIST_KEY);
    const lists = [
      {
        version: 1 as const,
        id: "list",
        name: "Local channels",
        targets: targets(),
      },
    ];
    saveWatchlists(lists);
    expect(loadWatchlists()).toEqual(lists);
    expect(() => validateWatchlists([{ ...lists[0], version: 9 }])).toThrow();
    localStorage.setItem(WATCHLIST_KEY, "broken");
    expect(() => loadWatchlists()).toThrow();
    localStorage.removeItem(WATCHLIST_KEY);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage blocked");
      },
    });
    expect(() => loadWatchlists()).toThrow(/blocked/);
    vi.unstubAllGlobals();
  });
});
