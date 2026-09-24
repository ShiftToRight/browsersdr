import { ChannelWorkerFixture } from "../testing/channelWorkerFixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { AnalysisPipeline } from "../dsp/analysisPipeline";
import { FakeHackrfUsb, deferredUsb, usbView } from "../testing/hackrfUsbFixture";
import { HackrfBackend } from "./hackrfBackend";
import { HackrfTransport, type NativeIqBlock } from "./hackrfTransport";
import { defaultModeSettings, type ReceiverMode } from "./receiverConfig";
import { ReceiverController, type ReceiverBackendEvents, type ReceiverStartOptions } from "./receiverController";
import type { AnalysisWorkerInput } from "../dsp/spectrumProtocol";
import { DAB_NULL_SAMPLES } from "../dab/dabReceiver";

const OPTIONS: ReceiverStartOptions = { source: "hackrf", channelFrequencyHz: 100_000_000, sampleRateHz: 1_024_000, volume: .5, modeSettings: defaultModeSettings("AM") };
async function flush() { for (let n = 0; n < 400; n++) await Promise.resolve(); }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(device = new FakeHackrfUsb(), permission?: Promise<USBDevice>, sharedAnalysis?: AnalysisPipeline) {
  let now = 0, state: AudioContextState = "suspended";
  const audio = { get state() { return state; }, sampleRate: 48_000,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    resume: vi.fn(async () => { state = "running"; }), suspend: vi.fn(async () => { state = "suspended"; }),
    close: vi.fn(async () => { state = "closed"; }) };
  const events = { permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(), sourceEnded: vi.fn(),
    rdsChanged: vi.fn(), dabChanged: vi.fn(), adsbChanged: vi.fn(), aisChanged: vi.fn() } satisfies ReceiverBackendEvents;
  const messages: AnalysisWorkerInput[] = [];
  const analysis = sharedAnalysis ?? new AnalysisPipeline({ postMessage: (message: AnalysisWorkerInput) => messages.push(message), terminate() {} } as unknown as Worker);
  const raw: { I: Float32Array; Q: Float32Array }[] = [];
  analysis.attachGpuTap(block => raw.push({ I: block.I.slice(), Q: block.Q.slice() }));
  const played: Float32Array[] = [];
  const demodulator = new Demodulator({ player: { sampleRate: 48_000, play: left => { played.push(left.slice()); }, setVolume() {}, getVolume: () => .5 } });
  const captured: NativeIqBlock[] = [];
  const requestDevice = vi.fn(() => permission ?? Promise.resolve(device));
  const backend = new HackrfBackend(events, analysis, 1, {
    usb: { requestDevice } as unknown as USB,
    createChannelWorker: () => new ChannelWorkerFixture(),
    createAudioContext: () => audio as unknown as AudioContext,
    createDemodulator: () => demodulator,
    createTransport: events => new HackrfTransport(events, () => now),
    nativeCapture: block => captured.push({ ...block, bytes: block.bytes.slice() }),
  });
  cleanups.push(() => backend.disconnect());
  async function deliver(bytes: Uint8Array) { device.deliver(bytes); await flush(); }
  async function ready(task: Promise<unknown>, rate = 1_024_000) {
    await flush(); now += 200;
    const count = Math.ceil((Math.ceil(rate * .12) + 32_768) / 32_768);
    for (let n = 0; n < count; n++) await deliver(new Uint8Array(65_536));
    await deliver(new Uint8Array(24));
    await task;
    raw.pop(); captured.pop(); if (played.length) played.pop();
  }
  async function feed(bytes: Uint8Array) { for (let n = 0; n < bytes.length; n += 65_536) await deliver(bytes.subarray(n, n + 65_536)); }
  return { backend, device, audio, events, analysis, messages, raw, played, captured, requestDevice, demodulator, ready, feed, deliver };
}
function tone(count: number, rate: number, frequency: number, amplitude = 90): Uint8Array {
  const bytes = new Uint8Array(count * 2);
  for (let n = 0; n < count; n++) { bytes[n * 2] = Math.round(amplitude * Math.cos(2 * Math.PI * frequency * n / rate)); bytes[n * 2 + 1] = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * n / rate)); }
  return bytes;
}

