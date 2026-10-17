import { describe, expect, it } from "vitest";
import {
  analyzeMonitorWindow,
  MONITOR_PRESETS,
  type MonitorPreset,
} from "./monitorDetection";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
  setMonitorBaseline,
  MONITOR_MAX_SIGNALS,
  monitorTargetObservation,
} from "./signalMonitor";
import type { SpectrumFrame, SourceSessionMetadata } from "./types";
import type { ScanWindowResult, SignalCandidate } from "./spectrumScan";
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
  name: "Quality",
  site: { label: "Test" },
  bands: [
    {
      id: "x",
      name: "Any range",
      startFrequencyHz: 99.7e6,
      endFrequencyHz: 100.3e6,
      dwellMs: 150,
      thresholdDb: 10,
      detector: "average",
      captureSeconds: 5,
    },
  ],
};
const time = (n: number) =>
  new Date(Date.UTC(2026, 9, 18, 0, 0, n)).toISOString();
function measurement(paint: (bins: Float32Array) => void, center = 100e6) {
  const bins = new Float32Array(4096).fill(-100);
  paint(bins);
  const frame = {
    bins,
    centerFrequencyHz: center,
    sampleRateHz: 1024000,
    sessionGeneration: 1,
    sampleIndex: 200000,
  } as SpectrumFrame;
  return {
    frames: [frame],
    targetSamples: 153600,
    sourceSamples: 153600,
    missingSamples: 0,
    coverage: 1,
    status: "complete" as const,
  };
}
function detect(
  paint: (bins: Float32Array) => void,
  preset: MonitorPreset = "general",
  center = 100e6,
) {
  return analyzeMonitorWindow(
    {
      index: 0,
      centerFrequencyHz: center,
      lowerFrequencyHz: center - 300000,
      upperFrequencyHz: center + 300000,
    },
    measurement(paint, center),
    10,
    "average",
    { version: 1, preset },
  );
}
const create = (preset: MonitorPreset = "general", p = profile) =>
  createMonitorSession(p, receiver, time(0), undefined, { version: 1, preset });
