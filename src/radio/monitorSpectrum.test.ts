import { describe, expect, it } from "vitest";
import {
  MONITOR_SPECTRUM_POINT_BUDGET,
  updateMonitorSpectrum,
  monitorSpectrumCoverage,
  type MonitorSpectrumUpdate,
  type MonitorSpectrumView,
} from "./monitorSpectrum";
import { createMonitorSession } from "./signalMonitor";
import { monitorSweepIndices } from "./monitorSchedule";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

const event: MonitorSpectrumUpdate = {
  sessionId: "a",
  windowIndex: 0,
  sweep: 1,
  at: 1000,
  phase: "complete",
  points: [
    { frequencyHz: 100, powerDb: -80 },
    { frequencyHz: 101, powerDb: -30 },
  ],
};
describe("bounded monitor spectrum presentation", () => {
  it("reports full range coverage after the original grid, without requiring the alternate grid slots", () => {
    const session = createMonitorSession(
      {
        version: 1,
        name: "Coverage",
        site: { label: "Generated" },
        bands: [
          {
            id: "band",
            name: "Band",
            startFrequencyHz: 100e6,
            endFrequencyHz: 102e6,
            dwellMs: 350,
            thresholdDb: 10,
            detector: "average",
            captureSeconds: 2,
          },
        ],
      },
      SYNTHETIC_DEMO_SESSION,
      undefined,
      undefined,
      { version: 2, preset: "general" },
    );
    const indices = monitorSweepIndices(session);
    expect(indices.length).toBeLessThan(session.windows.length);
    let view: MonitorSpectrumView | undefined;
    for (const index of indices)
      view = updateMonitorSpectrum(
        view,
        { ...event, sessionId: session.id, windowIndex: index },
        session.windows.length,
      );
    expect(monitorSpectrumCoverage(session, view)).toBeCloseTo(1);
    // Overlapping alternate-grid observations cannot double-count the range.
    view = updateMonitorSpectrum(
      view,
      {
        ...event,
        sessionId: session.id,
        windowIndex: session.windows.length - 1,
      },
      session.windows.length,
    );
    expect(monitorSpectrumCoverage(session, view)).toBeCloseTo(1);
    // A failed original window leaves a measurable gap; other windows stay retained.
    view = updateMonitorSpectrum(
      view,
      {
        ...event,
        sessionId: session.id,
        windowIndex: indices[0]!,
        phase: "failed",
      },
      session.windows.length,
    );
    expect(monitorSpectrumCoverage(session, view)).toBeGreaterThan(0);
    expect(monitorSpectrumCoverage(session, view)).toBeLessThan(1);
    expect(
      monitorSpectrumCoverage(session, { ...view, sessionId: "other" }),
    ).toBe(0);
    expect(monitorSpectrumCoverage(session)).toBe(0);
  });
  it("retains independent measured traces and ages across sequential visits without joining gaps", () => {
    let view = updateMonitorSpectrum(undefined, event, 2);
    view = updateMonitorSpectrum(
      view,
      {
        ...event,
        windowIndex: 1,
        at: 2000,
        points: [{ frequencyHz: 200, powerDb: -60 }],
      },
      2,
    );
    view = updateMonitorSpectrum(
      view,
      { ...event, sweep: 2, phase: "measuring", points: undefined },
      2,
    );
    expect(view.windows[0]!.at).toBe(1000);
    expect(view.windows[1]!.points[0]!.frequencyHz).toBe(200);
    expect(view.windows[0]!.sweep).toBe(1);
    expect(view.sweep).toBe(2);
    expect(view.phase).toBe("measuring");
  });
  it.each([256, 512])(
    "bounds all %i window traces and preserves narrow peaks when decimating",
    (count) => {
      const points = Array.from({ length: 4096 }, (_, i) => ({
        frequencyHz: i,
        powerDb: i === 123 ? -10 : -100,
      }));
      let view: MonitorSpectrumView | undefined;
      for (let i = 0; i < count; i++)
        view = updateMonitorSpectrum(
          view,
          { ...event, windowIndex: i, points },
          count,
        );
      expect(
        Object.values(view!.windows).reduce((n, w) => n + w.points.length, 0),
      ).toBeLessThanOrEqual(MONITOR_SPECTRUM_POINT_BUDGET);
      expect(view!.windows[0]!.points).toContainEqual({
        frequencyHz: 123,
        powerDb: -10,
      });
    },
  );
  it("copies scalar points, clears failed windows and starts clean for a different session", () => {
    const points = [{ frequencyHz: 100, powerDb: -80 }];
    let view = updateMonitorSpectrum(undefined, { ...event, points }, 1);
    points[0]!.powerDb = 0;
    expect(view.windows[0]!.points[0]!.powerDb).toBe(-80);
    view = updateMonitorSpectrum(
      view,
      { ...event, phase: "failed", points: undefined },
      1,
    );
    expect(view.windows[0]!.points).toEqual([]);
    view = updateMonitorSpectrum(
      view,
      { ...event, sessionId: "b", phase: "measuring", points: undefined },
      1,
    );
    expect(view.windows).toEqual({});
  });
  it("retains the last valid spectrum on pause without labelling it acquiring", () => {
    const view = updateMonitorSpectrum(
      updateMonitorSpectrum(undefined, event, 1),
      { ...event, phase: "idle", points: undefined },
      1,
    );
    expect(view.phase).toBe("idle");
    expect(view.windows[0]!.at).toBe(1000);
  });
});
