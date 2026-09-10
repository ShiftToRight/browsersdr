import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import type { Player } from "@jtarrio/signals/demod/player.js";
import type { SampleGenerator } from "@jtarrio/signals/sources/generated.js";
import { describe, expect, it } from "vitest";
import { createSignalsMode, type ReceiverModeSettings } from "../radio/receiverConfig";
import { syntheticAm, syntheticFm, syntheticSideband } from "./syntheticModulation";

const INPUT_RATE = 1_024_000;
const AUDIO_RATE = 48_000;
const CENTER_HZ = 10_000_000;
const CARRIER_OFFSET_HZ = 120_000;
const AUDIO_TONE_HZ = 1_200;

class CapturePlayer implements Player {
  readonly sampleRate = AUDIO_RATE;
  private chunks: Float32Array[] = [];
  private volume = 1;
  play(left: Float32Array): void { this.chunks.push(new Float32Array(left)); }
  setVolume(volume: number): void { this.volume = volume; }
  getVolume(): number { return this.volume; }
  samples(): Float32Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}

function recover(generator: SampleGenerator, settings: ReceiverModeSettings): Float32Array {
  const player = new CapturePlayer();
  const receiver = new Demodulator({ player });
  receiver.setSampleRate(INPUT_RATE);
  receiver.setMode(createSignalsMode(settings));
  receiver.setFrequencyOffset(CARRIER_OFFSET_HZ);
  const blockSizes = [8191, 4096, 7777, 16385];
  let firstSample = 0;
  let block = 0;
  while (firstSample < INPUT_RATE * 1.25) {
    const length = Math.min(blockSizes[block % blockSizes.length] ?? 4096, INPUT_RATE * 1.25 - firstSample);
    const I = new Float32Array(length);
    const Q = new Float32Array(length);
    generator(firstSample, INPUT_RATE, CENTER_HZ, I, Q);
    receiver.receiveSamples({ I, Q, frequency: CENTER_HZ });
    firstSample += length;
    block += 1;
  }
  return player.samples().subarray(Math.floor(AUDIO_RATE * 0.5));
}

function toneMagnitude(samples: Float32Array, frequencyHz: number): number {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const phase = 2 * Math.PI * frequencyHz * index / AUDIO_RATE;
    real += samples[index]! * Math.cos(phase);
    imaginary -= samples[index]! * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / samples.length;
}

describe("synthetic analog-mode fixtures through installed Signals DSP", () => {
  it("recovers an AM envelope tone across irregular input blocks", () => {
    const audio = recover(syntheticAm(CENTER_HZ + CARRIER_OFFSET_HZ, AUDIO_TONE_HZ), { mode: "AM", bandwidthHz: 12_000, squelch: 0 });
    expect(toneMagnitude(audio, AUDIO_TONE_HZ)).toBeGreaterThan(0.35);
  });

  it("recovers an NBFM audio tone across irregular input blocks", () => {
    const audio = recover(syntheticFm(CENTER_HZ + CARRIER_OFFSET_HZ, AUDIO_TONE_HZ, 5_000), { mode: "NBFM", bandwidthHz: 10_000, squelch: 0 });
    expect(toneMagnitude(audio, AUDIO_TONE_HZ)).toBeGreaterThan(0.45);
  });

  it.each(["USB", "LSB"] as const)("selects wanted %s and rejects the opposite sideband", (mode) => {
    const settings = { mode, bandwidthHz: 2_800, squelch: 0 };
    const wanted = recover(syntheticSideband(CENTER_HZ + CARRIER_OFFSET_HZ, AUDIO_TONE_HZ, mode), settings);
    const unwantedMode = mode === "USB" ? "LSB" : "USB";
    const unwanted = recover(syntheticSideband(CENTER_HZ + CARRIER_OFFSET_HZ, AUDIO_TONE_HZ, unwantedMode), settings);
    expect(toneMagnitude(wanted, AUDIO_TONE_HZ)).toBeGreaterThan(toneMagnitude(unwanted, AUDIO_TONE_HZ) * 8);
  });
});