const visit = (
  s: ReturnType<typeof create>,
  candidates: SignalCandidate[],
  index = 0,
  status: ScanWindowResult["status"] = "complete",
): ScanWindowResult => ({
  plan: s.windows[index]!.plan,
  points: [],
  candidates,
  noiseFloorDb: -100,
  coverage: status === "complete" ? 1 : 0,
  missingSamples: 0,
  frameCount: 1,
  status,
});
function region(
  lower: number,
  upper: number,
  peak = (lower + upper) / 2,
): SignalCandidate {
  return {
    frequencyHz: (lower + upper) / 2,
    bandwidthHz: upper - lower,
    lowerFrequencyHz: lower,
    upperFrequencyHz: upper,
    peakFrequencyHz: peak,
    peakDb: -50,
    noiseFloorDb: -100,
    lowerEdgeClipped: false,
    upperEdgeClipped: false,
    occupancy: 1,
  };
}
describe("versioned monitoring spectrum regions", () => {
  it.each([2e6, 14.2e6, 100e6, 433.92e6, 915e6, 5.8e9])(
    "preserves separate narrow carriers at %s Hz without FM assumptions",
    (center) => {
      const result = detect(
        (b) => {
          b[2000] = -40;
          b[2008] = -45;
        },
        "narrow",
        center,
      );
      expect(result.candidates).toHaveLength(2);
      expect(
        result.candidates[1]!.frequencyHz - result.candidates[0]!.frequencyHz,
      ).toBe(2000);
      expect(result.candidates[0]!.bandwidthHz).toBe(250);
    },
  );
  it("bridges shallow small holes but preserves deep separating valleys", () => {
    expect(
      detect((b) => {
        b.fill(-50, 1800, 1900);
        b[1840] = -92;
      }).candidates,
    ).toHaveLength(1);
    expect(
      detect((b) => {
        b.fill(-50, 1800, 1840);
        b.fill(-50, 1842, 1900);
      }).candidates,
    ).toHaveLength(2);
  });
  it("consolidates a notched broad signal in the optional FM profile and retains narrow responses", () => {
    const result = detect((b) => {
      b.fill(-50, 1700, 2100);
      b.fill(-94, 1850, 1865);
      b[2300] = -40;
    }, "fm-balanced");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.bandwidthHz).toBe(100000);
    expect(result.candidates[1]!.bandwidthHz).toBe(250);
  });
  it("averages linear power and retains the peak separately from actual span center", () => {
    const m = measurement((b) => {
      b.fill(-60, 1800, 1820);
    });
    m.frames.push(measurement((b) => b.fill(-40, 1800, 1820)).frames[0]!);
    const result = analyzeMonitorWindow(
      {
        index: 0,
        centerFrequencyHz: 100e6,
        lowerFrequencyHz: 99.7e6,
        upperFrequencyHz: 100.3e6,
      },
      m,
      10,
      "average",
      { version: 1, preset: "general" },
    );
    expect(result.candidates[0]!.peakDb).toBeCloseTo(
      10 * Math.log10((10 ** -6 + 10 ** -4) / 2),
      5,
    );
    expect(result.candidates[0]!.frequencyHz).not.toBe(
      result.candidates[0]!.peakFrequencyHz,
    );
    expect(
      result.candidates[0]!.upperFrequencyHz! -
        result.candidates[0]!.lowerFrequencyHz!,
    ).toBe(result.candidates[0]!.bandwidthHz);
  });
  it("tracks broad regions across moving peaks and requires repeated valid evidence", () => {
    let s = create();
    const result = detect((b) => {
      b.fill(-55, 1800, 2000);
      b[1810] = -40;
    });
    s = recordMonitorVisit(s, 0, result, 150, time(1));
    const id = s.signals[0]!.id;
    expect(s.signals[0]!.confirmed).toBe(false);
    const second = detect((b) => {
      b.fill(-55, 1800, 2000);
      b[1980] = -40;
    });
    s = recordMonitorVisit(s, 0, second, 150, time(2));
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]).toMatchObject({ id, confirmed: true, detections: 2 });
    expect(validateMonitorSession(s)).toEqual(s);
    const bad = structuredClone(s);
    delete bad.signals[0]!.lowerFrequencyHz;
    expect(() => validateMonitorSession(bad)).toThrow();
  });
  it("does not count failed or insufficient observations as misses or confirmation", () => {
    let s = create("fm-balanced");
    const c = region(100010000, 100060000);
    s = recordMonitorVisit(s, 0, visit(s, [c]), 150, time(1));
    s = recordMonitorVisit(s, 0, visit(s, [], 0, "insufficient"), 150, time(2));
    s = recordMonitorVisit(s, 0, visit(s, [], 0, "failed"), 150, time(3));
    expect(s.signals[0]).toMatchObject({
      misses: 0,
      confirmed: false,
      validMs: 150,
    });
    s = recordMonitorVisit(s, 0, visit(s, [c]), 150, time(4));
    expect(s.signals[0]!.confirmed).toBe(false);
    s = recordMonitorVisit(s, 0, visit(s, [c]), 150, time(5));
    expect(s.signals[0]!.confirmed).toBe(true);
  });
  it("requires three sustained baseline differences and does not treat moving peaks as frequency drift", () => {
    let s = create();
    const c = region(100010000, 100060000);
    s = recordMonitorVisit(s, 0, visit(s, [c]), 150, time(1));
    s = setMonitorBaseline(s, time(2));
    for (let n = 3; n < 6; n++) {
      s = recordMonitorVisit(
        s,
        0,
        visit(s, [{ ...c, peakDb: -40, peakFrequencyHz: 100058000 }]),
        150,
        time(n),
      );
      expect(s.signals[0]!.change).toBe(n === 5 ? "changed" : "known");
    }
  });
  it("resets a pending baseline change after a valid absence", () => {
    let s = create();
    const c = region(100010000, 100060000);
    s = recordMonitorVisit(s, 0, visit(s, [c]), 150, time(1));
    s = setMonitorBaseline(s, time(2));
    for (const n of [3, 4])
      s = recordMonitorVisit(
        s,
        0,
        visit(s, [{ ...c, peakDb: -40 }]),
        150,
        time(n),
      );
    expect(s.signals[0]!.changeStreak).toBe(2);
    s = recordMonitorVisit(s, 0, visit(s, []), 150, time(5));
    expect(s.signals[0]!.changeStreak).toBe(0);
    s = recordMonitorVisit(
      s,
      0,
      visit(s, [{ ...c, peakDb: -40 }]),
      150,
      time(6),
    );
    expect(s.signals[0]!.change).toBe("known");
    expect(s.signals[0]!.changeStreak).toBe(1);
  });
  it("stitches complementary clipped window edges without duplicate entries", () => {
    const p = structuredClone(profile);
    p.bands[0]!.startFrequencyHz = 99.2e6;
    p.bands[0]!.endFrequencyHz = 100.6e6;
    let s = createMonitorSession(
      p,
      receiver,
      time(0),
      [
        {
          id: "range",
          kind: "range",
          label: "Seam range",
          startFrequencyHz: 99.2e6,
          endFrequencyHz: 100.6e6,
        },
      ],
      { version: 1, preset: "general" },
    );
    const seam = s.windows[0]!.plan.upperFrequencyHz;
    s = recordMonitorVisit(
      s,
      0,
      visit(s, [{ ...region(seam - 20000, seam), upperEdgeClipped: true }]),
      150,
      time(1),
    );
    s = recordMonitorVisit(
      s,
      1,
      visit(s, [{ ...region(seam, seam + 10000), lowerEdgeClipped: true }], 1),
      150,
      time(2),
    );
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]).toMatchObject({
      lowerFrequencyHz: seam - 20000,
      upperFrequencyHz: seam + 10000,
      validMs: 300,
    });
    expect(
      monitorTargetObservation(s, s.targets![0]!, Date.parse(time(2))).status,
    ).toBe("Activity detected");
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("preserves one-frame burst evidence and does not create candidates from invalid coverage", () => {
    const m = measurement((b) => {
      b[2200] = -40;
    });
    for (let i = 0; i < 4; i++) m.frames.push(measurement(() => {}).frames[0]!);
    const plan = {
      index: 0,
      centerFrequencyHz: 100e6,
      lowerFrequencyHz: 99.7e6,
      upperFrequencyHz: 100.3e6,
    };
    const result = analyzeMonitorWindow(plan, m, 12, "max-hold", {
      version: 1,
      preset: "bursts",
    });
    expect(result.candidates[0]!.occupancy).toBe(0.2);
    let s = create("bursts");
    s = recordMonitorVisit(s, 0, result, 150, time(1));
    expect(s.signals[0]!.confirmed).toBe(true);
    expect(
      analyzeMonitorWindow(
        plan,
        { ...m, status: "insufficient" },
        12,
        "max-hold",
        { version: 1, preset: "bursts" },
      ).candidates,
    ).toHaveLength(0);
  });
  it("protects confirmed history and replaces stale tentative candidates at the cap with unique IDs", () => {
    let s = create();
    const candidates = Array.from({ length: MONITOR_MAX_SIGNALS }, (_, i) =>
      region(99750000 + i * 500, 99750250 + i * 500),
    );
    s = recordMonitorVisit(s, 0, visit(s, candidates), 150, time(1));
    const protectedId = s.signals[0]!.id;
    s.signals[0]!.confirmed = true;
    for (let i = 2; i <= 4; i++)
      s = recordMonitorVisit(s, 0, visit(s, []), 150, time(i));
    s = recordMonitorVisit(
      s,
      0,
      visit(s, [region(100250000, 100250250), region(100252000, 100252250)]),
      150,
      time(5),
    );
    expect(s.signals).toHaveLength(512);
    expect(s.discardedCandidates).toBe(2);
    expect(s.signals.some((x) => x.id === protectedId)).toBe(true);
    expect(new Set(s.signals.map((x) => x.id)).size).toBe(512);
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("preserves legacy session versions and rejects incompatible detector provenance", () => {
    for (const targets of [
      undefined,
      [
        {
          id: "target",
          kind: "range" as const,
          label: "Range",
          startFrequencyHz: 99.7e6,
          endFrequencyHz: 100.3e6,
        },
      ],
    ]) {
      const s = createMonitorSession(profile, receiver, time(0), targets);
      expect(validateMonitorSession(s)).toEqual(s);
      expect(s.version).toBe(targets ? 2 : 1);
    }
    const s = create();
    s.analysis!.preset = "narrow";
    expect(() => validateMonitorSession(s)).toThrow();
    expect(MONITOR_PRESETS.general.label).toBe("General spectrum");
    expect(MONITOR_PRESETS["fm-balanced"]).toMatchObject({
      dwellMs: 350,
      thresholdDb: 12,
    });
  });
  it("rejects a dwell that would overflow the retained measurement buffer before acquisition", () => {
    const fast = { ...receiver, actualSampleRateHz: 19200000 };
    const p = structuredClone(profile);
    p.bands[0]!.dwellMs = 350;
    expect(() =>
      createMonitorSession(p, fast, time(0), undefined, {
        version: 1,
        preset: "general",
      }),
    ).toThrow(/bounded measurement buffer/);
    p.bands[0]!.dwellMs = 150;
    expect(
      createMonitorSession(p, fast, time(0), undefined, {
        version: 1,
        preset: "general",
      }).version,
    ).toBe(3);
  });
});
