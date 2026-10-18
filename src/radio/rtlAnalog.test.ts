import { expect, it } from "vitest";
import { SharedWbfmDemodulator } from "./sharedWbfmDemodulator";
import { createSignalsMode, defaultModeSettings } from "./receiverConfig";

for (const mode of ["AM", "NBFM", "USB", "LSB", "CW"] as const)
  it.each([44_100, 48_000])(`recovers the expected ${mode} audio tone from offset 3.2 MS/s input at %i Hz audio`, audioRate => {
    const rate = 3_200_000, offset = -173_000, expectedTone = mode === "CW" ? 730 : 1_000;
    const output: number[] = [];
    const player = { sampleRate: audioRate, play: (left: Float32Array) => { output.push(...left); }, setVolume() {}, getVolume: () => 1 };
    const demodulator = new SharedWbfmDemodulator(player, () => undefined);
    const settings = defaultModeSettings(mode);
    if (mode === "CW") demodulator.setCwToneFrequency(expectedTone);
    demodulator.setSampleRate(rate);
    demodulator.setMode(createSignalsMode(settings));
    demodulator.setFrequencyOffset(offset);
    let phase = 0;
    for (let start = 0; start < rate * 0.18; start += 16_381) {
      const count = Math.min(16_381, rate * 0.18 - start), I = new Float32Array(count), Q = new Float32Array(count);
      for (let n = 0; n < count; n++) {
        const tone = Math.sin(2 * Math.PI * 1_000 * (start + n) / rate);
        const carrier = offset + (mode === "NBFM" ? tone * 2_000 : mode === "USB" ? 1_000 : mode === "LSB" ? -1_000 : 0);
        phase += 2 * Math.PI * carrier / rate;
        const amplitude = mode === "AM" ? 0.4 * (1 + 0.5 * tone) : 0.4;
        I[n] = amplitude * Math.cos(phase); Q[n] = amplitude * Math.sin(phase);
      }
      demodulator.receiveSamples({ I, Q, frequency: 100e6 });
    }
    const audio = output.slice(2_000);
    const power = (hz: number) => {
      let real = 0, imaginary = 0;
      for (let n = 0; n < audio.length; n++) { const phase = 2 * Math.PI * hz * n / audioRate; real += audio[n]! * Math.cos(phase); imaginary += audio[n]! * Math.sin(phase); }
      return real * real + imaginary * imaginary;
    };
    expect(audio.length).toBeGreaterThan(audioRate * 0.1);
    expect(audio.every(Number.isFinite)).toBe(true);
    expect(power(expectedTone)).toBeGreaterThan(power(expectedTone + 500) * 25);
  });