function write(bits: number[], start: number, length: number, value: number): void {
  for (let bit = 0; bit < length; bit += 1) bits[start + bit] = (value >> (length - bit - 1)) & 1;
}
function positionFrame(): Uint8Array {
  const bits = new Array<number>(168).fill(0);
  write(bits, 0, 6, 1); write(bits, 8, 30, 211_234_567); write(bits, 38, 4, 0); write(bits, 50, 10, 123);
  write(bits, 61, 28, Math.round(11.58 * 600_000)); write(bits, 89, 27, Math.round(48.14 * 600_000)); write(bits, 116, 12, 875); write(bits, 128, 9, 88);
  const payload = new Uint8Array(21);
  for (let bit = 0; bit < bits.length; bit += 1) payload[bit >> 3] = (payload[bit >> 3] ?? 0) | (bits[bit]! << (7 - (bit & 7)));
  let crc = 0xffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  crc ^= 0xffff;
  return Uint8Array.from([...payload, crc & 0xff, crc >> 8]);
}


describe("HackRF live pipeline", () => {
  it.each([-100_000, 100_000])("preserves raw signed IQ before audio mutates it and tunes the selected channel at %i Hz", async offset => {
    const f = fixture(); await f.ready(f.backend.start({ ...OPTIONS, modeSettings: defaultModeSettings("USB") }, 1));
    const controls = f.device.calls.length;
    const meta = await f.backend.tune(OPTIONS.channelFrequencyHz + offset, 2);
    expect(meta).toMatchObject({ hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_000_000 + offset, actualSampleRateHz: 1_024_000 });
    expect(f.device.calls).toHaveLength(controls);
    const bytes = tone(32_768, 1_024_000, offset + 1000);
    await f.feed(bytes);
    expect(f.played.length).toBeGreaterThan(0);
    const audio = f.played.flatMap(value => [...value]).slice(500);
    expect(audio.every(Number.isFinite)).toBe(true);
    const power = (frequency: number) => {
      let re = 0, im = 0;
      audio.forEach((v, n) => { re += v * Math.cos(2 * Math.PI * frequency * n / 48_000); im += v * Math.sin(2 * Math.PI * frequency * n / 48_000); });
      return (re * re + im * im) / audio.length ** 2;
    };
    expect(power(1000)).toBeGreaterThan(.001);
    expect(power(1000)).toBeGreaterThan(power(3000) * 100);
    const signed = new Int8Array(bytes.buffer);
    expect(f.raw[0]!.I[17]).toBe(signed[34]! / 128); expect(f.raw[0]!.Q[17]).toBe(signed[35]! / 128);
    expect(f.captured[0]).toMatchObject({ generation: 2, firstSampleIndex: 0, encoding: "ci8", nativeSampleRateHz: 1_024_000 });
    expect(f.captured[0]!.bytes).toEqual(bytes);
    expect(f.analysis.getDiagnostics()).toMatchObject({ receivedBytes: bytes.length, receivedComplexSamples: bytes.length / 2 });
    expect(f.events.runtimeError).not.toHaveBeenCalled();
  });
  it("rejects an unsafe fractional resampler ratio before allocating DSP filters", async () => {
    const device = new FakeHackrfUsb();
    device.inOverride = setup => {
      if (setup.request !== 60 || setup.value !== 6) return;
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, 1_024_000n * 2n ** 36n + 2n ** 34n, true);
      return Promise.resolve({ status: "ok", data: usbView(bytes) });
    };
    const f = fixture(device); const rate = vi.spyOn(f.demodulator, "setSampleRate");
    const starting = f.backend.start(OPTIONS);
    const rejected = expect(starting).rejects.toThrow(/resampler budget/);
    await flush();
    // The physical profile accepts this readback; the live Signals allocation
    // guard rejects it at readiness without rounding it to a nominal rate.
    await f.ready(rejected);
    expect(rate).not.toHaveBeenCalled();
    expect(f.captured).toHaveLength(0); expect(f.raw).toHaveLength(0);
  });
  it("hardware-centers ADS-B mode changes at 1090 MHz and rejects off-band tunes", async () => {
    const f = fixture(); await f.ready(f.backend.start({ ...OPTIONS, sampleRateHz: 2_400_000 }), 2_400_000);
    const changing = f.backend.configureMode(defaultModeSettings("ADS-B"), 2);
    await f.ready(changing, 2_400_000);
    expect(await changing).toMatchObject({ hardwareCenterFrequencyHz: 1_090_000_000, selectedChannelFrequencyHz: 1_090_000_000 });
    const calls = f.device.calls.length;
    await expect(f.backend.tune(1_090_100_000, 3)).rejects.toThrow(/1090 MHz/);
    expect(f.device.calls).toHaveLength(calls);
  });
  it("retains the active route after invalid commands and configures every analog mode", async () => {
    const f = fixture(); await f.ready(f.backend.start(OPTIONS));
    const controls = f.device.calls.length;
    await expect(f.backend.configureMode(defaultModeSettings("DAB"), 2)).rejects.toThrow();
    await expect(f.backend.tune(NaN, 2)).rejects.toThrow();
    await expect(f.backend.configureHardware({ kind: "hackrf", rxLnaGainCode: 16, rxVgaGainDb: 3, rfAmplifierEnabled: false, antennaPowerEnabled: false }, 2)).rejects.toThrow();
    expect(f.device.calls).toHaveLength(controls);
    for (const mode of ["WBFM", "NBFM", "AM", "USB", "LSB"] as ReceiverMode[]) {
      await f.backend.configureMode(defaultModeSettings(mode), 3);
      await f.feed(tone(8192, 1_024_000, 1000));
    }
    expect(f.played).toHaveLength(5);
  });
  it("restarts hardware for explicit scan and stage gains, drops old reads, and preserves high frequencies", async () => {
    const f = fixture(); await f.ready(f.backend.start(OPTIONS));
    const old = f.device.pendingReads[0]!;
    const tuning = f.backend.scanTune(4_300_000_001, 4);
    old.settled = true; old.result.resolve({ status: "ok", data: new DataView(tone(100, 1_024_000, 1).buffer) });
    await f.ready(tuning);
    expect(f.raw).toHaveLength(0);
    await f.feed(tone(100, 1_024_000, 1000));
    expect(f.captured[0]!.generation).toBe(4);
    const gain = f.backend.configureHardware({ kind: "hackrf", rxLnaGainCode: 33, rxVgaGainDb: 62, rfAmplifierEnabled: false, antennaPowerEnabled: false }, 5);
    await f.ready(gain);
    expect(await gain).toMatchObject({ hardwareCenterFrequencyHz: 4_300_000_001, gainDb: null,
      hackrf: { captureSettings: { kind: "hackrf", rxLnaGainCode: 33, rxVgaGainDb: 62, antennaPowerEnabled: false } } });
    expect(f.requestDevice).toHaveBeenCalledOnce();
  });
  it.each([2_400_000, 4_800_000, 9_600_000])("delivers ADS-B at native %i samples/s to the real decoder before any audio", async rate => {
    const f = fixture(); await f.ready(f.backend.start({ ...OPTIONS, channelFrequencyHz: 1_090_000_000, sampleRateHz: rate, modeSettings: defaultModeSettings("ADS-B") }), rate);
    const frame = Uint8Array.from("8D4840D6202CC371C32CE0576098".match(/../g)!.map(v => parseInt(v, 16)));
    const ideal = new Uint8Array(16 + frame.length * 16);
    for (const n of [0, 2, 7, 9]) ideal[n] = 100;
    for (let bit = 0; bit < frame.length * 8; bit++) ideal[16 + bit * 2 + ((frame[bit >> 3]! >> (7 - (bit & 7))) & 1 ? 0 : 1)] = 100;
    const bytes = new Uint8Array((Math.ceil(ideal.length * (rate / 2_000_000)) + 2) * 2);
    for (let n = 0; n < bytes.length / 2; n++) bytes[2 * n] = ideal[Math.floor((n + .5) / (rate / 2_000_000))] ?? 0;
    // Align this ideal pulse fixture after the cascade delay; the existing 2 MHz
    // decoder remains sample-phase sensitive (not an all-phase reception claim).
    const padded = new Uint8Array(bytes.length + 1024); padded.set(bytes, rate === 9_600_000 ? 518 : 512);
    await f.feed(rate >= 4_800_000 ? padded : bytes);
    expect(f.events.adsbChanged).toHaveBeenLastCalledWith(expect.objectContaining({ validFrames: 1, targets: [expect.objectContaining({ callsign: "KLM1023" })] }));
    expect(f.played).toHaveLength(0); expect(f.raw).toHaveLength(1);
    await f.backend.configureMode(defaultModeSettings("AM"), 2);
    await f.backend.configureMode(defaultModeSettings("ADS-B"), 3);
    expect(f.events.adsbChanged).toHaveBeenLastCalledWith(expect.objectContaining({ validFrames: 0 }));
  });
  it.each([2_400_000, 4_800_000, 9_600_000].flatMap(rate => [-100_000, 100_000].map(offset => ({ rate, offset }))))("decodes AIS CI8 at $rate with selected offset $offset", async ({ rate, offset }) => {
    const f = fixture(); await f.ready(f.backend.start({ ...OPTIONS, channelFrequencyHz: 162_000_000 - offset, sampleRateHz: rate, modeSettings: defaultModeSettings("AIS") }), rate);
    await f.backend.tune(162_000_000, 2);
    const flag = [0, 1, 1, 1, 1, 1, 1, 0], payload: number[] = [];
    let ones = 0;
    for (const byte of positionFrame()) for (let bit = 0; bit < 8; bit++) {
      const value = (byte >> bit) & 1; payload.push(value);
      if (value) { if (++ones === 5) { payload.push(0); ones = 0; } } else ones = 0;
    }
    const bits = [...Array.from({ length: 24 }, (_, n) => n & 1), ...flag, ...payload, ...flag, 1, 1, 1];
    const bytes = new Uint8Array(bits.length * (rate / 9600) * 2);
    let phase = 0, level = 1, position = 0;
    for (const bit of bits) {
      if (!bit) level ^= 1;
      for (let n = 0; n < rate / 9600; n++) {
        phase += 2 * Math.PI * (offset - 25_000 + (level ? 2400 : -2400)) / rate;
        bytes[position++] = Math.round(90 * Math.cos(phase)); bytes[position++] = Math.round(90 * Math.sin(phase));
      }
    }
    await f.feed(bytes);
    expect(f.events.aisChanged).toHaveBeenLastCalledWith(expect.objectContaining({ validFrames: 1, targets: [expect.objectContaining({ mmsi: 211_234_567 })] }));
    expect(f.played).toHaveLength(0);
  });
  it.each([2_400_000, 4_800_000, 9_600_000])("acquires DAB null-symbol synchronization at native %i samples/s", async rate => {
    const f = fixture(); await f.ready(f.backend.start({ ...OPTIONS, channelFrequencyHz: 220_352_000, sampleRateHz: rate, modeSettings: defaultModeSettings("DAB") }), rate);
    for (const [length, amplitude] of [[24_000, 90], [DAB_NULL_SAMPLES, 1], [3100, 90]]) await f.feed(tone(Math.round(length! * rate / 2_048_000), rate, 40_000, amplitude));
    expect(f.events.dabChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: "synchronized", nullSymbolCount: 1 }));
    expect(f.played).toHaveLength(0);
  });
});

