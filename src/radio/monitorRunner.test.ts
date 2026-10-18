import { describe, expect, it, vi } from "vitest";
import {
  createMonitorSession,
  monitorContext,
  validateMonitorSession,
} from "./signalMonitor";
import { runMonitor } from "./monitorRunner";
import type { MonitorSpectrumUpdate } from "./monitorSpectrum";
import type { ReceiverSnapshot } from "./receiverController";
import type { SurveyProfile } from "./fieldSurvey";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import type { collectSpectrumMeasurement } from "./spectrumScan";
const receiver: SourceSessionMetadata = {
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
const profile: SurveyProfile = {
  version: 1,
  name: "Monitor",
  site: { label: "Test" },
  bands: [
    {
      id: "test",
      name: "Test",
      startFrequencyHz: 99_700_000,
      endFrequencyHz: 100_300_000,
      dwellMs: 150,
      thresholdDb: 6,
      detector: "max-hold",
      captureSeconds: 5,
    },
  ],
};
function setup(bandProfile = profile) {
  let snapshot: ReceiverSnapshot = {
    lifecycle: "running",
    message: "Running",
    sessionGeneration: 1,
    session: { ...receiver },
  };
  const abort = new AbortController();
  const controller = {
    getSnapshot: () => snapshot,
    scanTune: vi.fn(async (hz: number) => {
      const metadata = {
        ...snapshot.session!,
        hardwareCenterFrequencyHz: hz,
        selectedChannelFrequencyHz: hz,
        sessionGeneration: snapshot.sessionGeneration + 1,
      };
      snapshot = {
        ...snapshot,
        session: metadata,
        sessionGeneration: metadata.sessionGeneration,
      };
      return metadata;
    }),
    tune: vi.fn(async (hz: number) => {
      snapshot = {
        ...snapshot,
        session: { ...snapshot.session!, selectedChannelFrequencyHz: hz },
      };
    }),
    stop: vi.fn(async () => {
      snapshot = { ...snapshot, lifecycle: "connected" };
    }),
    setVolume: vi.fn(),
  };
  const measure: typeof collectSpectrumMeasurement = vi.fn(
    async (_pipeline, options) => {
      const bins = new Float32Array(4096).fill(-90);
      bins[2088] = -40;
      const frame: SpectrumFrame = {
        sequence: 1,
        sessionGeneration: options.generation,
        timestampMs: 0,
        sampleIndex: 163_840,
        centerFrequencyHz: options.centerFrequencyHz,
        sampleRateHz: options.sampleRateHz,
        units: "relative-dB",
        bins,
        droppedFramesBefore: 0,
      };
      return {
        frames: [frame],
        targetSamples: 153_600,
        sourceSamples: 153_600,
        missingSamples: 0,
        coverage: 1,
        status: "complete" as const,
      };
    },
  );
  const session = createMonitorSession(bandProfile, receiver);
  const onUpdate = vi.fn();
  const options = {
    controller,
    pipeline: { subscribeMeasurements: () => () => {} },
    startReception: vi.fn(async () => snapshot),
    volume: 0.4,
    onUpdate,
    signal: abort.signal,
    measure,
    wait: vi.fn(async () => {}),
  };
  return {
    controller,
    abort,
    measure,
    session,
    options,
    setSnapshot: (s: ReceiverSnapshot) => {
      snapshot = s;
    },
  };
}
describe("monitor receiver lifecycle", () => {
  it("repeatedly measures a fixed center without retuning and restores audio on Pause", async () => {
    const x = setup();
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 3) x.abort.abort();
    });
    const final = await runMonitor(x.session, x.options);
    expect(final.status).toBe("paused");
    expect(final.sweeps).toBe(3);
    expect(final.signals).toHaveLength(1);
    expect(final.signals[0]!.detections).toBe(3);
    expect(x.controller.scanTune).not.toHaveBeenCalled();
    expect(x.controller.tune).toHaveBeenCalledWith(100_000_000);
    expect(x.controller.setVolume).toHaveBeenLastCalledWith(0.4);
  });
  it("sweeps every region in order and restores the original center and channel", async () => {
    const x = setup({
      ...profile,
      bands: [{ ...profile.bands[0]!, endFrequencyHz: 101_700_000 }],
    });
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 2) x.abort.abort();
    });
    const final = await runMonitor(x.session, x.options);
    expect(final.sweeps).toBe(2);
    expect(final.windows.every((w) => w.visits === 2)).toBe(true);
    expect(
      x.controller.scanTune.mock.calls.slice(0, 3).map((call) => call[0]),
    ).toEqual(x.session.windows.map((w) => w.plan.centerFrequencyHz));
    expect(x.controller.getSnapshot().session).toMatchObject({
      hardwareCenterFrequencyHz: 100_000_000,
      selectedChannelFrequencyHz: 100_000_000,
    });
  });
  it("ends a sweep without valid samples and retains failed coverage without signals", async () => {
    const x = setup();
    vi.mocked(x.measure).mockRejectedValue(new Error("No sample frames"));
    const final = await runMonitor(x.session, x.options);
    expect(final.status).toBe("failed");
    expect(final.windows[0]).toMatchObject({ status: "failed", validMs: 0 });
    expect(final.signals).toHaveLength(0);
    expect(x.measure).toHaveBeenCalledTimes(1);
  });
  it("never restores or starts an externally replaced source", async () => {
    const x = setup();
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 1)
        x.setSnapshot({
          lifecycle: "idle",
          message: "Stopped externally",
          sessionGeneration: 99,
        });
    });
    const final = await runMonitor(x.session, x.options);
    expect(final.status).toBe("failed");
    expect(x.controller.tune).not.toHaveBeenCalled();
    expect(x.options.startReception).not.toHaveBeenCalled();
  });
  it("checks settings before starting and does not treat a changed gain as comparable", async () => {
    const x = setup();
    x.setSnapshot({
      lifecycle: "connected",
      message: "Changed",
      sessionGeneration: 1,
      session: { ...receiver, gainDb: 10 },
    });
    const final = await runMonitor(x.session, x.options);
    expect(final.status).toBe("failed");
    expect(x.options.startReception).not.toHaveBeenCalled();
    expect(x.measure).not.toHaveBeenCalled();
  });
  it("returns a receiver originally in standby to standby after cancellation", async () => {
    const x = setup();
    x.setSnapshot({ ...x.controller.getSnapshot(), lifecycle: "connected" });
    x.options.startReception.mockImplementation(async () => {
      const next = {
        ...x.controller.getSnapshot(),
        lifecycle: "running" as const,
      };
      x.setSnapshot(next);
      return next;
    });
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 1) x.abort.abort();
    });
    const final = await runMonitor(x.session, x.options);
    expect(final.status).toBe("paused");
    expect(x.controller.stop).toHaveBeenCalledTimes(1);
  });
  it("does not turn a suspension delay into a completed observation", async () => {
    const x = setup();
    let n = 0;
    const final = await runMonitor(x.session, {
      ...x.options,
      now: () => (n++ === 0 ? 0 : 20_000),
    });
    expect(final.status).toBe("interrupted");
    expect(final.signals).toHaveLength(0);
    expect(final.windows[0]!.visits).toBe(0);
  });
  it("excludes scan centers but retains gain changes in hardware comparison", () => {
    const a = {
      ...receiver,
      bladerf: {
        identity: { serial: "fixture" },
        acceptedSampleRateHz: 2_400_000,
        acceptedBandwidthHz: 2_000_000,
        requestedCenterFrequencyHz: 100e6,
        acceptedCenterFrequencyHz: 100e6,
        gainMode: "manual",
        requestedGainDb: 10,
      },
    } as unknown as SourceSessionMetadata;
    const b = structuredClone(a);
    b.bladerf!.acceptedCenterFrequencyHz = 101e6;
    b.bladerf!.requestedCenterFrequencyHz = 101e6;
    expect(monitorContext(profile, a)).toBe(monitorContext(profile, b));
    b.bladerf!.requestedGainDb = 20;
    expect(monitorContext(profile, a)).not.toBe(monitorContext(profile, b));
  });
  it("runs and checkpoints the versioned region detector with its original acquisition context", async () => {
    const x = setup();
    const initial = createMonitorSession(
      profile,
      receiver,
      undefined,
      undefined,
      { version: 1, preset: "general" },
    );
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 2) x.abort.abort();
    });
    const final = await runMonitor(initial, x.options);
    expect(final.status).toBe("paused");
    expect(final.version).toBe(3);
    expect(final.signals).toHaveLength(1);
    expect(final.signals[0]!.confirmed).toBe(true);
    expect(validateMonitorSession(final)).toEqual(final);
  });
});

