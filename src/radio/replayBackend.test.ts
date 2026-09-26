import { readFile } from "node:fs/promises";
import { WasmChannelFilter, type ChannelExports } from "./wasmChannel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayBackend } from "./replayBackend";
import { ReceiverController, type ReceiverBackendEvents } from "./receiverController";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { SpectrumAccumulator } from "../dsp/spectrumMath";
import { IqRecorder, SIGMF_CU8_NORMALIZATION, type IqRecording } from "./iqRecording";
import { defaultModeSettings } from "./receiverConfig";
import type { SourceSessionMetadata } from "./types";

class TestAudioContext extends EventTarget {
  static instances: TestAudioContext[] = [];
  state: AudioContextState = "running";
  static rate = 48_000;
  sampleRate = TestAudioContext.rate;
  destination = {};
  constructor() { super(); TestAudioContext.instances.push(this); }
  get currentTime() { return performance.now() / 1000; }
  async resume() {}
  async close() { this.state = "closed"; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
}

beforeEach(() => {
  TestAudioContext.instances = [];
  TestAudioContext.rate = 48_000;
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

function setupRecording(recording: IqRecording, compiledChannel?: (rate: number) => Promise<WasmChannelFilter>) {
  const samples: SampleBlock[] = [];
  const analysis = {
    begin: vi.fn(() => ({ setSampleRate() {}, receiveSamples: (block: SampleBlock) => samples.push({ ...block, I: block.I.slice(), Q: block.Q.slice() }) })),
    retune: vi.fn(), stop: vi.fn(), markDiscontinuity: vi.fn(),
  };
  const events: ReceiverBackendEvents = {
    permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(), sourceEnded: vi.fn(), rdsChanged: vi.fn(),
    dabChanged: vi.fn(), adsbChanged: vi.fn(), aisChanged: vi.fn(),
  };
  const backend = new ReplayBackend(events, analysis as unknown as AnalysisPipeline, recording, 1, compiledChannel ?? (async rate => {
    const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/pkg/spectrum_analysis.wasm", import.meta.url)), {});
    return new WasmChannelFilter(instance.exports as ChannelExports, rate);
  }));
  const options = { source: "replay" as const, channelFrequencyHz: recording.metadata.selectedChannelFrequencyHz, volume: 0 };
  return { recording, samples, analysis, events, backend, options };
}

function setup(sampleCount = 24_000) { return setupRecording(createDeterministicRecordingFixture(sampleCount)); }

function recordingAt(sampleRateHz: number, centerFrequencyHz: number, I: Float32Array, Q: Float32Array, selectedChannelFrequencyHz = centerFrequencyHz): IqRecording {
  const mode = defaultModeSettings("AM");
  const session: SourceSessionMetadata = {
    source: "synthetic", sessionGeneration: 1, requestedSampleRateHz: sampleRateHz, actualSampleRateHz: sampleRateHz,
    hardwareCenterFrequencyHz: centerFrequencyHz, selectedChannelFrequencyHz,
    mode: mode.mode, channelBandwidthHz: mode.bandwidthHz, squelch: mode.squelch, gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const recorder = new IqRecorder(session, "2026-09-23T00:00:00.000Z", I.length * 2 + 2, "Deterministic transition fixture; no hardware.");
  recorder.appendNormalized({ I, Q });
  return recorder.finish("user");
}

function aisPositionFrame(): Uint8Array {
  const bits = new Array<number>(168).fill(0);
  const write = (start: number, length: number, value: number) => {
    for (let bit = 0; bit < length; bit += 1) bits[start + bit] = (value >> (length - bit - 1)) & 1;
  };
  write(0, 6, 1); write(8, 30, 211_234_567); write(38, 4, 0); write(50, 10, 123);
  write(61, 28, Math.round(11.58 * 600_000)); write(89, 27, Math.round(48.14 * 600_000)); write(116, 12, 875); write(128, 9, 88);
  const payload = new Uint8Array(21);
  for (let bit = 0; bit < bits.length; bit += 1) payload[bit >> 3] = (payload[bit >> 3] ?? 0) | (bits[bit]! << (7 - (bit & 7)));
  let crc = 0xffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  crc ^= 0xffff;
  return Uint8Array.from([...payload, crc & 0xff, crc >> 8]);
}

function aisSignal(sampleRateHz: number, centerOffsetHz = 0): { I: Float32Array; Q: Float32Array } {
  const frame = aisPositionFrame(), flag = [0, 1, 1, 1, 1, 1, 1, 0], payloadBits: number[] = [];
  let ones = 0;
  for (const byte of frame) for (let bit = 0; bit < 8; bit += 1) {
    const value = (byte >> bit) & 1; payloadBits.push(value);
    if (value) { ones += 1; if (ones === 5) { payloadBits.push(0); ones = 0; } } else ones = 0;
  }
  const bits = [...Array.from({ length: 24 }, (_, index) => index & 1), ...flag, ...payloadBits, ...flag, 1, 1, 1];
  const samplesPerSymbol = sampleRateHz / 9_600;
  const I = new Float32Array(bits.length * samplesPerSymbol), Q = new Float32Array(I.length);
  let level = 1, phase = 0, position = 0;
  for (const bit of bits) {
    if (bit === 0) level ^= 1;
    const frequency = centerOffsetHz - 25_000 + (level ? 2_400 : -2_400);
    for (let sample = 0; sample < samplesPerSymbol; sample += 1) {
      phase += 2 * Math.PI * frequency / sampleRateHz;
      I[position] = Math.cos(phase); Q[position] = Math.sin(phase); position += 1;
    }
  }
  return { I, Q };
}

function dabTransitionSignal(): { I: Float32Array; Q: Float32Array } {
  // At 2.4 MS/s this deliberately long null is inside the receiver's tolerance;
  // it is outside the constructor-default 2.048 MS/s tolerance.
  const sections = [{ length: 24_000, amplitude: 0.7 }, { length: 4_200, amplitude: 0.01 }, { length: 3_500, amplitude: 0.7 }];
  const length = sections.reduce((sum, section) => sum + section.length, 0);
  const I = new Float32Array(length), Q = new Float32Array(length);
  let position = 0, phase = 0;
  for (const section of sections) for (let index = 0; index < section.length; index += 1) {
    I[position] = section.amplitude * Math.cos(phase); Q[position] = section.amplitude * Math.sin(phase);
    phase += 0.17; position += 1;
  }
  return { I, Q };
}

describe("real replay backend integration", () => {
  it("uses SigMF CU8 endpoint normalization while preserving legacy replay decoding", async () => {
    const sigmf = createDeterministicRecordingFixture(1);
    sigmf.data.set([0, 255]);
    sigmf.metadata.normalization = SIGMF_CU8_NORMALIZATION;
    const imported = setupRecording(sigmf);
    await imported.backend.start(imported.options);
    await vi.advanceTimersByTimeAsync(1);
    expect(imported.samples[0]?.I[0]).toBe(-1);
    expect(imported.samples[0]?.Q[0]).toBe(1);
    await imported.backend.stop();

    const legacy = createDeterministicRecordingFixture(1);
    legacy.data.set([0, 255]);
    const existing = setupRecording(legacy);
    await existing.backend.start(existing.options);
    await vi.advanceTimersByTimeAsync(1);
    expect(existing.samples[0]?.I[0]).toBeCloseTo(-0.995, 6);
    expect(existing.samples[0]?.Q[0]).toBeCloseTo(255 / 128 - 0.995, 6);
    await existing.backend.stop();
  });

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

  it("changes a persisted CW beat tone without moving the selected RF frequency", async () => {
    const fixture = createDeterministicRecordingFixture(8_192);
    fixture.metadata.mode = "CW";
    fixture.metadata.channelBandwidthHz = 500;
    fixture.metadata.squelch = 0;
    fixture.metadata.beatToneHz = 600;
    const { backend, options } = setupRecording(fixture);
    const started = await backend.start(options);
    const changed = await backend.configureMode({ mode: "CW", bandwidthHz: 250, squelch: 0, beatToneHz: 900 }, 2);
    expect(changed).toMatchObject({
      selectedChannelFrequencyHz: started.selectedChannelFrequencyHz,
      mode: "CW",
      channelBandwidthHz: 250,
      beatToneHz: 900,
    });
    await backend.stop();
  });

  it("configures every supported analog/digital route transition at the captured rate", async () => {
    const I = new Float32Array(32), Q = new Float32Array(32);
    const { backend, options } = setupRecording(recordingAt(2_400_000, 162_000_000, I, Q));
    await backend.start(options);

    expect((await backend.configureMode(defaultModeSettings("AIS"), 2)).mode).toBe("AIS");
    expect((await backend.configureMode(defaultModeSettings("DAB"), 3)).mode).toBe("DAB");
    expect((await backend.configureMode(defaultModeSettings("AM"), 4)).mode).toBe("AM");
    expect((await backend.configureMode(defaultModeSettings("DAB"), 5)).mode).toBe("DAB");
    expect((await backend.configureMode(defaultModeSettings("SRD"), 6)).mode).toBe("SRD");
    expect((await backend.configureMode(defaultModeSettings("AM"), 7)).mode).toBe("AM");
    await backend.stop();
  });

  it("attaches SRD at a nonzero selected-channel offset and preserves its settings", async () => {
    const { backend, options } = setupRecording(
      recordingAt(1_024_000, 433_920_000, new Float32Array(64), new Float32Array(64), 433_932_000),
    );
    await backend.start(options);
    const settings = defaultModeSettings("SRD");
    settings.srd = { ...settings.srd!, modulation: "2fsk", protocol: "fineoffset-wh51" };
    const configured = await backend.configureMode(settings, 2);
    expect(configured).toMatchObject({
      mode: "SRD",
      selectedChannelFrequencyHz: 433_932_000,
      srd: { modulation: "2fsk", protocol: "fineoffset-wh51" },
    });
    await backend.stop();
  });

  it("decodes AIS after an analog transition using the nondefault replay rate", async () => {
    const signal = aisSignal(192_000, 10_000);
    const { backend, options, events } = setupRecording(recordingAt(192_000, 162_000_000, signal.I, signal.Q, 162_010_000));
    await backend.start(options);
    await backend.configureMode(defaultModeSettings("AIS"), 2);
    await expect(backend.configureMode(defaultModeSettings("DAB"), 3)).rejects.toThrow(/2.048 MS\/s/);
    await vi.advanceTimersByTimeAsync(100);

    const updates = vi.mocked(events.aisChanged!).mock.calls.map(([snapshot]) => snapshot);
    expect(updates.at(-1)).toMatchObject({ validFrames: 1, targets: [{ mmsi: 211_234_567 }] });
    expect((await backend.tune(options.channelFrequencyHz, 4)).mode).toBe("AIS");
    await backend.stop();
  });

  it("propagates 2.4 MS/s through an analog-to-DAB attachment before its first samples", async () => {
    const signal = dabTransitionSignal();
    const { backend, options, events } = setupRecording(recordingAt(2_400_000, 220_352_000, signal.I, signal.Q));
    await backend.start(options);
    await backend.configureMode(defaultModeSettings("DAB"), 2);
    await vi.advanceTimersByTimeAsync(100);

    const updates = vi.mocked(events.dabChanged!).mock.calls.map(([snapshot]) => snapshot);
    expect(updates.at(-1)).toMatchObject({ state: "synchronized", nullSymbolCount: 1 });
    await backend.stop();
  });

  it("resets the active digital decoder at a replay discontinuity", async () => {
    const first = aisSignal(192_000), second = aisSignal(192_000);
    const I = new Float32Array(first.I.length + second.I.length), Q = new Float32Array(I.length);
    I.set(first.I); I.set(second.I, first.I.length); Q.set(first.Q); Q.set(second.Q, first.Q.length);
    const recording = recordingAt(192_000, 162_000_000, I, Q);
    recording.metadata.mode = "AIS";
    recording.metadata.channelBandwidthHz = defaultModeSettings("AIS").bandwidthHz;
    recording.metadata.knownGaps = [{ afterSample: first.I.length, missingSamples: null, reason: "fixture discontinuity" }];
    const { backend, options, events } = setupRecording(recording);
    await backend.start(options);
    await vi.advanceTimersByTimeAsync(150);

    const validCounts = vi.mocked(events.aisChanged!).mock.calls.map(([snapshot]) => snapshot.validFrames);
    const firstDecoded = validCounts.indexOf(1);
    const reset = validCounts.indexOf(0, firstDecoded + 1);
    const decodedAgain = validCounts.indexOf(1, reset + 1);
    expect(firstDecoded).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(firstDecoded);
    expect(decodedAgain).toBeGreaterThan(reset);
    await backend.stop();
  });

  it("rejects an unsupported transition without replacing the analog route", async () => {
    const { backend, options } = setup();
    await backend.start(options);
    await expect(backend.configureMode(defaultModeSettings("AIS"), 2)).rejects.toThrow(/192 ksample\/s/);
    const unchanged = await backend.tune(options.channelFrequencyHz, 3);
    expect(unchanged).toMatchObject({ mode: "AM", channelBandwidthHz: 15_000 });
    await backend.stop();
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

it.each([0x0109, 0x0110, 0x0113].flatMap(api => ([1_024_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000] as const).flatMap(rate => [48_000, 44_100].map(audioRate => ({ api, rate, audioRate })))))("replays and re-records native CI8 $api at $rate samples/s with $audioRate Hz audio", async ({ api, rate, audioRate }) => {
  TestAudioContext.rate = audioRate;
  const { hackrfRecordingFixture } = await import("../testing/hackrfRecordingFixture");
  const { decodeRecordingSamples, RECORDING_FORMAT } = await import("./iqRecording");
  const bytes = new Uint8Array(32_768);
  for (let n = 0; n < bytes.length; n++) bytes[n] = n % 256;
  const { recording } = await hackrfRecordingFixture(bytes, rate, api);
  recording.metadata.knownGaps = [{ afterSample: 100, missingSamples: 2400, reason: "known" }, { afterSample: 9000, missingSamples: null, reason: "unknown" }];
  const f = setupRecording(recording);
  await f.backend.start(f.options); f.backend.startRecording();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.events.runtimeError).not.toHaveBeenCalled(); expect(f.events.sourceEnded).toHaveBeenCalledOnce();
  expect(f.samples.every(block => block.I.length <= 8192)).toBe(true);
  const decoded = decodeRecordingSamples(recording.data, recording.metadata);
  expect(f.samples.flatMap(block => [...block.I])).toEqual([...decoded.I]); expect(f.samples.flatMap(block => [...block.Q])).toEqual([...decoded.Q]);
  const result = f.backend.stopRecording()!;
  expect(result.data).toEqual(bytes);
  expect(result.metadata).toMatchObject({ source: "replay", captureStartedAt: recording.metadata.captureStartedAt, nativeSampleRateHz: rate, effectiveSampleRateHz: rate >= 4_800_000 ? 2_400_000 : rate });
  if (result.metadata.format === RECORDING_FORMAT || recording.metadata.format === RECORDING_FORMAT) throw new Error("Expected CI8");
  expect(result.metadata.hardware).toEqual(recording.metadata.hardware); expect(result.metadata.captureSettings).toEqual(recording.metadata.captureSettings);
  expect(result.metadata.knownGaps.map(g => [g.afterSample, g.missingSamples])).toEqual([[100, 2400], [9000, null]]);
  expect(result.metadata.provenance).toContain("No new hardware observation");
  expect(f.analysis.markDiscontinuity).toHaveBeenCalledWith(0);
  await f.backend.stop();
});

it("keeps external CI8 origin unknown when re-recorded, and rejects invalid encodings before audio allocation", async () => {
  const { importSigmfRecording } = await import("./sigmfImport");
  const text = JSON.stringify({ global: { "core:version": "1.2.6", "core:datatype": "ci8", "core:sample_rate": 48_000, "core:hw": "HackRF Pro (untrusted description)" },
    captures: [{ "core:sample_start": 0, "core:frequency": 10_000_000, "core:datetime": "2020-01-01T00:00:00.000Z" }], annotations: [] });
  const recording = await importSigmfRecording(text, Uint8Array.of(128, 127, 0, 0), { modeSettings: defaultModeSettings("AM") });
  const f = setupRecording(recording); await f.backend.start(f.options); f.backend.startRecording();
  await vi.advanceTimersByTimeAsync(5);
  const result = f.backend.stopRecording()!;
  expect(result.metadata).toMatchObject({ source: "replay", provenanceDetails: { originalSource: "unknown", hardwareValidation: "pending" } });
  expect(result.metadata).not.toHaveProperty("hardware"); expect(result.importedSigmf?.metadataText).toBe(text);
  await f.backend.stop();
  const before = TestAudioContext.instances.length;
  expect(() => setupRecording({ ...recording, metadata: { ...recording.metadata, sampleEncoding: "ci16" } as unknown as IqRecording["metadata"] })).toThrow();
  expect(TestAudioContext.instances).toHaveLength(before);
});

it("releases a compiled replay filter when stop wins asynchronous initialization", async () => {
  const { hackrfRecordingFixture } = await import("../testing/hackrfRecordingFixture");
  const { recording } = await hackrfRecordingFixture(new Uint8Array(4096), 19_200_000, 0x0110);
  let resolve!: (filter: WasmChannelFilter) => void;
  const pending = new Promise<WasmChannelFilter>(done => { resolve = done; });
  const f = setupRecording(recording, () => pending);
  const start = f.backend.start(f.options);
  const rejection = expect(start).rejects.toMatchObject({ name: "AbortError" });
  await f.backend.stop();
  const dispose = vi.fn();
  resolve({ dispose } as unknown as WasmChannelFilter);
  await rejection;
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.analysis.begin).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("catches up 19.2 MS/s replay under 4 ms timer clamping with bounded blocks", async () => {
  const { hackrfRecordingFixture } = await import("../testing/hackrfRecordingFixture");
  const { recording } = await hackrfRecordingFixture(new Uint8Array(2 * 384_000), 19_200_000, 0x0110);
  const original = window.setTimeout;
  const timer = vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => original(callback, Math.max(4, delay ?? 0))) as typeof window.setTimeout);
  try {
    const f = setupRecording(recording);
    await f.backend.start(f.options);
    await vi.advanceTimersByTimeAsync(28);
    expect(f.events.sourceEnded).toHaveBeenCalledOnce();
    expect(f.events.runtimeError).not.toHaveBeenCalled();
    expect(f.samples.reduce((sum, block) => sum + block.I.length, 0)).toBe(384_000);
    expect(f.samples.every(block => block.I.length <= 8192)).toBe(true);
    await f.backend.stop();
  } finally { timer.mockRestore(); }
});