describe("HackRF backend ownership", () => {
  it("connects without starting RX, stops and restarts without another chooser", async () => {
    const f = fixture(); await f.backend.connect(OPTIONS);
    expect(f.device.reads).toHaveLength(0); expect(f.audio.resume).not.toHaveBeenCalled();
    await f.ready(f.backend.start(OPTIONS)); await f.backend.stop();
    expect(f.device.pendingReads).toHaveLength(0);
    await f.ready(f.backend.start(OPTIONS, 9)); await f.feed(tone(100, 1_024_000, 1000));
    expect(f.captured[0]!.generation).toBe(9); expect(f.requestDevice).toHaveBeenCalledOnce();
  });
  it.each(["connect", "start"] as const)("cancels %s during permission and closes a late device", async operation => {
    const permission = deferredUsb<USBDevice>(); const f = fixture(undefined, permission.promise);
    const pending = f.backend[operation](OPTIONS).catch((error: Error) => error.name);
    expect(f.requestDevice).toHaveBeenCalledOnce();
    const close = f.backend.disconnect(); expect(f.backend.disconnect()).toBe(close);
    permission.resolve(f.device); await close;
    expect(await pending).toBe("AbortError"); expect(f.device.pendingReads).toHaveLength(0);
    expect(f.audio.close).toHaveBeenCalledOnce();
  });
  it("cancels start with reads pending and retries failed USB cleanup independently", async () => {
    const f = fixture(); const pending = f.backend.start(OPTIONS).catch((error: Error) => error.name);
    await flush(); expect(f.device.pendingReads.length).toBeGreaterThan(0);
    f.device.closeFailures = 1;
    await expect(f.backend.disconnect()).rejects.toThrow("close failed");
    await f.backend.disconnect(); expect(await pending).not.toBe("resolved");
    expect(f.audio.close).toHaveBeenCalledOnce(); expect(f.device.pendingReads).toHaveLength(0);
  });
  it("retains audio cleanup ownership for a retry", async () => {
    const f = fixture(); await f.backend.connect(OPTIONS);
    f.audio.close.mockRejectedValueOnce(new Error("audio close failed"));
    await expect(f.backend.disconnect()).rejects.toThrow("audio close failed");
    await f.backend.disconnect(); expect(f.audio.close).toHaveBeenCalledTimes(2);
  });
  it("supports StrictMode-style source replacement without an old owner stopping the new analysis", async () => {
    const first = fixture(), second = fixture(undefined, undefined, first.analysis);
    const factory = vi.fn().mockReturnValueOnce(first.backend).mockReturnValueOnce(second.backend);
    const controller = new ReceiverController(factory);
    await first.ready(controller.start(OPTIONS));
    await controller.disconnect();
    await second.ready(controller.start(OPTIONS));
    await first.backend.disconnect();
    await second.feed(tone(100, 1_024_000, 1000));
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "running", session: { source: "hackrf" } });
    expect(second.captured).toHaveLength(1);
    expect(first.captured).toHaveLength(0);
    expect(second.analysis.getDiagnostics().receivedComplexSamples).toBe(112);
    await controller.disconnect();
  });
  it("rejects a failed hardware command without publishing further samples", async () => {
    const f = fixture(); await f.ready(f.backend.start(OPTIONS));
    f.device.outOverride = setup => setup.request === 16 ? Promise.resolve({ status: "stall", bytesWritten: 0 }) : undefined;
    await expect(f.backend.scanTune(101_000_000, 2)).rejects.toThrow();
    expect(f.raw).toHaveLength(0);
  });
});

