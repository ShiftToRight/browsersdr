import { describe, expect, it, vi } from "vitest";
import {
  ReceiverController,
  type ReceiverBackend,
  type ReceiverBackendEvents,
  type ReceiverStartOptions,
} from "./receiverController";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";

const OPTIONS: ReceiverStartOptions = { channelFrequencyHz: 100_000_000, volume: 0.5 };
const METADATA = {
  source: "rtl-sdr" as const,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_000_000,
  mode: "WBFM" as const,
  channelBandwidthHz: 150_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeBackend(
  events: ReceiverBackendEvents,
  start: ReceiverBackend["start"],
  stopped: () => void,
): ReceiverBackend {
  let stopPromise: Promise<void> | undefined;
  return {
    start: async (options) => {
      events.permissionGranted();
      return start(options);
    },
    stop: () => {
      if (!stopPromise) {
        stopped();
        stopPromise = Promise.resolve();
      }
      return stopPromise;
    },
    setVolume: () => undefined,
    tune: async (channelFrequencyHz) => ({ ...METADATA, hardwareCenterFrequencyHz: channelFrequencyHz, selectedChannelFrequencyHz: channelFrequencyHz }),
    configureMode: async (settings) => ({ ...METADATA, mode: settings.mode, channelBandwidthHz: settings.bandwidthHz, squelch: settings.squelch }),
    setGain: async (gainDb) => gainDb,
  };
}

describe("ReceiverController", () => {
  it.each(["tune", "configureMode"] as const)("waits for failed %s cleanup before allowing restart", async (command) => {
    const closing = deferred<void>();
    let creations = 0;
    const controller = new ReceiverController((events) => {
      creations++;
      return {
        ...fakeBackend(events, async () => METADATA, () => undefined),
        stop: () => closing.promise,
        [command]: async () => { throw new Error("Rejected configuration"); },
      };
    });
    await controller.start(OPTIONS);
    const failed = command === "tune" ? controller.tune(200_000_000) : controller.configureMode({ mode: "AM", bandwidthHz: 8000, squelch: 0 });
    await vi.waitFor(() => expect(controller.getSnapshot().lifecycle).toBe("stopping"));
    await controller.start(OPTIONS);
    expect(creations).toBe(1);
    closing.resolve(); await failed;
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "error", cleanupRequired: false });
    await controller.start(OPTIONS);
    expect(creations).toBe(2);
    await controller.stop();
  });

  it("retains a backend whose close failed and allows only cleanup retry", async () => {
    let creations = 0, attempts = 0;
    const controller = new ReceiverController((events) => {
      creations++;
      return { ...fakeBackend(events, async () => METADATA, () => undefined), stop: async () => {
        if (++attempts === 1) throw new Error("Close failed");
      } };
    });
    await controller.start(OPTIONS); await controller.stop();
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "error", cleanupRequired: true });
    await controller.start(OPTIONS); expect(creations).toBe(1);
    await controller.stop(); expect(controller.getSnapshot().lifecycle).toBe("idle");
    await controller.start(OPTIONS); expect(creations).toBe(2);
    await controller.stop();
  });

  it("handles EOF during a tune without resurrecting the completed backend", async () => {
    let events!: ReceiverBackendEvents;
    let stops = 0;
    const tuning = deferred<typeof METADATA>();
    const controller = new ReceiverController((e) => {
      events = e;
      return { ...fakeBackend(e, async () => METADATA, () => { stops++; }), tune: () => tuning.promise };
    });
    await controller.start(OPTIONS);
    const pending = controller.tune(100_100_000);
    events.sourceEnded();
    await vi.waitFor(() => expect(controller.getSnapshot().lifecycle).toBe("idle"));
    tuning.resolve(METADATA); await pending;
    expect(stops).toBe(1);
    expect(controller.getSnapshot().message).toContain("end of file");
    expect(controller.getSnapshot().session).toMatchObject({
      selectedChannelFrequencyHz: 100_100_000,
      sessionGeneration: 2,
    });
  });

  it("rejects late telemetry from a replaced backend but accepts it after a mode change", async () => {
    const events: ReceiverBackendEvents[] = [];
    const controller = new ReceiverController((e) => {
      events.push(e); return fakeBackend(e, async () => METADATA, () => undefined);
    });
    await controller.start(OPTIONS); await controller.stop(); await controller.start(OPTIONS);
    await controller.configureMode({ mode: "AM", bandwidthHz: 8000, squelch: 0 });
    events[1]!.audioStateChanged("suspended");
    events[0]!.audioStateChanged("running");
    expect(controller.getSnapshot().audioState).toBe("suspended");
    await controller.stop();
  });
  it("reports permission cancellation and cleans up", async () => {
    let stops = 0;
    const error = Object.assign(new Error("No device was selected"), { name: "RadioError.NoDeviceSelected" });
    const controller = new ReceiverController((events) =>
      fakeBackend(events, () => Promise.reject(error), () => { stops += 1; }),
    );

    await controller.start(OPTIONS);

    expect(controller.getSnapshot().lifecycle).toBe("error");
    expect(controller.getSnapshot().message).toContain("cancelled");
    expect(stops).toBe(1);
  });

  it("coalesces rapid double starts", async () => {
    let creations = 0;
    const pending = deferred<typeof METADATA>();
    const controller = new ReceiverController((events) => {
      creations += 1;
      return fakeBackend(events, () => pending.promise, () => undefined);
    });

    const first = controller.start(OPTIONS);
    const second = controller.start(OPTIONS);
    pending.resolve(METADATA);
    await Promise.all([first, second]);

    expect(creations).toBe(1);
    expect(controller.getSnapshot().lifecycle).toBe("running");
  });

  it("cleans up after a failed start", async () => {
    let stops = 0;
    const controller = new ReceiverController((events) =>
      fakeBackend(events, () => Promise.reject(new Error("configuration failed")), () => { stops += 1; }),
    );

    await controller.start(OPTIONS);

    expect(stops).toBe(1);
    expect(controller.getSnapshot().lifecycle).toBe("error");
    expect(controller.getSnapshot().session).toBeUndefined();
  });

  it("does not publish a stale running state when stopped during start", async () => {
    let stops = 0;
    const pending = deferred<typeof METADATA>();
    const controller = new ReceiverController((events) =>
      fakeBackend(events, () => pending.promise, () => { stops += 1; }),
    );

    const starting = controller.start(OPTIONS);
    await controller.stop();
    pending.resolve(METADATA);
    await starting;

    expect(stops).toBe(1);
    expect(controller.getSnapshot().lifecycle).toBe("idle");
  });

  it("retunes the running backend with a new display generation", async () => {
    let tunedGeneration = 0;
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      tune: async (channelFrequencyHz, generation) => {
        tunedGeneration = generation;
        return { ...METADATA, hardwareCenterFrequencyHz: channelFrequencyHz, selectedChannelFrequencyHz: channelFrequencyHz };
      },
    }));
    await controller.start(OPTIONS);
    const initialGeneration = controller.getSnapshot().sessionGeneration;
    await controller.tune(101_300_000);
    expect(tunedGeneration).toBeGreaterThan(initialGeneration);
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: "running",
      sessionGeneration: tunedGeneration,
      session: { hardwareCenterFrequencyHz: 101_300_000, selectedChannelFrequencyHz: 101_300_000 },
    });
  });

  it("uses an explicit acquisition-center retune for spectrum scanning", async () => {
    const fixture = createDeterministicRecordingFixture(16);
    const scanCenters: number[] = [];
    const recordingStops: string[] = [];
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      scanTune: async (centerFrequencyHz) => {
        scanCenters.push(centerFrequencyHz);
        return { ...METADATA, hardwareCenterFrequencyHz: centerFrequencyHz, selectedChannelFrequencyHz: centerFrequencyHz };
      },
      stopRecording: (reason = "user") => {
        recordingStops.push(reason);
        return { ...fixture, metadata: { ...fixture.metadata, stopReason: reason } };
      },
    }));
    await controller.start(OPTIONS);
    const initialGeneration = controller.getSnapshot().sessionGeneration;
    const session = await controller.scanTune(102_400_000);
    expect(scanCenters).toEqual([102_400_000]);
    expect(recordingStops).toEqual(["metadata-change"]);
    expect(session).toMatchObject({
      hardwareCenterFrequencyHz: 102_400_000,
      selectedChannelFrequencyHz: 102_400_000,
      sessionGeneration: expect.any(Number),
    });
    expect(session!.sessionGeneration).toBeGreaterThan(initialGeneration);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "running", session });
  });

  it("publishes changed mode metadata and a serialized gain result", async () => {
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      configureMode: async (settings) => ({
        ...METADATA,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
        squelch: settings.squelch,
      }),
      setGain: async (gainDb) => gainDb,
    }));
    await controller.start(OPTIONS);
    await controller.configureMode({ mode: "AM", bandwidthHz: 8_000, squelch: 1.5 });
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: "running",
      session: { mode: "AM", channelBandwidthHz: 8_000, squelch: 1.5 },
    });
    await controller.setGain(24.7);
    expect(controller.getSnapshot().session?.gainDb).toBe(24.7);
  });

  it("completes ten start/stop cycles without duplicate backend cleanup", async () => {
    let creations = 0;
    let stops = 0;
    const controller = new ReceiverController((events) => {
      creations += 1;
      return fakeBackend(events, () => Promise.resolve(METADATA), () => { stops += 1; });
    });
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await controller.start(OPTIONS);
      expect(controller.getSnapshot().lifecycle).toBe("running");
      await controller.stop();
      expect(controller.getSnapshot().lifecycle).toBe("idle");
    }
    expect(creations).toBe(10);
    expect(stops).toBe(10);
  });

  it("stops and restarts a persistent RTL connection without reconnecting hardware", async () => {
    let creations = 0, connects = 0, starts = 0, stops = 0, disconnects = 0;
    const controller = new ReceiverController((events) => {
      creations += 1;
      return {
        ...fakeBackend(events, async () => { starts += 1; return METADATA; }, () => undefined),
        connect: async () => { connects += 1; events.permissionGranted(); return METADATA; },
        stop: async () => { stops += 1; },
        disconnect: async () => { disconnects += 1; },
      };
    });

    await controller.connect(OPTIONS);
    expect(controller.getSnapshot().lifecycle).toBe("connected");
    await controller.start(OPTIONS);
    await controller.stop();
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "connected", message: expect.stringContaining("remains connected") });
    await controller.start(OPTIONS);
    await controller.stop();
    await controller.disconnect();

    expect({ creations, connects, starts, stops, disconnects }).toEqual({ creations: 1, connects: 1, starts: 2, stops: 2, disconnects: 1 });
    expect(controller.getSnapshot().lifecycle).toBe("idle");
  });

  it("rejects a non-positive running retune without losing the active session", async () => {
    let tunes = 0;
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      tune: async () => { tunes += 1; return METADATA; },
    }));
    await controller.start(OPTIONS);
    await controller.tune(0);
    expect(tunes).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: "running",
      message: "Choose a channel frequency above 0 Hz; the connected tuner's limits are detected when tuning.",
      session: { selectedChannelFrequencyHz: 100_000_000 },
    });
  });

  it("ends and exposes the current recording segment before metadata changes", async () => {
    const fixture = createDeterministicRecordingFixture(32);
    const reasons: string[] = [];
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      startRecording: () => ({ state: "recording", bytes: 0, maxBytes: 1024, sampleCount: 0 }),
      stopRecording: (reason = "user") => {
        reasons.push(reason);
        return { ...fixture, metadata: { ...fixture.metadata, stopReason: reason } };
      },
    }));
    await controller.start(OPTIONS);
    expect(controller.startRecording()?.state).toBe("recording");
    await controller.tune(101_000_000);
    expect(reasons).toEqual(["metadata-change"]);
    expect(controller.takeCompletedRecording()?.metadata.stopReason).toBe("metadata-change");
  });

  it("finalizes a capacity-reached recording only once for automatic export", async () => {
    const fixture = createDeterministicRecordingFixture(32);
    let stops = 0;
    let recordingActive = true;
    const controller = new ReceiverController((events) => ({
      ...fakeBackend(events, () => Promise.resolve(METADATA), () => undefined),
      getRecordingStatus: () => recordingActive
        ? { state: "capacity-reached", bytes: 64, maxBytes: 64, sampleCount: 32 }
        : undefined,
      stopRecording: () => {
        stops += 1;
        recordingActive = false;
        return { ...fixture, metadata: { ...fixture.metadata, stopReason: "capacity" } };
      },
    }));
    await controller.start(OPTIONS);
    expect(controller.finalizeCapacityRecording()?.metadata.stopReason).toBe("capacity");
    expect(controller.finalizeCapacityRecording()).toBeUndefined();
    expect(controller.takeCompletedRecording()?.metadata.sampleCount).toBe(32);
    expect(stops).toBe(1);
  });
});
