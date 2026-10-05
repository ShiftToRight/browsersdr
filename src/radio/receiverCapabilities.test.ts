import { describe, expect, it, vi } from "vitest";
import { ReceiverController, type ReceiverBackend } from "./receiverController";
import { DEFAULT_HACKRF_RX_SETTINGS, type HackrfRxSettings } from "./sourceCapabilities";
import { defaultModeSettings } from "./receiverConfig";
import type { SourceKind, SourceSessionMetadata } from "./types";

function metadata(source: SourceKind = "hackrf"): Omit<SourceSessionMetadata, "sessionGeneration"> {
  return { source, requestedSampleRateHz: 1_024_000, actualSampleRateHz: 1_024_000,
    hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_000_000,
    mode: "WBFM", channelBandwidthHz: 150_000, squelch: 0, gainDb: null,
    sampleFormat: "planar-f32-iq-normalized" };
}
function setup(source: SourceKind = "hackrf", overrides: Partial<ReceiverBackend> = {}) {
  const current = metadata(source);
  const backend = {
    start: vi.fn(async () => current), stop: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined), setVolume: vi.fn(),
    tune: vi.fn(async (frequency: number) => ({ ...current, selectedChannelFrequencyHz: frequency })),
    scanTune: vi.fn(async (frequency: number) => ({ ...current, hardwareCenterFrequencyHz: frequency, selectedChannelFrequencyHz: frequency })),
    configureMode: vi.fn(async () => current), setGain: vi.fn(async (gain: number | null) => gain),
    stopRecording: vi.fn(() => undefined),
    configureHardware: vi.fn(async (_settings: HackrfRxSettings, _generation: number) => current),
    ...overrides,
  } satisfies ReceiverBackend;
  const controller = new ReceiverController(() => backend);
  return { controller, backend, start: () => controller.start({ source, channelFrequencyHz: 100_000_000, volume: 0.5 }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("source-aware controller configuration", () => {
  it.each(["hackrf", "rtl-sdr", "replay"] as const)("rejects incompatible %s mode before stopping recording or changing generation", async (source) => {
    const { controller, backend, start } = setup(source); await start();
    const before = controller.getSnapshot();
    await controller.configureMode(defaultModeSettings("DAB"));
    expect(backend.configureMode).not.toHaveBeenCalled(); expect(backend.stopRecording).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "running", sessionGeneration: before.sessionGeneration, session: before.session });
    expect(controller.getSnapshot().message).toContain("2.048");
  });
  it("rejects invalid HackRF retunes and full scan windows without issuing commands", async () => {
    const { controller, backend, start } = setup(); await start();
    await controller.tune(6_000_000_001); await controller.tune(4_300_000_000.5);
    await controller.scanTune(100_000);
    expect(backend.tune).not.toHaveBeenCalled(); expect(backend.scanTune).not.toHaveBeenCalled();
    expect(backend.stopRecording).not.toHaveBeenCalled();
    await controller.tune(4_300_000_001);
    expect(backend.tune).toHaveBeenCalledWith(4_300_000_001, 2, { autoRecenter: true });
  });
  it("rejects invalid stages and the legacy scalar before ending the capture", async () => {
    const { controller, backend, start } = setup(); await start();
    await controller.setGain(null);
    await controller.configureHardware({ ...DEFAULT_HACKRF_RX_SETTINGS, rxVgaGainDb: 3 });
    expect(backend.setGain).not.toHaveBeenCalled(); expect(backend.configureHardware).not.toHaveBeenCalled();
    expect(backend.stopRecording).not.toHaveBeenCalled();
    expect(controller.getSnapshot().sessionGeneration).toBe(1);
  });
  it("ends recording and invalidates the generation before a hardware command, publishing only after acknowledgement", async () => {
    const pending = deferred<ReturnType<typeof metadata>>();
    const configure = vi.fn(() => pending.promise);
    const { controller, backend, start } = setup("hackrf", { configureHardware: configure }); await start();
    const changing = controller.configureHardware({ ...DEFAULT_HACKRF_RX_SETTINGS, rxVgaGainDb: 62 });
    expect(backend.stopRecording).toHaveBeenCalledWith("metadata-change");
    expect(vi.mocked(backend.stopRecording).mock.invocationCallOrder[0]).toBeLessThan(configure.mock.invocationCallOrder[0]!);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "tuning", sessionGeneration: 2 });
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ rxVgaGainDb: 62 }), 2);
    await controller.configureHardware(DEFAULT_HACKRF_RX_SETTINGS);
    expect(configure).toHaveBeenCalledTimes(1);
    pending.resolve(metadata()); await changing;
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "running", sessionGeneration: 2, session: { sessionGeneration: 2 } });
  });
  it("does not resurrect a session when settings acknowledge after disconnect", async () => {
    const pending = deferred<ReturnType<typeof metadata>>();
    const { controller, start } = setup("hackrf", { configureHardware: () => pending.promise }); await start();
    const changing = controller.configureHardware(DEFAULT_HACKRF_RX_SETTINGS);
    await controller.disconnect(); pending.resolve(metadata()); await changing;
    expect(controller.getSnapshot().lifecycle).toBe("idle");
  });
  it("closes after a rejected hardware command and retains failed cleanup ownership", async () => {
    const disconnect = vi.fn().mockRejectedValueOnce(new Error("Close failed")).mockResolvedValue(undefined);
    const { controller, start } = setup("hackrf", {
      configureHardware: async () => { throw new Error("Settings rejected"); }, disconnect,
    }); await start();
    await controller.configureHardware(DEFAULT_HACKRF_RX_SETTINGS);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "error", cleanupRequired: true });
    await controller.disconnect(); expect(disconnect).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().lifecycle).toBe("idle");
  });
  it("keeps a stopped connection stopped after a hardware setting acknowledgement", async () => {
    const { controller } = setup("hackrf", { connect: async () => metadata() });
    await controller.connect({ source: "hackrf", channelFrequencyHz: 100_000_000, volume: 0 });
    await controller.configureHardware(DEFAULT_HACKRF_RX_SETTINGS);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "connected", sessionGeneration: 2 });
  });
});