it.each(["tune", "mode", "gain", "stop", "disconnect"] as const)("ends native recording before %s changes its acquisition metadata", async operation => {
  const f = fixture(); await f.ready(f.backend.start(OPTIONS));
  f.backend.startRecording(); const bytes = Uint8Array.of(128, 127, 0, 255); await f.feed(bytes);
  if (operation === "tune") await f.backend.tune(100_100_000, 2);
  else if (operation === "mode") await f.backend.configureMode(defaultModeSettings("USB"), 2);
  else if (operation === "gain") await f.ready(f.backend.configureHardware({ kind: "hackrf", rxLnaGainCode: 33, rxVgaGainDb: 62, rfAmplifierEnabled: false, antennaPowerEnabled: false }, 2));
  else await f.backend[operation]();
  const result = f.backend.stopRecording()!;
  expect(result.data).toEqual(bytes);
  expect(result.metadata).toMatchObject({ format: "browsersdr-ci8-v2", mode: "AM", selectedChannelFrequencyHz: 100_000_000,
    captureSettings: { rxLnaGainCode: 16, rxVgaGainDb: 12 }, stopReason: operation === "stop" || operation === "disconnect" ? "source-stop" : "metadata-change" });
  expect(result.metadata).not.toHaveProperty("gainDb");
  expect(Number.isFinite(Date.parse(result.metadata.captureStartedAt))).toBe(true);
});

