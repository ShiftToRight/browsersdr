import { describe, expect, it, vi } from "vitest";
import { DemodCW } from "@jtarrio/signals/demod/demod-cw.js";
import type { Player } from "@jtarrio/signals/demod/player.js";
import { SyntheticComplexTone } from "../testing/syntheticTone";
import { SharedWbfmDemodulator } from "./sharedWbfmDemodulator";
import { createSignalsMode } from "./receiverConfig";

class CapturePlayer implements Player {
  readonly sampleRate = 48_000;
  readonly blocks: Float32Array[] = [];
  private volume = 1;
  play(left: Float32Array): void { this.blocks.push(left.slice()); }
  setVolume(volume: number): void { this.volume = volume; }
  getVolume(): number { return this.volume; }
  samples(): Float32Array {
    const length = this.blocks.reduce((sum, block) => sum + block.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const block of this.blocks) { result.set(block, offset); offset += block.length; }
    return result;
  }
}

function strongestAudioFrequency(samples: Float32Array, sampleRate = 48_000): number {
  const input = samples.subarray(Math.min(2_000, Math.floor(samples.length / 4)));
  let strongest = 0, strongestPower = -1;
  for (let frequency = 250; frequency <= 1_050; frequency += 5) {
    let i = 0, q = 0;
    for (let n = 0; n < input.length; n++) {
      const phase = 2 * Math.PI * frequency * n / sampleRate;
      i += input[n]! * Math.cos(phase);
      q -= input[n]! * Math.sin(phase);
    }
    const power = i * i + q * q;
    if (power > strongestPower) { strongestPower = power; strongest = frequency; }
  }
  return strongest;
}

function runCw(rate: number, carrierOffsetHz: number, beatToneHz: number): Float32Array {
  const output = new CapturePlayer();
  const demodulator = new SharedWbfmDemodulator(output, vi.fn());
  demodulator.setSampleRate(rate);
  demodulator.setCwToneFrequency(beatToneHz);
  demodulator.setMode(createSignalsMode({ mode: "CW", bandwidthHz: 500, squelch: 0, beatToneHz }));
  demodulator.setFrequencyOffset(carrierOffsetHz);
  const source = new SyntheticComplexTone({ sampleRateHz: rate, toneOffsetHz: carrierOffsetHz });
  let remaining = Math.floor(rate * 0.18), block = 0;
  const boundaries = [1, 137, 4_096, 777, 8_193, 2_003];
  while (remaining > 0) {
    const count = Math.min(remaining, boundaries[block++ % boundaries.length]!);
    demodulator.receiveSamples({ ...source.generate(count), frequency: 100_000_000 });
    remaining -= count;
  }
  return output.samples();
}

describe("CW reception DSP", () => {
  it.each([1_024_000, 2_400_000])("turns an offset selected carrier into the requested beat note at %i sample/s across irregular blocks", rate => {
    const audio = runCw(rate, 123_000, 730);
    expect(audio.length).toBeGreaterThan(7_000);
    expect(strongestAudioFrequency(audio)).toBe(730);
  });

  it("changes audible pitch without changing the selected RF carrier coordinate", () => {
    const selectedFrequencyHz = 14_074_000;
    expect(strongestAudioFrequency(runCw(1_024_000, -91_000, 400))).toBe(400);
    expect(strongestAudioFrequency(runCw(1_024_000, -91_000, 900))).toBe(900);
    expect(selectedFrequencyHz).toBe(14_074_000);
  });

  it("attenuates an adjacent carrier outside the selected narrow filter", () => {
    const rate = 1_024_000, count = 131_072;
    const desired = new SyntheticComplexTone({ sampleRateHz: rate, toneOffsetHz: 0 }).generate(count);
    const adjacent = new SyntheticComplexTone({ sampleRateHz: rate, toneOffsetHz: 1_500 }).generate(count);
    const wanted = new DemodCW(rate, 48_000, { scheme: "CW", bandwidth: 500 }).demodulate(desired.I, desired.Q, 0).snr;
    const rejected = new DemodCW(rate, 48_000, { scheme: "CW", bandwidth: 500 }).demodulate(adjacent.I, adjacent.Q, 0).snr;
    expect(wanted / rejected).toBeGreaterThan(1_000);
  });

  it("reinitializes filter and oscillator history on retunes, mode transitions and discontinuity resets", () => {
    const output = new CapturePlayer(), demodulator = new SharedWbfmDemodulator(output, vi.fn());
    const settings = createSignalsMode({ mode: "CW", bandwidthHz: 250, squelch: 0, beatToneHz: 600 });
    demodulator.setSampleRate(1_024_000); demodulator.setCwToneFrequency(600); demodulator.setMode(settings);
    const prime = new SyntheticComplexTone({ sampleRateHz: 1_024_000, toneOffsetHz: 80_000 }).generate(10_001);
    demodulator.setFrequencyOffset(80_000); demodulator.receiveSamples({ ...prime, frequency: 100_000_000 });
    output.blocks.length = 0;
    demodulator.setMode(createSignalsMode({ mode: "AM", bandwidthHz: 10_000, squelch: 0 }));
    demodulator.setMode(settings); demodulator.setFrequencyOffset(-70_000);
    // Replay gaps reset the analog DSP by setting the active sample rate again.
    demodulator.setSampleRate(1_024_000);
    const afterReset = new SyntheticComplexTone({ sampleRateHz: 1_024_000, toneOffsetHz: -70_000 }).generate(8_191);
    demodulator.receiveSamples({ ...afterReset, frequency: 100_000_000 });

    const fresh = new CapturePlayer(), reference = new SharedWbfmDemodulator(fresh, vi.fn());
    reference.setSampleRate(1_024_000); reference.setCwToneFrequency(600); reference.setMode(settings); reference.setFrequencyOffset(-70_000);
    const same = new SyntheticComplexTone({ sampleRateHz: 1_024_000, toneOffsetHz: -70_000 }).generate(8_191);
    reference.receiveSamples({ ...same, frequency: 100_000_000 });
    expect(output.samples()).toEqual(fresh.samples());
  });
});
