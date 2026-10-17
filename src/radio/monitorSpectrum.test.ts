import { describe, expect, it } from "vitest";
import {
  MONITOR_SPECTRUM_POINT_BUDGET,
  updateMonitorSpectrum,
  type MonitorSpectrumUpdate,
  type MonitorSpectrumView,
} from "./monitorSpectrum";

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
  it("bounds all 256 window traces and preserves narrow peaks when decimating", () => {
    const points = Array.from({ length: 4096 }, (_, i) => ({
      frequencyHz: i,
      powerDb: i === 123 ? -10 : -100,
    }));
    let view: MonitorSpectrumView | undefined;
    for (let i = 0; i < 256; i++)
      view = updateMonitorSpectrum(
        view,
        { ...event, windowIndex: i, points },
        256,
      );
    expect(
      Object.values(view!.windows).reduce((n, w) => n + w.points.length, 0),
    ).toBeLessThanOrEqual(MONITOR_SPECTRUM_POINT_BUDGET);
    expect(view!.windows[0]!.points).toContainEqual({
      frequencyHz: 123,
      powerDb: -10,
    });
  });
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