it("preserves partial native capture and an unknown tail on acquisition failure", async () => {
  const f = fixture(); await f.ready(f.backend.start(OPTIONS));
  f.backend.startRecording(); await f.feed(Uint8Array.of(128, 127));
  const read = f.device.pendingReads[0]!; read.settled = true; read.result.reject(new Error("unplugged"));
  await flush();
  const result = f.backend.stopRecording()!;
  expect(result.data).toEqual(Uint8Array.of(128, 127));
  expect(result.metadata).toMatchObject({ stopReason: "source-stop", knownGaps: [{ afterSample: 1, missingSamples: null, reason: expect.stringContaining("unknown") }] });
});


it.each([0x0109, 0x0110])("runs stable API %i through real DSP and preserves acknowledgement-only recording metadata", async api => {
  const f = fixture(new FakeHackrfUsb(api));
  await f.backend.connect(OPTIONS);
  await f.ready(f.backend.start(OPTIONS, 1));
  f.backend.startRecording();
  const bytes = tone(32_768, 1_024_000, 1_000);
  await f.feed(bytes);
  expect(f.played.length).toBeGreaterThan(0); expect(f.raw.length).toBeGreaterThan(0);
  const recorded = f.backend.stopRecording()!;
  expect(recorded.data).toEqual(bytes);
  expect(recorded.metadata).toMatchObject({ rateEvidence: "requested-and-acknowledged", captureSettings: { appliedRateFixed36: null, appliedRfFixed24: null, settingsEvidence: "usb-acknowledged" } });
  expect(f.requestDevice).toHaveBeenCalledOnce();
  expect(f.device.calls.some(call => [59, 60].includes(call.setup.request))).toBe(false);
});


