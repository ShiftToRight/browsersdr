import { afterEach, expect, it, vi } from "vitest";
import {
  ReceiverController,
  type ReceiverBackend,
  type ReceiverBackendEvents,
} from "./receiverController";
import { runChannelWatch } from "./channelWatch";
import { runGainSetup } from "./gainSetup";
import { defaultModeSettings } from "./receiverConfig";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";

async function fixture() {
  let metadata: Omit<SourceSessionMetadata, "sessionGeneration"> = {
    source: "rtl-sdr",
    requestedSampleRateHz: 1_024_000,
    actualSampleRateHz: 1_024_000,
    hardwareCenterFrequencyHz: 100e6,
    selectedChannelFrequencyHz: 100e6,
    mode: "AM",
    channelBandwidthHz: 12000,
    squelch: 0,
    gainDb: 25,
    sampleFormat: "planar-f32-iq-normalized",
  };
  let events!: ReceiverBackendEvents;
  const backend: ReceiverBackend = {
    start: vi.fn(async () => metadata),
    stop: vi.fn(async () => undefined),
    setVolume: vi.fn(),
    setGain: vi.fn(async (gain) => {
      metadata = { ...metadata, gainDb: gain };
      return gain;
    }),
    configureMode: vi.fn(async (settings) => {
      metadata = {
        ...metadata,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
        squelch: settings.squelch,
      };
      return metadata;
    }),
    tune: vi.fn(async (frequency) => {
      metadata = {
        ...metadata,
        selectedChannelFrequencyHz: frequency,
        hardwareCenterFrequencyHz: frequency,
      };
      return metadata;
    }),
    scanTune: vi.fn(async (frequency) => {
      metadata = { ...metadata, hardwareCenterFrequencyHz: frequency };
      return metadata;
    }),
  };
  const controller = new ReceiverController((value) => {
    events = value;
    return backend;
  });
  await controller.start({
    source: "rtl-sdr",
    channelFrequencyHz: 100e6,
    sampleRateHz: 1_024_000,
    modeSettings: defaultModeSettings("AM"),
    volume: 0.4,
  });
  const subscribe = vi.fn((listener: (frame: SpectrumFrame) => void) => {
    const timer = setInterval(() => {
      const state = controller.getSnapshot();
      const bins = new Float32Array(1024).fill(-80);
      bins[512] = -40;
      listener({
        sessionGeneration: state.sessionGeneration,
        sequence: 1,
        timestampMs: 0,
        sampleIndex: 1024,
        centerFrequencyHz: state.session!.hardwareCenterFrequencyHz,
        sampleRateHz: 1_024_000,
        units: "relative-dB",
        bins,
        droppedFramesBefore: 0,
      });
    }, 50);
    return () => clearInterval(timer);
  });
  const pipeline = {
    subscribeMeasurements: subscribe,
  } as unknown as AnalysisPipeline;
  return { controller, backend, pipeline, events, subscribe };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function gainClock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    time: () => now,
    settle: async () => {
      now += 700;
    },
  };
}
const settings = {
  dwellMs: 250,
  holdMs: 0,
  thresholdDb: 12,
  cooldownMs: 1000,
  listen: true,
};
it("serializes channel visits, emits observed activity and restores the original center/mode only on owned cancellation", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    abort = new AbortController(),
    onEvent = vi.fn((_event: import("./channelWatch").WatchEvent) =>
      abort.abort(),
    );
  const result = runChannelWatch({
    ...f,
    channels: [
      {
        name: "Test",
        frequencyHz: 101e6,
        settings: defaultModeSettings("NBFM"),
      },
    ],
    settings,
    signal: abort.signal,
    volume: 0.4,
    onVisit: vi.fn(),
    onEvent,
  }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).name).toBe("AbortError");
  expect(onEvent).toHaveBeenCalledOnce();
  expect(onEvent.mock.calls[0]![0]).toMatchObject({
    kind: "new",
    frequencyHz: 101e6,
    aboveNoiseDb: 40,
  });
  expect(f.controller.getSnapshot().session).toMatchObject({
    mode: "AM",
    hardwareCenterFrequencyHz: 100e6,
    selectedChannelFrequencyHz: 100e6,
  });
  expect(f.backend.start).toHaveBeenCalledOnce();
  expect(f.backend.setVolume).toHaveBeenLastCalledWith(0.4);
});
it("does not restore or restart after external Stop changes ownership", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    abort = new AbortController();
  const result = runChannelWatch({
    ...f,
    channels: [
      {
        name: "Test",
        frequencyHz: 101e6,
        settings: defaultModeSettings("NBFM"),
      },
    ],
    settings,
    signal: abort.signal,
    volume: 0.4,
    onVisit: vi.fn(),
    onEvent: () => {
      void f.controller.stop();
    },
  }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).name).toBe("AbortError");
  expect(f.controller.getSnapshot().lifecycle).toBe("idle");
  expect(f.backend.start).toHaveBeenCalledOnce();
  expect(f.backend.scanTune).not.toHaveBeenCalled();
});
it("does not treat missing spectrum coverage as inactivity or emit a fabricated event", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    abort = new AbortController(),
    onEvent = vi.fn(),
    visit = vi.fn();
  const pipeline = {
    subscribeMeasurements: () => () => undefined,
  } as unknown as AnalysisPipeline;
  const result = runChannelWatch({
    ...f,
    pipeline,
    channels: [
      {
        name: "No frames",
        frequencyHz: 101e6,
        settings: defaultModeSettings("NBFM"),
      },
    ],
    settings,
    signal: abort.signal,
    volume: 0.4,
    onVisit: visit,
    onEvent,
  }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(700);
  abort.abort();
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(onEvent).not.toHaveBeenCalled();
  expect(
    visit.mock.calls.some((call) =>
      String(call[0]).includes("no valid measured coverage"),
    ),
  ).toBe(true);
});
it("rejects invalid scheduling settings and an existing manual recording", async () => {
  const f = await fixture(),
    abort = new AbortController();
  const base = {
    ...f,
    channels: [
      {
        name: "Test",
        frequencyHz: 101e6,
        settings: defaultModeSettings("NBFM"),
      },
    ],
    signal: abort.signal,
    volume: 0.4,
    onVisit: vi.fn(),
    onEvent: vi.fn(),
  };
  await expect(
    runChannelWatch({ ...base, settings: { ...settings, holdMs: Infinity } }),
  ).rejects.toThrow(/Invalid watch/);
  vi.spyOn(f.controller, "getRecordingStatus").mockReturnValue({
    state: "recording",
  } as ReturnType<ReceiverController["getRecordingStatus"]>);
  await expect(runChannelWatch({ ...base, settings })).rejects.toThrow(
    /no active recording/,
  );
});
it("reduces measured clipping with bounded gain commands and leaves stable input alone", async () => {
  const f = await fixture(),
    abort = new AbortController();
  const clock = gainClock();
  let count = 0;
  const level = () => ({
    rmsDb: -20,
    peakDb: ++count < 3 ? 0 : -10,
    dc: 0,
    clippedFraction: 0,
    sampledComponents: 2048,
    observedAtMs: clock.time(),
  });
  await runGainSetup(f.controller, level, abort.signal, vi.fn(), clock.settle);
  expect(f.backend.setGain).toHaveBeenNthCalledWith(1, 21);
  expect(f.backend.setGain).toHaveBeenNthCalledWith(2, 17);
  expect(f.backend.setGain).toHaveBeenCalledTimes(2);
});
it("cancels gain setup on a manual setting change and never continues after Stop", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    level = () => ({
      rmsDb: -50,
      peakDb: -30,
      dc: 0,
      clippedFraction: 0,
      sampledComponents: 2048,
      observedAtMs: 0,
    });
  await expect(
    runGainSetup(f.controller, level, abort.signal, vi.fn(), async () => {
      await f.controller.setGain(35);
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.backend.setGain).toHaveBeenCalledOnce();
  await expect(
    runGainSetup(f.controller, level, abort.signal, vi.fn(), async () => {
      await f.controller.stop();
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.backend.setGain).toHaveBeenCalledOnce();
});

it("does not overwrite a newer tune completed during restoration", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    abort = new AbortController();
  const configure = f.controller.configureMode.bind(f.controller);
  vi.spyOn(f.controller, "configureMode").mockImplementation(async (mode) => {
    await configure(mode);
    if (mode.mode === "AM") await f.controller.tune(102e6);
  });
  const result = runChannelWatch({
    ...f,
    channels: [
      {
        name: "Test",
        frequencyHz: 101e6,
        settings: defaultModeSettings("NBFM"),
      },
    ],
    settings,
    signal: abort.signal,
    volume: 0.4,
    onVisit: vi.fn(),
    onEvent: () => abort.abort(),
  }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(f.controller.getSnapshot().session?.selectedChannelFrequencyHz).toBe(
    102e6,
  );
  expect(f.backend.scanTune).not.toHaveBeenCalled();
});

it("does not adopt a manual gain change that completes while a setup command is pending", async () => {
  const f = await fixture(),
    abort = new AbortController();
  const clock = gainClock();
  const setGain = f.controller.setGain.bind(f.controller);
  vi.spyOn(f.controller, "setGain").mockImplementation(async (gain) => {
    await setGain(gain);
    await setGain(40);
  });
  await expect(
    runGainSetup(
      f.controller,
      () => ({
        rmsDb: -50,
        peakDb: -40,
        dc: 0,
        clippedFraction: 0,
        sampledComponents: 2048,
        observedAtMs: clock.time(),
      }),
      abort.signal,
      vi.fn(),
      clock.settle,
    ),
  ).rejects.toThrow(/not retained/);
  expect(f.backend.setGain).toHaveBeenCalledTimes(2);
  expect(f.controller.getSnapshot().session?.gainDb).toBe(40);
});

it("rejects input measured before gain settling instead of adjusting from stale samples", async () => {
  const f = await fixture(),
    clock = gainClock();
  await expect(
    runGainSetup(
      f.controller,
      () => ({
        rmsDb: -50,
        peakDb: -40,
        dc: 0,
        clippedFraction: 0,
        sampledComponents: 2048,
        observedAtMs: 0,
      }),
      new AbortController().signal,
      vi.fn(),
      clock.settle,
    ),
  ).rejects.toThrow(/fresh settled/);
  expect(f.backend.setGain).not.toHaveBeenCalled();
});
