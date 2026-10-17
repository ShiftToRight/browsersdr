import { describe, expect, it } from "vitest";
import {
  createMonitorSession,
  monitorContext,
  recordMonitorVisit,
  setMonitorBaseline,
  validateMonitorSession,
  MONITOR_MAX_SIGNALS,
} from "./signalMonitor";
import type { SurveyProfile } from "./fieldSurvey";
import type { SourceSessionMetadata } from "./types";
import type { ScanWindowResult } from "./spectrumScan";

export const monitorReceiver: SourceSessionMetadata = {
  source: "synthetic",
  sessionGeneration: 1,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_000_000,
  mode: "OFF",
  channelBandwidthHz: 200_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
export const monitorProfile: SurveyProfile = {
  version: 1,
  name: "Test monitor",
  site: { label: "Test site" },
  bands: [
    {
      id: "test",
      name: "Test band",
      startFrequencyHz: 99_700_000,
      endFrequencyHz: 100_300_000,
      dwellMs: 150,
      thresholdDb: 6,
      detector: "max-hold",
      captureSeconds: 5,
    },
  ],
};
const t = (n: number) =>
  new Date(Date.UTC(2026, 9, 17, 12, 0, n)).toISOString();
function visit(
  s: ReturnType<typeof createMonitorSession>,
  frequencyHz: number | null = 100_010_000,
  extra: Partial<ScanWindowResult> = {},
  index = 0,
) {
  return {
    plan: s.windows[index]!.plan,
    points: [],
    candidates:
      frequencyHz === null
        ? []
        : [
            {
              frequencyHz,
              peakDb: -40,
              noiseFloorDb: -90,
              bandwidthHz: 1000,
              occupancy: 0.5,
            },
          ],
    noiseFloorDb: -90,
    frameCount: 4,
    coverage: 1,
    missingSamples: 0,
    status: "complete",
    ...extra,
  } as ScanWindowResult;
}
describe("continuous monitoring evidence", () => {
  it("holds stable entries across bin drift and distinguishes returning and baseline changes", () => {
    let s = createMonitorSession(monitorProfile, monitorReceiver, t(0));
    s = recordMonitorVisit(s, 0, visit(s), 150, t(1));
    const id = s.signals[0]!.id;
    expect(s.signals[0]!.change).toBe("new");
    s = recordMonitorVisit(s, 0, visit(s, 100_010_200), 150, t(2));
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0]).toMatchObject({
      id,
      detections: 2,
      change: "new",
      validMs: 300,
      activeMs: 150,
    });
    s = recordMonitorVisit(s, 0, visit(s, null), 150, t(3));
    expect(s.signals[0]!.misses).toBe(1);
    s = recordMonitorVisit(s, 0, visit(s), 150, t(4));
    expect(s.signals[0]).toMatchObject({
      id,
      change: "returning",
      detections: 3,
      validMs: 600,
      activeMs: 225,
    });
    const changed = visit(s);
    changed.candidates[0]!.peakDb = -30;
    s = recordMonitorVisit(s, 0, changed, 150, t(5));
    expect(s.signals[0]!.change).toBe("changed");
    s = setMonitorBaseline(s, t(6));
    expect(s.signals[0]!.baseline.snrDb).toBe(60);
    expect(s.signals[0]!.firstSeen).toBe(t(1));
  });
  it("does not turn failed, incomplete or other-window observations into absence", () => {
    let s = createMonitorSession(
      {
        ...monitorProfile,
        bands: [{ ...monitorProfile.bands[0]!, endFrequencyHz: 101_700_000 }],
      },
      monitorReceiver,
      t(0),
    );
    s = recordMonitorVisit(s, 0, visit(s, 100_010_000), 150, t(1));
    const before = s.signals[0];
    s = recordMonitorVisit(
      s,
      0,
      visit(s, null, { status: "insufficient", coverage: 0.4 }),
      150,
      t(2),
    );
    s = recordMonitorVisit(s, 1, visit(s, null, {}, 1), 150, t(3));
    s = recordMonitorVisit(
      s,
      0,
      visit(s, null, { status: "failed", coverage: 0, error: "No data" }),
      150,
      t(4),
    );
    expect(s.signals[0]).toEqual(before);
    expect(s.windows[0]!.lastValidAt).toBe(t(1));
    expect(s.windows[0]!.validMs).toBe(150);
  });
  it("keeps neighboring signals separate and bounds retained observations", () => {
    let s = createMonitorSession(monitorProfile, monitorReceiver, t(0));
    const result = visit(s);
    result.candidates.push({
      ...result.candidates[0]!,
      frequencyHz: 100_012_000,
    });
    for (let i = 0; i < 60; i++)
      s = recordMonitorVisit(s, 0, result, 150, t(i));
    expect(s.signals).toHaveLength(2);
    expect(s.signals[0]!.history).toHaveLength(24);
    expect(s.signals[0]!.detections).toBe(60);
  });
  it("flags center responses and low margin without claiming artifact identity", () => {
    let s = createMonitorSession(monitorProfile, monitorReceiver, t(0));
    s = recordMonitorVisit(s, 0, visit(s, 100_000_000), 150, t(1));
    expect(s.signals[0]!.caution).toContain("possible DC");
    const weak = visit(s, 100_020_000);
    weak.candidates[0]!.peakDb = -83;
    s = recordMonitorVisit(s, 0, weak, 150, t(2));
    expect(s.signals[1]!.caution).toContain("Low detection margin");
  });
  it("retains existing entries at capacity and makes omitted detections explicit", () => {
    let s = createMonitorSession(monitorProfile, monitorReceiver, t(0));
    s = recordMonitorVisit(s, 0, visit(s), 150, t(1));
    s = {
      ...s,
      signals: Array.from({ length: MONITOR_MAX_SIGNALS }, (_, i) => ({
        ...s.signals[0]!,
        id: `existing-${i}`,
        frequencyHz: 99_710_000 + i * 300,
      })),
    };
    const next = recordMonitorVisit(s, 0, visit(s, 100_200_000), 150, t(2));
    expect(next.signals).toHaveLength(MONITOR_MAX_SIGNALS);
    expect(next.omittedSignals).toBe(1);
    expect(next.signals[0]!.id).toBe("existing-0");
  });
  it("validates persisted data and rejects invalid bounds, evidence and plans", () => {
    let s = createMonitorSession(monitorProfile, monitorReceiver, t(0));
    s = recordMonitorVisit(s, 0, visit(s), 150, t(1));
    expect(validateMonitorSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
    for (const mutate of [
      (v: typeof s) => {
        v.version = 2 as 1;
      },
      (v: typeof s) => {
        v.nextWindow = 100;
      },
      (v: typeof s) => {
        v.signals[0]!.frequencyHz = NaN;
      },
      (v: typeof s) => {
        v.signals[0]!.activeMs = 100_000;
      },
      (v: typeof s) => {
        v.windows[0]!.plan.centerFrequencyHz++;
      },
      (v: typeof s) => {
        v.context = "mismatch";
      },
      (v: typeof s) => {
        v.signals[0]!.history[0]!.at = "bad";
      },
    ]) {
      const copy = structuredClone(s);
      mutate(copy);
      expect(() => validateMonitorSession(copy)).toThrow();
    }
  });
});

// Imported profiles and edited current-window bands may have different object key order.
it("compares equivalent plans canonically after validation", () => {
  const profile = {
    ...monitorProfile,
    bands: monitorProfile.bands.map((b) => ({
      id: b.id,
      name: b.name,
      startFrequencyHz: b.startFrequencyHz,
      endFrequencyHz: b.endFrequencyHz,
      dwellMs: b.dwellMs,
      thresholdDb: b.thresholdDb,
      detector: b.detector,
      captureSeconds: b.captureSeconds,
    })),
  };
  const session = createMonitorSession(profile, monitorReceiver);
  expect(monitorContext(profile, monitorReceiver)).toBe(session.context);
});
