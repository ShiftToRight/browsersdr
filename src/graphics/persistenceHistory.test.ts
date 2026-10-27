import { describe, expect, it } from "vitest";
import type { SpectrumFrame } from "../radio/types";
import {
  PersistenceHistory,
  PERSISTENCE_CAPACITY,
  PERSISTENCE_COLUMNS,
} from "./persistenceHistory";
import { persistenceColor } from "./canvasPersistence";

function frame(
  sequence: number,
  patch: Partial<SpectrumFrame> = {},
): SpectrumFrame {
  return {
    sessionGeneration: 1,
    sequence,
    sampleIndex: (sequence + 1) * 40,
    sampleRateHz: 1000,
    centerFrequencyHz: 100e6,
    timestampMs: sequence * 40,
    units: "relative-dB",
    droppedFramesBefore: 0,
    hopSamples: 40,
    bins: new Float32Array(4096).fill(-90),
    ...patch,
  };
}
describe("observed-spectrum persistence", () => {
  it("maps the selected colour ceiling without changing the numerical occurrence", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 10);
    for (let i = 0; i < 100; i++)
      h.accept(
        frame(i, { bins: new Float32Array(4096).fill(i < 12 ? -40 : -90) }),
      );
    const measured = h.inspect(0.5, -40)!;
    expect(measured.fraction).toBe(0.12);
    expect(persistenceColor(measured.fraction, 0.1)).toEqual([255, 55, 20]);
    const restrained = persistenceColor(measured.fraction, 0.5);
    expect(restrained[0]).toBeLessThan(180);
    expect(restrained[2]).toBeGreaterThan(100);
    expect(persistenceColor(measured.fraction, 1)[2]).toBeGreaterThan(200);
    expect(persistenceColor(0.01, 0.1)[2]).toBeGreaterThan(200);
    expect(h.inspect(0.5, -40)).toEqual(measured);
    expect(h.count).toBe(100);
  });

  it("preserves compatible channel history across restarted clocks, rejects stale generations and expires retained observations", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 4);
    for (let i = 0; i < 50; i++) h.accept(frame(i));
    const counts = h.counts.slice();
    h.continueGeneration(2);
    h.continueGeneration(2);
    expect(h.counts).toEqual(counts);
    expect(h.count).toBe(50);
    expect(h.latest?.sessionGeneration).toBe(2);
    expect(h.accept(frame(51))).toBe(false);
    expect(h.accept(frame(0, { sessionGeneration: 2 }))).toBe(true);
    expect(h.count).toBe(51);
    expect(h.duration).toBeCloseTo(2);
    expect(h.gaps).toBe(1);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
    for (let i = 1; i < 110; i++) h.accept(frame(i, { sessionGeneration: 2 }));
    expect(h.count).toBeLessThanOrEqual(101);
    expect(h.duration).toBeCloseTo(4);
    h.continueGeneration(3);
    h.accept(frame(0, { sessionGeneration: 3, centerFrequencyHz: 101e6 }));
    expect(h.count).toBe(1);
    h.reset(4);
    expect(h.count).toBe(0);
    expect(h.latest).toBeUndefined();
    expect(h.accept(frame(1, { sessionGeneration: 3 }))).toBe(false);
  });

  it("retains a full minute at the normal maximum cadence and expires older observations exactly", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 60);
    for (let i = 0; i <= 1550; i++) h.accept(frame(i));
    expect(h.count).toBe(1501);
    expect(h.duration).toBeCloseTo(60);
    expect(h.limited).toBe(false);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
    h.configure(-100, 100, 30);
    expect(h.count).toBe(751);
    expect(h.duration).toBeCloseTo(30);
    h.configure(-100, 100, 60);
    expect(h.count).toBe(751);
    h.accept(frame(1551));
    expect(h.count).toBe(752);
    expect(h.duration).toBeCloseTo(30.04);
  });

  it("rejects invalid initial generations and clears capacity warnings when the shortened interval expires", () => {
    const h = new PersistenceHistory();
    expect(h.accept(frame(0, { sessionGeneration: -1 }))).toBe(false);
    h.configure(-100, 100, 16);
    for (let i = 0; i < PERSISTENCE_CAPACITY + 1; i++)
      h.accept(frame(i, { sampleIndex: i + 1, hopSamples: 1 }));
    expect(h.limited).toBe(true);
    h.accept(frame(PERSISTENCE_CAPACITY + 1, { sampleIndex: 20000 }));
    expect(h.count).toBe(1);
    expect(h.limited).toBe(false);
  });

  it("counts each observed frame, retains narrow peaks and distinguishes rare strength from occurrence", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 10);
    for (let i = 0; i < 100; i++) {
      const f = frame(i);
      f.bins[800] = -55;
      if (i === 5) f.bins[2400] = -30;
      h.accept(f);
    }
    expect(h.inspect(100 / 512, -55)?.fraction).toBe(1);
    expect(h.inspect(300 / 512, -30)?.fraction).toBe(0.01);
    expect(h.inspect(300 / 512, -90)?.fraction).toBe(0.99);
    expect(h.count).toBe(100);
    expect(h.observations[100]).toBe(100);
    expect(persistenceColor(1)).toEqual([255, 55, 20]);
    expect(persistenceColor(0.01)[2]).toBeGreaterThan(
      persistenceColor(0.01)[0]!,
    );
  });
  it("expires exact source-time observations and removes their counts", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 4);
    for (let i = 0; i < 110; i++) h.accept(frame(i));
    expect(h.duration).toBeCloseTo(4);
    expect(h.count).toBe(101);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
    h.accept(frame(110, { sampleIndex: 10000 }));
    expect(h.count).toBe(1);
    expect(h.gaps).toBe(1);
    expect(h.duration).toBe(0);
  });
  it("rebuilds the histogram from retained levels on scale changes, including simultaneous expiry", () => {
    const h = new PersistenceHistory();
    for (let i = 0; i < 180; i++) h.accept(frame(i));
    h.configure(-120, 40, 4);
    expect(h.count).toBe(101);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
    h.configure(-70, 40, 16);
    expect(h.inspect(0.5, -90)).toBeUndefined();
    expect(h.observations[0]).toBe(101);
    h.configure(-120, 100, 16);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
  });
  it("clears history while keeping the latest owned trace and rejecting repeated frames", () => {
    const h = new PersistenceHistory(),
      f = frame(1);
    h.accept(f);
    f.bins.fill(5);
    expect(h.latest?.bins[0]).toBe(-90);
    h.clear();
    expect(h.count).toBe(0);
    expect(h.latest?.bins[0]).toBe(-90);
    expect(h.accept(f)).toBe(false);
    expect(h.inspect(0.5, -90)).toBeUndefined();
    h.accept(frame(2));
    expect(h.count).toBe(1);
  });
  it("excludes invalid columns from the denominator instead of treating missing data as noise", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 10);
    h.accept(frame(0));
    h.accept(frame(1, { bins: new Float32Array(4096).fill(NaN) }));
    expect(h.count).toBe(2);
    expect(h.observations[0]).toBe(1);
    expect(h.inspect(0, -90)?.fraction).toBe(1);
    expect(h.inspect(-0.1, -90)).toBeUndefined();
    expect(h.inspect(NaN, -90)).toBeUndefined();
  });
  it("rejects stale/duplicate/out-of-order/malformed data and resets incompatible contexts", () => {
    const h = new PersistenceHistory();
    h.accept(frame(3));
    for (const f of [
      frame(3),
      frame(2),
      frame(4, { sessionGeneration: 0 }),
      frame(4, { sampleIndex: NaN }),
      frame(4, { sampleRateHz: 0 }),
      frame(4, { bins: new Float32Array() }),
    ])
      expect(h.accept(f)).toBe(false);
    expect(h.count).toBe(1);
    for (const patch of [
      { sessionGeneration: 2 },
      { sampleRateHz: 2000 },
      { centerFrequencyHz: 101e6 },
      { bins: new Float32Array(2048).fill(-60) },
      { sampleIndex: 1 },
    ]) {
      const n = new PersistenceHistory();
      n.accept(frame(0));
      n.accept(frame(1));
      n.accept(frame(2, patch));
      expect(n.count).toBe(1);
    }
  });
  it("bounds fast sources without overflowing counts or silently claiming the full time window", () => {
    const h = new PersistenceHistory();
    h.configure(-100, 100, 16);
    const counts = h.counts,
      observations = h.observations;
    for (let i = 0; i < PERSISTENCE_CAPACITY + 50; i++)
      h.accept(frame(i, { sampleIndex: i + 1, hopSamples: 1 }));
    expect(h.count).toBe(PERSISTENCE_CAPACITY);
    expect(h.limited).toBe(true);
    expect(h.duration).toBeCloseTo((PERSISTENCE_CAPACITY - 1) / 1000);
    expect(h.inspect(0.5, -90)?.fraction).toBe(1);
    expect(h.counts).toBe(counts);
    expect(h.observations).toBe(observations);
    expect(h.observations[0]).toBe(PERSISTENCE_CAPACITY);
    expect(h.counts.reduce((sum, n) => sum + n, 0)).toBe(
      PERSISTENCE_COLUMNS * PERSISTENCE_CAPACITY,
    );
  });
  it("excludes declared dropped/missing intervals from the observed-spectrum population", () => {
    const h = new PersistenceHistory();
    h.accept(frame(0));
    h.accept(frame(1, { droppedFramesBefore: 12 }));
    h.accept(frame(2, { missingSamplesBefore: 4000 }));
    expect(h.gaps).toBe(2);
    expect(h.count).toBe(3);
    expect(h.observations[0]).toBe(3);
  });
});