it.each([0x0109, 0x0110, 0x0113].flatMap(api => [4_800_000, 9_600_000].map(rate => ({ api, rate }))))("captures $rate with wide analysis and a selected 2.4 MS/s channel on API $api", async ({ api, rate }) => {
  const f = fixture(new FakeHackrfUsb(api));
  const options = { ...OPTIONS, sampleRateHz: rate, modeSettings: defaultModeSettings("USB") };
  await f.backend.connect(options);
  await f.ready(f.backend.start(options, 1), rate);
  const controls = f.device.calls.length;
  const metadata = await f.backend.tune(101_700_000, 2);
  expect(metadata).toMatchObject({ actualSampleRateHz: rate, hardwareCenterFrequencyHz: 100_000_000,
    selectedChannelFrequencyHz: 101_700_000, hackrf: { effectiveSampleRateHz: 2_400_000, fpgaDecimationFactor: rate === 4_800_000 ? 8 : 4,
      hostResampling: { kind: rate === 4_800_000 ? "channel-fir-decimate-2-v1" : "channel-fir-decimate-4-v1", denominator: rate === 4_800_000 ? 2 : 4 } } });
  expect(f.device.calls.length).toBe(controls);
  f.backend.startRecording();
  const bytes = tone(262144, rate, 1_701_000);
  await f.feed(bytes);
  const recording = f.backend.stopRecording()!;
  expect(recording.data).toEqual(bytes);
  expect(recording.metadata).toMatchObject({ sampleRateHz: rate, effectiveSampleRateHz: 2_400_000 });
  expect(f.raw.reduce((n, b) => n + b.I.length, 0)).toBe(262144);
  const audio = f.played.flatMap(block => [...block]).slice(500);
  const power = (frequency: number) => {
    let re = 0, im = 0;
    audio.forEach((v, n) => { const angle = 2 * Math.PI * frequency * n / 48000; re += v * Math.cos(angle); im += v * Math.sin(angle); });
    return (re * re + im * im) / audio.length ** 2;
  };
  expect(power(1000)).toBeGreaterThan(.001); expect(power(1000)).toBeGreaterThan(power(3000) * 100);
  expect(f.events.runtimeError).not.toHaveBeenCalled();
});
