import { afterEach, expect, it, vi } from "vitest";
import { Radio, RtlProvider } from "@jtarrio/webrtlsdr/radio.js";
import type { RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { AcknowledgedRtlSource } from "./acknowledgedRtlSource";

afterEach(() => vi.useRealTimers());

it("labels live blocks with the matching acknowledged tuner center", async () => {
  let requestedFrequency = 0;
  const device = {
    setCenterFrequency: async (frequency: number) => {
      requestedFrequency = frequency;
      return frequency + 17;
    },
    readSamples: async () => ({
      data: Uint8Array.from([0, 255]).buffer,
      // WebRTLSDR reports the requested value on sample blocks.
      frequency: requestedFrequency,
      directSampling: false,
    }),
  } as unknown as RtlDevice;
  const source = new AcknowledgedRtlSource(device);

  await expect(source.setCenterFrequency(100_000_000)).resolves.toBe(
    100_000_017,
  );
  await expect(source.readSamples(1)).resolves.toMatchObject({
    frequency: 100_000_017,
  });

  await source.setCenterFrequency(101_000_000);
  await expect(source.readSamples(1)).resolves.toMatchObject({
    frequency: 101_000_017,
  });
});

it("preserves live manual/auto acknowledgements through the installed Radio command queue", async () => {
  vi.useFakeTimers();
  let gain: number | null = null;
  let frequency = 100_000_000;
  const close = vi.fn(async () => {});
  const device = {
    setGain: async (value: number | null) => { gain = value; }, getGain: () => gain,
    setSampleRate: async (rate: number) => rate,
    setCenterFrequency: async (value: number) => { frequency = value; return value; },
    setFrequencyCorrection: async () => {}, getFrequencyCorrection: () => 0,
    setDirectSamplingMethod: async () => {}, getDirectSamplingMethod: () => 0,
    enableBiasTee: async () => {}, isBiasTeeEnabled: () => false,
    resetBuffer: async () => {}, close,
    readSamples: (length: number) => new Promise((resolve) => setTimeout(() => resolve({ data: new ArrayBuffer(length * 2), frequency, directSampling: false }), 5)),
  } as unknown as RtlDevice;
  const source = new AcknowledgedRtlSource(device);
  const provider = new RtlProvider({ get: async () => device });
  vi.spyOn(provider, "get").mockResolvedValue(source);
  const radio = new Radio(provider, { setSampleRate() {}, receiveSamples() {} });
  const errors: unknown[] = [];
  radio.addEventListener("radio", (event) => { if (event.detail.type === "error") errors.push(event.detail.exception); });
  await radio.setGain(null); await radio.start();
  expect(radio.isPlaying()).toBe(true);
  await radio.setGain(25);
  expect(radio.getGain()).toBe(25);
  await radio.setGain(null);
  expect(radio.getGain()).toBeNull();
  const stopping = radio.stop();
  await vi.advanceTimersByTimeAsync(10); await stopping;
  expect(close).toHaveBeenCalledOnce();
  expect(errors).toEqual([]);
});
