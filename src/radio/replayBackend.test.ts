import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayBackend } from "./replayBackend";
import { ReceiverController, type ReceiverBackendEvents } from "./receiverController";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { SpectrumAccumulator } from "../dsp/spectrumMath";

class TestAudioContext extends EventTarget {
  static instances: TestAudioContext[] = [];
  state: AudioContextState = "running";
  sampleRate = 48_000;
  destination = {};
  constructor() { super(); TestAudioContext.instances.push(this); }
  get currentTime() { return performance.now() / 1000; }
  async resume() {}
  async close() { this.state = "closed"; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
}

beforeEach(() => {
  TestAudioContext.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("AudioBuffer", class {
    length: number;
    constructor(options: { length: number }) { this.length = options.length; }
    copyToChannel() {}
  });
  vi.stubGlobal("AudioBufferSourceNode", class { connect() {} start() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(sampleCount = 24_000) {
  const recording = createDeterministicRecordingFixture(sampleCount);
  const samples: SampleBlock[] = [];
  const analysis = {
    begin: vi.fn(() => ({ setSampleRate() {}, receiveSamples: (block: SampleBlock) => samples.push({ ...block, I: block.I.slice(), Q: block.Q.slice() }) })),
    retune: vi.fn(), stop: vi.fn(), markDiscontinuity: vi.fn(),
  };
  const events: ReceiverBackendEvents = {
    permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(), sourceEnded: vi.fn(), rdsChanged: vi.fn(),
  };
  const backend = new ReplayBackend(events, analysis as unknown as AnalysisPipeline, recording, 1);
  const options = { source: "replay" as const, channelFrequencyHz: recording.metadata.selectedChannelFrequencyHz, volume: 0 };
  return { recording, samples, analysis, events, backend, options };
}

describe("real replay backend integration", () => {
  it("starts, performs a no-op and in-span tune, preserves raw RF bins, then stops", async () => {
    const { backend, options, samples, analysis } = setup();
    await backend.start(options);
    await backend.tune(10_006_000, 2);
    await backend.tune(10_007_000, 3);
    await vi.advanceTimersByTimeAsync(1);
    const block = samples[0]!;
    const bins = new SpectrumAccumulator(4096, 1).addWindow(block.I.subarray(0, 4096), block.Q.subarray(0, 4096))!;
    expect((bins.indexOf(Math.max(...bins)) - 2048) * 48_000 / 4096).toBe(6000);
    await backend.stop();
    expect(analysis.stop).toHaveBeenLastCalledWith(3);
    expect(TestAudioContext.instances[0]!.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates mode changes before mutation and rejects capture-edge tunes", async () => {
    const { backend, options, analysis } = setup();
    await backend.start(options);
    await expect(backend.configureMode({ mode: "WBFM", bandwidthHz: 150000, squelch: 0 }, 2)).rejects.toThrow(/bandwidth/);
    const unchanged = await backend.tune(10_006_000, 3);
    expect(unchanged.mode).toBe("AM");
    expect(unchanged.channelBandwidthHz).toBe(15000);
    await expect(backend.tune(11_000_000, 4)).rejects.toThrow(/capture span/);
    await backend.stop();
    expect(analysis.stop).toHaveBeenLastCalledWith(3);
  });

  it("preserves known gap time, same-position gaps and EOF gaps without repeating samples", async () => {
    const { backend, options, recording, samples, analysis, events } = setup();
    recording.metadata.knownGaps = [
      { afterSample: 8192, missingSamples: 4800, reason: "100 ms" },
      { afterSample: 8192, missingSamples: null, reason: "unknown" },
      { afterSample: 24000, missingSamples: 4800, reason: "100 ms tail" },
    ];
    await backend.start(options);
    await vi.advanceTimersByTimeAsync(200);
    expect(samples).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(events.sourceEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(events.sourceEnded).toHaveBeenCalledOnce();
    expect(samples.reduce((sum, block) => sum + block.I.length, 0)).toBe(24000);
    expect(analysis.markDiscontinuity.mock.calls).toEqual([[4800], [0], [4800]]);
    await backend.stop();
  });

  it("reports asynchronous sample-processing errors to the controller and closes audio", async () => {
    const { recording, analysis, options } = setup();
    // Remove the unused setup backend's audio context from this case.
    await TestAudioContext.instances[0]!.close();
    analysis.begin.mockImplementation(() => ({ setSampleRate() {}, receiveSamples() { throw new Error("DSP failed"); } }));
    const controller = new ReceiverController((events, _options, generation) => new ReplayBackend(events, analysis as unknown as AnalysisPipeline, recording, generation));
    await controller.start(options);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "error", cleanupRequired: false });
    expect(controller.getSnapshot().message).toContain("DSP failed");
    expect(TestAudioContext.instances.every((context) => context.state === "closed")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
