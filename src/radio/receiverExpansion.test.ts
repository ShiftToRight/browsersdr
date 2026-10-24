import { RtlRfSource } from "./rtlRfSource";
import { RTL2832U } from "@jtarrio/webrtlsdr/rtlsdr/rtl2832u.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import {
  DEFAULT_RTL_INPUT,
  normalizeRtlInput,
  rtlDeviceFrequency,
} from "./rtlInput";
import { ActivityCapture, EVENT_RING_MAX_BYTES } from "./activityCapture";
import { defaultModeSettings } from "./receiverConfig";
import {
  IqRecorder,
  parseRecording,
  recordingMetadataJson,
  type IqRecording,
} from "./iqRecording";
import { buildSigmfMetadata } from "./sigmf";
import {
  loadSourcePreferences,
  saveSourcePreferences,
} from "./sourcePreferences";
import {
  SecondaryVfo,
  validateSecondaryVfo,
  type SecondaryVfoSettings,
} from "./secondaryVfo";
import { watchLevel } from "./channelWatch";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import { InputClippingMonitor } from "../dsp/inputClipping";

const session: SourceSessionMetadata = {
  source: "rtl-sdr",
  sessionGeneration: 1,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100e6,
  selectedChannelFrequencyHz: 100e6,
  mode: "AM",
  channelBandwidthHz: 12_000,
  squelch: 0,
  gainDb: 25,
  sampleFormat: "planar-f32-iq-normalized",
};
const settings: SecondaryVfoSettings = {
  frequencyHz: 100.1e6,
  mode: "AM",
  bandwidthHz: 12_000,
  squelch: 0,
  volume: 0.5,
  muted: false,
  recordAudio: false,
};
afterEach(() => vi.useRealTimers());
describe("declared RTL input and frequency translation", () => {
  it("programs the pinned driver's Q ADC route and GPIO0 bias-tee vectors", async () => {
    const com = {
      openI2C: vi.fn(async () => undefined),
      closeI2C: vi.fn(async () => undefined),
      setDemodReg: vi.fn(async () => undefined),
      setGpioOutput: vi.fn(async () => undefined),
      setGpioBit: vi.fn(async () => undefined),
    };
    const device = Object.assign(Object.create(RTL2832U.prototype), {
      ppm: 0,
      centerFrequency: 0,
      directSamplingMethod: 0,
      directSampling: 0,
      tuner: {
        getMinimumFrequency: () => 24e6,
        close: vi.fn(async () => undefined),
      },
      com,
    }) as RTL2832U;
    await device.setDirectSamplingMethod(2);
    await device.setCenterFrequency(4_583_000);
    expect(com.setDemodReg.mock.calls).toEqual(
      expect.arrayContaining([
        [1, 0xb1, 0x1a, 1],
        [1, 0x15, 0, 1],
        [0, 6, 0x90, 1],
        [0, 0x19, 0x25, 1],
      ]),
    );
    await device.enableBiasTee(true);
    await device.enableBiasTee(false);
    expect(com.setGpioOutput.mock.calls).toEqual([[0], [0]]);
    expect(com.setGpioBit.mock.calls).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });
  it.each(["generic", "rtl-blog-v4", "always-on-bias"] as const)(
    "rejects Q branch for %s",
    (profile) =>
      expect(() =>
        normalizeRtlInput({
          ...DEFAULT_RTL_INPUT,
          profile,
          directSampling: "q",
        }),
      ).toThrow(/Q-branch/),
  );
  it.each(["generic", "nesdr-smart-v5", "always-on-bias"] as const)(
    "rejects software power for %s",
    (profile) =>
      expect(() =>
        normalizeRtlInput({ ...DEFAULT_RTL_INPUT, profile, biasTee: true }),
      ).toThrow(/power/),
  );
  it("bounds Q input and rejects simultaneous converter translation", () => {
    const q = {
      ...DEFAULT_RTL_INPUT,
      profile: "nesdr-smart-v5" as const,
      directSampling: "q" as const,
    };
    expect(rtlDeviceFrequency(4_583_000, q)).toBe(4_583_000);
    for (const hz of [0, 99_999, 25e6, NaN])
      expect(() => rtlDeviceFrequency(hz, q)).toThrow();
    expect(() => normalizeRtlInput({ ...q, converterOffsetHz: 125e6 })).toThrow(
      /both/,
    );
  });
  it("translates commands/readback/block coordinates without touching borrowed samples", async () => {
    const I = Float32Array.of(0.1, 0.2),
      Q = Float32Array.of(-0.1, -0.2);
    let device = 0;
    const raw = {
      setSampleRate: async (n: number) => n,
      setParameter: vi.fn(async () => undefined),
      setCenterFrequency: vi.fn(async (n: number) => {
        device = n;
        return n + 2;
      }),
      readSamples: async () => ({ I, Q, frequency: device + 2 }),
      close: vi.fn(async () => undefined),
      startReceiving: async () => undefined,
    } as unknown as SignalSource;
    const source = new RtlRfSource(raw);
    source.input = { ...DEFAULT_RTL_INPUT, converterOffsetHz: 125e6 };
    expect(await source.setCenterFrequency(4_583_000)).toBe(4_583_002);
    expect(raw.setCenterFrequency).toHaveBeenCalledWith(129_583_000);
    expect(await source.readSamples(2)).toEqual({ I, Q, frequency: 4_583_002 });
    expect((await source.readSamples(2)).I).toBe(I);
    await source.close();
    expect(raw.setParameter).toHaveBeenCalledWith("bias_tee", false);
    expect(raw.close).toHaveBeenCalledOnce();
  });
  it("preserves HF context in recording and SigMF and never restores power from preferences", async () => {
    const input = {
      ...DEFAULT_RTL_INPUT,
      profile: "rtl-blog-v3" as const,
      converterOffsetHz: 125e6,
      biasTee: true,
    };
    const recorder = new IqRecorder({ ...session, rtlInput: input });
    recorder.appendCu8(new Uint8Array(4096).fill(128));
    const recording = recorder.finish("user");
    expect(
      parseRecording(recordingMetadataJson(recording), recording.data).metadata
        .rtlInput,
    ).toEqual(input);
    expect(
      (await buildSigmfMetadata(recording)).global["browsersdr:rtl_input"],
    ).toEqual(input);
    const values = new Map<string, string>(),
      storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      };
    saveSourcePreferences(storage, "rtl-sdr", {
      frequencyHz: 100e6,
      modeSettings: defaultModeSettings("AM"),
      sampleRateHz: 1_024_000,
      rtlInput: input,
    });
    expect(loadSourcePreferences(storage, "rtl-sdr").rtlInput).toEqual({
      ...input,
      biasTee: false,
    });
  });
});
describe("bounded native activity capture", () => {
  it("retains exact pre/post bytes and ends on acquired sample count", async () => {
    const captures: IqRecording[] = [];
    const buffer = new ActivityCapture(0.1, 0.1, (r) => captures.push(r));
    const pre = new Uint8Array(300_000).map((_, i) => i % 256);
    buffer.observe(pre, session);
    const expected = pre.slice(-204_800);
    const done = buffer.trigger();
    const post = new Uint8Array(204_800).fill(42);
    buffer.observe(post, session);
    await done;
    expect(captures).toHaveLength(1);
    expect(captures[0]!.data).toEqual(new Uint8Array([...expected, ...post]));
    expect(captures[0]!.metadata.durationSeconds).toBe(0.2);
    buffer.reset();
  });
  it("never joins bytes across generation, gain or center changes", async () => {
    const captures: IqRecording[] = [];
    const buffer = new ActivityCapture(0.5, 2, (r) => captures.push(r));
    buffer.observe(new Uint8Array(4096).fill(2), session);
    const done = buffer.trigger();
    buffer.observe(new Uint8Array(4096).fill(3), { ...session, gainDb: 20 });
    await done;
    expect(captures[0]!.data).toEqual(new Uint8Array(4096).fill(2));
    expect(captures[0]!.metadata.stopReason).toBe("metadata-change");
    buffer.reset();
  });
  it("bounds pre-trigger memory, ends partial on cancellation and limits event count", async () => {
    const captures: IqRecording[] = [];
    const buffer = new ActivityCapture(2, 2, (r) => captures.push(r));
    const fast = {
      ...session,
      actualSampleRateHz: 3_200_000,
      requestedSampleRateHz: 3_200_000,
    };
    for (let n = 0; n < 20; n++)
      buffer.observe(new Uint8Array(1024 * 1024).fill(n), fast);
    const done = buffer.trigger();
    buffer.reset();
    await done;
    expect(captures[0]!.data.length).toBe(EVENT_RING_MAX_BYTES);
    expect(captures[0]!.metadata.stopReason).toBe("source-stop");
    for (let n = 0; n < 2; n++) {
      buffer.observe(new Uint8Array(1024), session);
      const next = buffer.trigger();
      buffer.reset();
      await next;
    }
    buffer.observe(new Uint8Array(1024), session);
    expect(() => buffer.trigger()).toThrow(/quota/);
  });
  it("marks a source stall as partial and does not invent post-trigger bytes", async () => {
    vi.useFakeTimers();
    const captures: IqRecording[] = [];
    const buffer = new ActivityCapture(0.1, 0.1, (r) => captures.push(r));
    buffer.observe(new Uint8Array(4096), session);
    const done = buffer.trigger();
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(captures[0]!.metadata.sampleCount).toBe(2048);
    expect(captures[0]!.metadata.captureWarning).toMatch(/partial/);
    buffer.reset();
  });
});
describe("VFO B passband, input ownership and real demodulation", () => {
  it("rejects out-of-window and invalid settings before changing a channel", () => {
    expect(validateSecondaryVfo(settings, session)).toEqual(settings);
    expect(() =>
      validateSecondaryVfo({ ...settings, frequencyHz: 101e6 }, session),
    ).toThrow(/capture/);
    expect(() =>
      validateSecondaryVfo({ ...settings, volume: NaN }, session),
    ).toThrow();
  });
  it("demodulates the selected AM audio without mutating the original shared I/Q", async () => {
    const audio: Float32Array[] = [];
    const context = {
      currentTime: 0,
      createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
      createBuffer: (_channels: number, length: number) => {
        const left = new Float32Array(length);
        return {
          left,
          copyToChannel: (data: Float32Array, channel: number) => {
            if (!channel) left.set(data);
          },
        };
      },
      createBufferSource: () => ({
        buffer: undefined as unknown,
        connect() {},
        disconnect() {},
        stop() {},
        start() {
          audio.push((this.buffer as { left: Float32Array }).left);
        },
        onended: null,
      }),
    } as unknown as AudioContext;
    const changed = vi.fn(),
      vfo = new SecondaryVfo(context, changed);
    await vfo.configure(settings, session);
    for (let start = 0; start < 131072; start += 8192) {
      const I = new Float32Array(8192),
        Q = new Float32Array(8192);
      for (let i = 0; i < I.length; i++) {
        const t = (start + i) / session.actualSampleRateHz,
          a = 0.3 * (1 + 0.7 * Math.cos(2 * Math.PI * 1000 * t)),
          b = 0.2 * (1 + 0.7 * Math.cos(2 * Math.PI * 3000 * t));
        I[i] =
          a * Math.cos(2 * Math.PI * 100000 * t) +
          b * Math.cos(-2 * Math.PI * 150000 * t);
        Q[i] =
          a * Math.sin(2 * Math.PI * 100000 * t) +
          b * Math.sin(-2 * Math.PI * 150000 * t);
      }
      const beforeI = I.slice(),
        beforeQ = Q.slice();
      vfo.receive({ I, Q, frequency: session.hardwareCenterFrequencyHz });
      expect(I).toEqual(beforeI);
      expect(Q).toEqual(beforeQ);
    }
    expect(audio.length).toBeGreaterThan(0);
    const samples = Float32Array.from(audio.flatMap((a) => Array.from(a)));
    const energy = (frequency: number) => {
      let re = 0,
        im = 0;
      for (let i = 2000; i < samples.length; i++) {
        re += samples[i]! * Math.cos((2 * Math.PI * frequency * i) / 48000);
        im += samples[i]! * Math.sin((2 * Math.PI * frequency * i) / 48000);
      }
      return re * re + im * im;
    };
    expect(energy(1000)).toBeGreaterThan(energy(3000) * 10);
    vfo.close();
    expect(vfo.settings).toBeUndefined();
    expect(changed).toHaveBeenLastCalledWith(undefined, undefined);
  });
});
describe("honest RF levels and activity", () => {
  it("measures relative RMS/peak, expires stale input and resets context", () => {
    const monitor = new InputClippingMonitor();
    monitor.observePlanar(
      new Float32Array(1024).fill(0.1),
      new Float32Array(1024).fill(-0.1),
      "rtl-sdr",
      100,
    );
    expect(monitor.getLevel(100)?.rmsDb).toBeCloseTo(-20);
    expect(monitor.getLevel(100)?.dc).toBeCloseTo(0);
    expect(monitor.getLevel(2000)).toBeUndefined();
    monitor.reset();
    expect(monitor.getLevel(100)).toBeUndefined();
  });
  it("requires actual spectrum coverage and estimates activity relative to measured noise", () => {
    const frame: SpectrumFrame = {
      sessionGeneration: 1,
      sequence: 1,
      timestampMs: 0,
      sampleIndex: 1024,
      centerFrequencyHz: 100e6,
      sampleRateHz: 1_024_000,
      units: "relative-dB",
      bins: new Float32Array(1024).fill(-80),
      droppedFramesBefore: 0,
    };
    frame.bins[612] = -50;
    expect(watchLevel(frame, 100.1e6, 12000)).toBe(30);
    expect(watchLevel(frame, 102e6, 12000)).toBeUndefined();
    frame.bins.fill(NaN);
    expect(watchLevel(frame, 100.1e6, 12000)).toBeUndefined();
  });
});
