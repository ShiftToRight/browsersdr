import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CenterSignalAction } from "./centerSignal";
import { ReceiverController, type ReceiverBackend } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import type { RecordingStatus } from "./iqRecording";
import type { SignalCenterResult } from "../dsp/signalCenter";

const metadata: SourceSessionMetadata = {
  source: "replay",
  sessionGeneration: 1,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_120_000,
  mode: "NBFM",
  channelBandwidthHz: 12_500,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let controller: ReceiverController, action: CenterSignalAction;
let tune: ReturnType<
    typeof vi.fn<
      (
        frequencyHz: number,
        sessionGeneration: number,
      ) => Promise<SourceSessionMetadata>
    >
  >,
  accepted: ReturnType<typeof vi.fn<(frequencyHz: number) => void>>;
let measurement: ReturnType<typeof deferred<SignalCenterResult>>;
let recording: RecordingStatus | undefined;
let allowed: boolean;
let current: SourceSessionMetadata;
let tuning: ReturnType<typeof deferred<void>> | undefined;
let tuneError: boolean;
let analysis: {
  measureSignalCenter: ReturnType<
    typeof vi.fn<() => Promise<SignalCenterResult>>
  >;
  cancelSignalCenter: ReturnType<typeof vi.fn<() => void>>;
};
beforeEach(async () => {
  current = { ...metadata };
  allowed = true;
  recording = undefined;
  tuning = undefined;
  tuneError = false;
  measurement = deferred<SignalCenterResult>();
  accepted = vi.fn();
  tune = vi.fn(async (frequencyHz: number) => {
    await tuning?.promise;
    if (tuneError) throw new Error("Hardware refused correction");
    current = { ...current, selectedChannelFrequencyHz: frequencyHz };
    return current;
  });
  const backend: ReceiverBackend = {
    start: async () => current,
    stop: async () => undefined,
    setVolume: () => {},
    tune,
    configureMode: async (settings) =>
      (current = {
        ...current,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
      }),
    updateAnalogMode: (settings) =>
      (current = {
        ...current,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
      }),
    setGain: async () => null,
    getRecordingStatus: () => recording,
  };
  controller = new ReceiverController(() => backend);
  await controller.start({
    source: "replay",
    channelFrequencyHz: current.selectedChannelFrequencyHz,
    volume: 0.3,
  });
  analysis = {
    measureSignalCenter: vi.fn(() => measurement.promise),
    cancelSignalCenter: vi.fn(),
  };
  action = new CenterSignalAction(
    controller,
    analysis,
    () => allowed,
    accepted,
  );
  action.start();
  action.updateContext("initial", false);
});
afterEach(() => action.dispose());
const estimate: SignalCenterResult = {
  kind: "estimate",
  offsetHz: -1500,
  toleranceHz: 25,
  message: "OK",
};

describe("one-shot center action", () => {
  it("makes exactly one correction and restores the previous frequency once", async () => {
    const task = action.center();
    void action.center();
    expect(analysis.measureSignalCenter).toHaveBeenCalledTimes(1);
    measurement.resolve(estimate);
    await task;
    expect(tune).toHaveBeenCalledTimes(1);
    expect(tune).toHaveBeenCalledWith(100_118_500, expect.any(Number));
    expect(action.getSnapshot()).toMatchObject({
      measuring: false,
      undoAvailable: true,
    });
    await action.undoCorrection();
    await action.undoCorrection();
    expect(tune).toHaveBeenCalledTimes(2);
    expect(accepted.mock.calls).toEqual([[100_118_500], [100_120_000]]);
  });
  it("does not tune an already centered signal or no-signal result", async () => {
    const task = action.center();
    measurement.resolve({ ...estimate, offsetHz: 10 });
    await task;
    expect(tune).not.toHaveBeenCalled();
    expect(action.getSnapshot().message).toContain("Already centered");
    measurement = deferred();
    const second = action.center();
    measurement.resolve({
      kind: "no-signal",
      message: "No clear signal: noise.",
    });
    await second;
    expect(action.getSnapshot().message).toContain("No clear signal");
    expect(tune).not.toHaveBeenCalled();
  });
  it("guards recordings before click and before applying a result", async () => {
    recording = { state: "recording" } as RecordingStatus;
    await action.center();
    expect(analysis.measureSignalCenter).not.toHaveBeenCalled();
    recording = undefined;
    const task = action.center();
    recording = { state: "recording" } as RecordingStatus;
    measurement.resolve(estimate);
    await task;
    expect(tune).not.toHaveBeenCalled();
  });
  it("invalidates on a manual tune and same-generation bandwidth update", async () => {
    let task = action.center();
    await controller.tune(100_130_000);
    measurement.resolve(estimate);
    await task;
    expect(tune).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    measurement = deferred();
    task = action.center();
    controller.updateAnalogMode({
      mode: "NBFM",
      bandwidthHz: 20_000,
      squelch: 0,
    });
    measurement.resolve(estimate);
    await task;
    expect(tune).toHaveBeenCalledTimes(1);
  });
  it("invalidates on a pending frequency edit or a scan", async () => {
    const task = action.center();
    allowed = false;
    action.updateContext("edited", true);
    measurement.resolve(estimate);
    await task;
    expect(tune).not.toHaveBeenCalled();
    expect(analysis.cancelSignalCenter).toHaveBeenCalled();
  });
  it("does not overwrite a frequency edit during a pending hardware correction", async () => {
    tuning = deferred<void>();
    const task = action.center();
    measurement.resolve(estimate);
    await vi.waitFor(() => expect(tune).toHaveBeenCalledTimes(1));
    action.updateContext("edited", true);
    tuning.resolve();
    await task;
    expect(accepted).not.toHaveBeenCalled();
    expect(action.getSnapshot().undoAvailable).toBe(false);
  });
  it("invalidates Undo after another tune", async () => {
    const task = action.center();
    measurement.resolve(estimate);
    await task;
    await controller.tune(100_125_000);
    await action.undoCorrection();
    expect(tune).toHaveBeenCalledTimes(2);
    expect(action.getSnapshot().undoAvailable).toBe(false);
  });
  it("shows an actionable correction failure from the real controller", async () => {
    tuneError = true;
    const task = action.center();
    measurement.resolve(estimate);
    await task;
    expect(action.getSnapshot().message).toContain(
      "Hardware refused correction",
    );
    expect(accepted).not.toHaveBeenCalled();
  });
  it("shows measurement failures and rejects stale estimates", async () => {
    const task = action.center();
    measurement.resolve({
      kind: "failure",
      message: "No fresh samples; check reception.",
    });
    await task;
    expect(action.getSnapshot().message).toContain("No fresh samples");
    measurement = deferred();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const stale = action.center();
    now.mockReturnValue(3500);
    measurement.resolve(estimate);
    await stale;
    now.mockRestore();
    expect(tune).not.toHaveBeenCalled();
  });
  it("supports effect teardown and reactivation", async () => {
    action.dispose();
    action.start();
    const task = action.center();
    measurement.resolve(estimate);
    await task;
    expect(tune).toHaveBeenCalledTimes(1);
  });
});

it('clears an earlier edge warning after a manual retune',async()=>{
  const task=action.center();
  measurement.resolve({kind:'no-signal',message:'Signal near captured edge.'});
  await task;
  expect(action.getSnapshot().message).toContain('captured edge');
  await controller.tune(100_000_000);
  expect(action.getSnapshot().message).toBe('');
});
