import { describe, expect, it } from "vitest";
import { analyzeMonitorWindow } from "./monitorDetection";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
  monitorCsv,
  setMonitorBaseline,
} from "./signalMonitor";
import type { SpectrumFrame, SourceSessionMetadata } from "./types";
import type { SurveyProfile } from "./fieldSurvey";
import type { SpectrumMeasurement } from "./spectrumScan";

const at = (n: number) =>
  new Date(Date.UTC(2026, 9, 18, 0, 0, n)).toISOString();
function fixture(center = 100e6, n = 4096, rate = 1024000) {
  const receiver: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: center,
    selectedChannelFrequencyHz: center,
    mode: "OFF",
    channelBandwidthHz: 200000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const profile: SurveyProfile = {
    version: 1,
    name: "Adaptive fixture",
    site: { label: "Synthetic" },
    bands: [
      {
        id: "test",
        name: "Test",
        startFrequencyHz: center - rate / 4,
        endFrequencyHz: center + rate / 4,
        dwellMs: 150,
        thresholdDb: 10,
        detector: "average",
        captureSeconds: 2,
      },
    ],
  };
  const session = createMonitorSession(profile, receiver, at(0), undefined, {
    version: 2,
    preset: "general",
  });
  const detect = (
    paints: ((b: Float32Array) => void)[],
    preset: "general" | "narrow" | "bursts" = "general",
  ) => {
    const frames = paints.map((paint, i) => {
      const bins = new Float32Array(n).fill(-100);
      paint(bins);
      return {
        bins,
        centerFrequencyHz: center,
        sampleRateHz: rate,
        sessionGeneration: 1,
        sampleIndex: i * n * 4,
      } as SpectrumFrame;
    });
    const m: SpectrumMeasurement = {
      frames,
      sourceSamples: n * 4 * frames.length,
      targetSamples: n * 4 * frames.length,
      missingSamples: 0,
      coverage: 1,
      status: "complete",
    };
    return analyzeMonitorWindow(
      session.windows[0]!.plan,
      m,
      10,
      preset === "bursts" ? "max-hold" : "average",
      { version: 2, preset },
    );
  };
  return { session, detect, receiver, profile };
}
const notched = (b: Float32Array) => {
  b.fill(-50, 1800, 1880);
  b.fill(-96, 1880, 1888);
  b.fill(-52, 1888, 1968);
};
describe("adaptive envelopes and independent-visit centers", () => {
  it.each([
    [14.2e6, 2048, 512000],
    [100e6, 4096, 1024000],
    [433.92e6, 8192, 2048000],
    [5.8e9, 4096, 1024000],
  ])("scales to actual FFT spacing at %s Hz", (center, n, rate) => {
    const f = fixture(center, n, rate);
    const r = f.detect([
      (b) => {
        const a = n / 2 - 100;
        b.fill(-50, a, a + 40);
        b.fill(-96, a + 40, a + 44);
        b.fill(-52, a + 44, a + 84);
      },
    ]);
    expect(r.binSpacingHz).toBe(rate / n);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.group?.componentCount).toBe(2);
    expect(r.candidates[0]!.bandwidthHz).toBe((84 * rate) / n);
    const s = recordMonitorVisit(f.session, 0, r, 150, at(1));
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("joins shallow broad fragments and counts union presence and confidence once per visit", () => {
    const f = fixture();
    const r = f.detect([notched, notched, () => {}]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.occupancy).toBe(2 / 3);
    expect(r.candidates[0]!.group).toMatchObject({
      componentCount: 2,
      reason: "supported-notch",
    });
    let s = recordMonitorVisit(f.session, 0, r, 150, at(1));
    expect(s.signals[0]).toMatchObject({
      detections: 1,
      confirmed: false,
      validMs: 150,
      activeMs: 100,
    });
    s = recordMonitorVisit(s, 0, r, 150, at(2));
    expect(s.signals[0]).toMatchObject({
      detections: 2,
      confirmed: true,
      validMs: 300,
      activeMs: 200,
    });
    expect(s.signals[0]!.centerEvidence).toHaveLength(2);
  });
  it("preserves deep valleys, weak narrow neighbors and an explicit narrow preset", () => {
    const f = fixture();
    expect(
      f.detect([
        (b) => {
          b.fill(-50, 1800, 1880);
          b.fill(-52, 1888, 1968);
        },
      ]).candidates,
    ).toHaveLength(2);
    expect(
      f.detect([
        (b) => {
          b.fill(-50, 1800, 1880);
          b[1883] = -88;
        },
      ]).candidates,
    ).toHaveLength(2);
    expect(f.detect([notched], "narrow").candidates).toHaveLength(2);
    expect(
      f.detect([
        (b) => {
          b[2000] = -40;
          b[2004] = -45;
        },
      ]).candidates,
    ).toHaveLength(2);
  });
  it("does not mistake sequential max-hold bursts for a simultaneous envelope", () => {
    const f = fixture();
    const r = f.detect(
      [
        (b) => {
          b.fill(-50, 1800, 1880);
          b.fill(-96, 1880, 1888);
        },
        (b) => b.fill(-52, 1888, 1968),
      ],
      "bursts",
    );
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.occupancy)).toEqual([0.5, 0.5]);
  });
  it("bounds transitive chains and never expands to the whole chain", () => {
    const f = fixture();
    const r = f.detect([
      (b) => {
        for (let i = 0; i < 6; i++) {
          b.fill(-50, 1800 + i * 22, 1820 + i * 22);
          if (i < 5) b.fill(-96, 1820 + i * 22, 1822 + i * 22);
        }
      },
    ]);
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.candidates.every((c) => c.bandwidthHz <= 60 * 250)).toBe(true);
  });
  it("uses a bounded median center despite peak movement and a single edge outlier", () => {
    const f = fixture();
    let s = f.session;
    for (const [i, shift] of [0, 1, -1, 10, 0].entries()) {
      const r = f.detect([
        (b) => {
          b.fill(-55, 1800 + shift, 1900 + shift);
          b[1805 + shift + i * 10] = -40;
        },
      ]);
      s = recordMonitorVisit(s, 0, r, 150, at(i + 1));
    }
    expect(s.signals).toHaveLength(1);
    const signal = s.signals[0]!;
    expect(signal.frequencyHz).toBe(100e6 + (1849.5 - 2048) * 250);
    expect(signal.centerSpreadHz).toBe(2750);
    expect(signal.frequencyHz).not.toBe(signal.peakFrequencyHz);
    s = setMonitorBaseline(s, at(6));
    for (let i = 7; i < 26; i++)
      s = recordMonitorVisit(
        s,
        0,
        f.detect([
          (b) => {
            b.fill(-55, 1800, 1900);
            b[1805] = -40;
          },
        ]),
        150,
        at(i),
      );
    expect(s.signals[0]!.centerEvidence).toHaveLength(9);
    expect(s.signals[0]!.history).toHaveLength(24);
    expect(s.signals[0]!.change).toBe("known");
    expect(validateMonitorSession(s)).toEqual(s);
    expect(monitorCsv(s)).toContain('"center_spread_hz"');
  });
  it("keeps assignments stable when candidate order changes and preserves neighbors", () => {
    const f = fixture();
    const r = f.detect([
      (b) => {
        b.fill(-50, 1800, 1840);
        b.fill(-50, 1848, 1888);
      },
    ]);
    let s = recordMonitorVisit(f.session, 0, r, 150, at(1));
    const ids = s.signals.map((x) => x.id);
    const a = recordMonitorVisit(s, 0, r, 150, at(2));
    const b = recordMonitorVisit(
      s,
      0,
      { ...r, candidates: [...r.candidates].reverse() },
      150,
      at(2),
    );
    expect(a).toEqual(b);
    expect(a.signals.map((x) => x.id)).toEqual(ids);
    expect(a.signals).toHaveLength(2);
    s = recordMonitorVisit(a, 0, { ...r, status: "failed" }, 150, at(3));
    expect(s.signals.map((x) => [x.detections, x.misses])).toEqual([
      [2, 0],
      [2, 0],
    ]);
  });
  it("marks clipped centers provisional and does not contaminate reliable centers", () => {
    const f = fixture();
    const plan = f.session.windows[0]!.plan;
    const r = f.detect([(b) => b.fill(-50, 1024, 1080)]);
    expect(r.candidates[0]!.lowerFrequencyHz).toBe(plan.lowerFrequencyHz);
    expect(r.candidates[0]!.lowerEdgeClipped).toBe(true);
    const s = recordMonitorVisit(f.session, 0, r, 150, at(1));
    expect(s.signals[0]!.centerEvidence).toEqual([]);
    expect(validateMonitorSession(s)).toEqual(s);
  });
  it("preserves old detector versions and rejects forged or oversized adaptive evidence", () => {
    const f = fixture();
    let s = recordMonitorVisit(f.session, 0, f.detect([notched]), 150, at(1));
    expect(s.version).toBe(4);
    for (const mutate of [
      (v: typeof s) => {
        v.signals[0]!.frequencyHz += 200;
      },
      (v: typeof s) => {
        v.signals[0]!.group!.components[0]!.peakHz = Infinity;
      },
      (v: typeof s) => {
        v.signals[0]!.centerEvidence = Array(10).fill(
          v.signals[0]!.centerEvidence![0],
        );
      },
      (v: typeof s) => {
        v.signals[0]!.group!.components = Array(17).fill(
          v.signals[0]!.group!.components[0],
        );
      },
    ]) {
      const bad = structuredClone(s);
      mutate(bad);
      expect(() => validateMonitorSession(bad)).toThrow();
    }
    for (const analysis of [
      undefined,
      { version: 1 as const, preset: "general" as const },
    ]) {
      const old = createMonitorSession(
        f.profile,
        f.receiver,
        at(0),
        undefined,
        analysis,
      );
      expect(old.version).toBe(analysis ? 3 : 1);
      expect(validateMonitorSession(old)).toEqual(old);
    }
    const missing = f.detect([notched]);
    delete missing.binSpacingHz;
    expect(() => recordMonitorVisit(f.session, 0, missing, 150, at(1))).toThrow(
      /FFT spacing/,
    );
    s = recordMonitorVisit(
      s,
      0,
      { ...f.detect([() => {}]), status: "insufficient" },
      150,
      at(2),
    );
    expect(s.signals[0]!.misses).toBe(0);
  });
  it("keeps a full adaptive checkpoint bounded and rejects overflow without deleting confirmed history", () => {
    const f = fixture();
    const r = f.detect([
      (b) => {
        for (let i = 0; i < 512; i++) b[1025 + i * 2] = -45;
      },
    ]);
    let s = recordMonitorVisit(f.session, 0, r, 150, at(1));
    s = recordMonitorVisit(s, 0, r, 150, at(2));
    expect(s.signals).toHaveLength(512);
    for (const signal of s.signals) {
      signal.history = Array.from({ length: 24 }, () => ({
        at: at(2),
        seen: true,
        snrDb: 55,
      }));
      signal.centerEvidence = Array.from({ length: 9 }, () => ({
        ...signal.centerEvidence![0]!,
      }));
    }
    expect(JSON.stringify(s).length).toBeLessThan(8_000_000);
    expect(validateMonitorSession(s)).toEqual(s);
    s = recordMonitorVisit(
      s,
      0,
      f.detect([
        (b) => {
          b[2800] = -45;
        },
      ]),
      150,
      at(3),
    );
    expect(s.signals).toHaveLength(512);
    expect(s.omittedSignals).toBe(1);
    expect(s.signals.every((x) => x.confirmed)).toBe(true);
  });
  it("requires a common frame throughout a spectral chain", () => {
    const f = fixture();
    const r = f.detect(
      [
        (b) => {
          b.fill(-50, 1800, 1820);
          b.fill(-96, 1820, 1822);
          b.fill(-50, 1822, 1842);
          b.fill(-96, 1842, 1844);
        },
        (b) => {
          b.fill(-50, 1822, 1842);
          b.fill(-96, 1842, 1844);
          b.fill(-50, 1844, 1864);
        },
      ],
      "bursts",
    );
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]!.group!.componentCount).toBe(2);
  });
  it("tracks narrow bin drift without merging simultaneous adjacent carriers", () => {
    const f = fixture();
    let s = f.session;
    for (let i = 0; i < 12; i++) {
      s = recordMonitorVisit(
        s,
        0,
        f.detect([
          (b) => {
            b[2100 + i] = -45;
            b[2150 + i] = -50;
          },
        ]),
        150,
        at(i + 1),
      );
    }
    expect(s.signals).toHaveLength(2);
    expect(s.signals.map((x) => x.detections)).toEqual([12, 12]);
    expect(s.signals[1]!.frequencyHz - s.signals[0]!.frequencyHz).toBe(12500);
    expect(validateMonitorSession(s)).toEqual(s);
  });
});