describe("monitor spectrum display events", () => {
  it("retains valid coverage from before a mid-grid pause when the remaining visits fail", async () => {
    const p = {
      ...profile,
      bands: [
        {
          ...profile.bands[0]!,
          startFrequencyHz: 100_000_000,
          endFrequencyHz: 101_536_000,
        },
      ],
    };
    const x = setup(p);
    const initial = createMonitorSession(p, receiver, undefined, undefined, {
      version: 2,
      preset: "general",
    });
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 1 && s.nextWindow === 3) x.abort.abort();
    });
    const paused = await runMonitor(initial, x.options);
    const resumeAbort = new AbortController();
    let remaining = 0;
    const final = await runMonitor(validateMonitorSession(paused), {
      ...x.options,
      signal: resumeAbort.signal,
      onUpdate: () => {},
      measure: async () => {
        if (++remaining === 3) resumeAbort.abort();
        throw new Error("Remaining visits failed");
      },
    });
    expect(remaining).toBe(3);
    expect(final.sweeps).toBe(2);
    expect(final.status).toBe("paused");
    expect(final.windows[2]!.status).toBe("complete");
  });
  it("alternates complete grids, pauses inside the shifted grid and resumes the same history and cursor", async () => {
    const p = {
      ...profile,
      bands: [
        {
          ...profile.bands[0]!,
          startFrequencyHz: 100_000_000,
          endFrequencyHz: 101_536_000,
        },
      ],
    };
    const x = setup(p);
    const initial = createMonitorSession(p, receiver, undefined, undefined, {
      version: 2,
      preset: "general",
    });
    vi.mocked(x.measure).mockImplementation(async (_pipeline, options) => {
      const bins = new Float32Array(4096).fill(-100);
      for (let i = 0; i < bins.length; i++) {
        const hz = options.centerFrequencyHz + (i - 2048) * 250;
        if (hz >= 100_748_000 && hz <= 100_788_000) bins[i] = -40;
      }
      return {
        frames: [
          {
            bins,
            centerFrequencyHz: options.centerFrequencyHz,
            sampleRateHz: options.sampleRateHz,
          } as SpectrumFrame,
        ],
        targetSamples: 153600,
        sourceSamples: 153600,
        missingSamples: 0,
        coverage: 1,
        status: "complete",
      };
    });
    const events: MonitorSpectrumUpdate[] = [];
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 1 && s.nextWindow === 3) x.abort.abort();
    });
    const paused = await runMonitor(initial, {
      ...x.options,
      onSpectrum: (e) => events.push(e),
    });
    expect(paused.status).toBe("paused");
    expect(paused.sweeps).toBe(1);
    expect(paused.nextWindow).toBe(3);
    expect(validateMonitorSession(paused)).toEqual(paused);
    const id = paused.signals[0]!.id;
    const resumeAbort = new AbortController();
    const final = await runMonitor(
      validateMonitorSession(JSON.parse(JSON.stringify(paused))),
      {
        ...x.options,
        signal: resumeAbort.signal,
        onUpdate: (s) => {
          if (s.sweeps === 2) resumeAbort.abort();
        },
        onSpectrum: (e) => events.push(e),
      },
    );
    expect(final.status).toBe("paused");
    expect(final.sweeps).toBe(2);
    expect(final.nextWindow).toBe(0);
    expect(final.id).toBe(initial.id);
    expect(final.signals).toHaveLength(1);
    expect(final.signals[0]!.id).toBe(id);
    expect(final.signals[0]!.detections).toBe(3);
    expect(
      events
        .filter((e) => e.phase === "complete")
        .map((e) => [e.sweep, e.windowIndex]),
    ).toEqual([
      [1, 0],
      [1, 1],
      [2, 2],
      [2, 3],
      [2, 4],
    ]);
    expect(final.windows.every((w) => w.visits === 1)).toBe(true);
    expect(x.controller.getSnapshot().session!.hardwareCenterFrequencyHz).toBe(
      receiver.hardwareCenterFrequencyHz,
    );
    expect(validateMonitorSession(final)).toEqual(final);
  });
  it("stops when the shifted sweep has no valid coverage even after a successful original sweep", async () => {
    const p = {
      ...profile,
      bands: [{ ...profile.bands[0]!, endFrequencyHz: 101_236_000 }],
    };
    const x = setup(p);
    const initial = createMonitorSession(p, receiver, undefined, undefined, {
      version: 2,
      preset: "general",
    });
    const measure = x.measure;
    let calls = 0;
    const final = await runMonitor(initial, {
      ...x.options,
      measure: async (...args) => {
        if (++calls > 2) throw new Error("Shifted sweep failed");
        return measure(...args);
      },
    });
    expect(final.status).toBe("failed");
    expect(final.sweeps).toBe(2);
    expect(calls).toBe(5);
    expect(final.message).toContain(
      "No monitoring window had valid sample coverage in this sweep",
    );
  });
  it("follows the current window rather than the next visit and clears active acquisition before cleanup", async () => {
    const x = setup({
      ...profile,
      bands: [{ ...profile.bands[0]!, endFrequencyHz: 101_700_000 }],
    });
    const events: MonitorSpectrumUpdate[] = [];
    x.options.onUpdate.mockImplementation((s) => {
      if (s.sweeps === 1) x.abort.abort();
    });
    x.controller.tune.mockImplementation(async () => {
      expect(events.at(-1)!.phase).toBe("idle");
    });
    const final = await runMonitor(x.session, {
      ...x.options,
      onSpectrum: (e) => events.push(e),
    });
    expect(final.nextWindow).toBe(0);
    expect(
      events.filter((e) => e.phase === "measuring").map((e) => e.windowIndex),
    ).toEqual(x.session.windows.map((_, i) => i));
    const complete = events.filter((e) => e.phase === "complete");
    expect(complete).toHaveLength(x.session.windows.length);
    expect(
      complete.every(
        (e) => e.points!.length > 0 && e.points!.some((p) => p.powerDb > -80),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      phase: "idle",
      windowIndex: x.session.windows.length - 1,
      sweep: 1,
    });
  });
  it("publishes no trace from failed, cancelled or suspended acquisition", async () => {
    for (const condition of ["failed", "cancelled", "suspended"]) {
      const x = setup();
      const original = x.measure;
      let time = 0;
      const events: MonitorSpectrumUpdate[] = [];
      const measure: typeof collectSpectrumMeasurement = async (...args) => {
        if (condition === "failed") throw new Error("No frames");
        const measurement = await original(...args);
        if (condition === "cancelled") x.abort.abort();
        if (condition === "suspended") time = 20_000;
        return measurement;
      };
      await runMonitor(x.session, {
        ...x.options,
        measure,
        now: () => time,
        onSpectrum: (e) => events.push(e),
      });
      expect(events.some((e) => e.phase === "complete" || e.points)).toBe(
        false,
      );
      expect(events.at(-1)!.phase).toBe("idle");
      expect(events.some((e) => e.phase === "failed")).toBe(
        condition === "failed",
      );
    }
  });
});
