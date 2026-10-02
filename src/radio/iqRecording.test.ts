import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import type { Player } from "@jtarrio/signals/demod/player.js";
import { describe, expect, it } from "vitest";
import { createSignalsMode } from "./receiverConfig";
import {
  CU8_NORMALIZATION,
  decodeCu8,
  IqRecorder,
  parseRecording,
  recordingMetadataJson,
  validateRecordingMetadata,
  type IqRecording,
} from "./iqRecording";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { syntheticAm } from "../testing/syntheticModulation";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import { fftInPlace } from "../dsp/spectrumMath";

class CapturePlayer implements Player {
  readonly sampleRate = 48_000;
  private readonly chunks: Float32Array[] = [];
  play(left: Float32Array): void { this.chunks.push(new Float32Array(left)); }
  setVolume(_volume: number): void {}
  getVolume(): number { return 1; }
  samples(): Float32Array {
    const result = new Float32Array(this.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}

function magnitude(samples: Float32Array, frequencyHz: number): number {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const phase = 2 * Math.PI * frequencyHz * index / 48_000;
    real += (samples[index] ?? 0) * Math.cos(phase);
    imaginary -= (samples[index] ?? 0) * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / samples.length;
}

function demodAudio(recording: IqRecording, I: Float32Array, Q: Float32Array): Float32Array {
  const player = new CapturePlayer();
  const demodulator = new Demodulator({ player });
  demodulator.setSampleRate(recording.metadata.sampleRateHz);
  demodulator.setMode(createSignalsMode({ mode: "AM", bandwidthHz: 10_000, squelch: 0 }));
  demodulator.setFrequencyOffset(recording.metadata.selectedChannelFrequencyHz - recording.metadata.centerFrequencyHz);
  for (let sample = 0; sample < I.length; sample += 2047) {
    demodulator.receiveSamples({
      I: I.subarray(sample, Math.min(I.length, sample + 2047)),
      Q: Q.subarray(sample, Math.min(Q.length, sample + 2047)),
      frequency: recording.metadata.centerFrequencyHz,
    });
  }
  return player.samples();
}

function replayAudio(recording: IqRecording): Float32Array {
  const decoded = decodeCu8(recording.data);
  return demodAudio(recording, decoded.I, decoded.Q);
}

function sourceAudio(recording: IqRecording): Float32Array {
  const I = new Float32Array(recording.metadata.sampleCount);
  const Q = new Float32Array(recording.metadata.sampleCount);
  syntheticAm(recording.metadata.centerFrequencyHz + 6_000, 1_000)(0, recording.metadata.sampleRateHz, recording.metadata.centerFrequencyHz, I, Q);
  return demodAudio(recording, I, Q);
}

describe("BrowserSDR CU8 recording format", () => {
  it("rejects B205 SC16/VRT instead of mislabelling it as a legacy recording", () => {
    const details = usrpB205SessionDetails();
    expect(() => new IqRecorder({
      source: "usrp-b205", sessionGeneration: 1,
      requestedSampleRateHz: 2_400_000, actualSampleRateHz: 2_400_000,
      hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_000_000,
      mode: "AM", channelBandwidthHz: 10_000, squelch: 0, gainDb: null,
      sampleFormat: "planar-f32-iq-normalized", usrpB205: details,
    })).toThrow(/native CI16 recording path/);
  });
  it.each([
    { durationSeconds: 99 }, { source: "invalid" }, { stopReason: "invalid" },
    { squelch: -1 }, { gainDb: undefined }, { sampleRateHz: 1 },
    { channelBandwidthHz: 100_000 }, { selectedChannelFrequencyHz: 12_000_000 },
  ])("rejects incompatible metadata before starting replay: %j", (change) => {
    const fixture = createDeterministicRecordingFixture();
    expect(() => parseRecording(JSON.stringify({ ...fixture.metadata, ...change }), fixture.data)).toThrow();
  });

  it("rejects oversized input before copying and accepts ordered equal/end gaps", () => {
    const fixture = createDeterministicRecordingFixture();
    expect(() => validateRecordingMetadata(fixture.metadata, 33 * 1024 * 1024)).toThrow(/32 MiB/);
    fixture.metadata.knownGaps = [
      { afterSample: 0, missingSamples: 10, reason: "initial" },
      { afterSample: 0, missingSamples: null, reason: "unknown duration" },
      { afterSample: fixture.metadata.sampleCount, missingSamples: 20, reason: "end" },
    ];
    expect(parseRecording(recordingMetadataJson(fixture), fixture.data).metadata.knownGaps).toEqual(fixture.metadata.knownGaps);
  });
  it("round-trips exact sample bytes and required metadata", () => {
    const fixture = createDeterministicRecordingFixture(4096);
    const parsed = parseRecording(recordingMetadataJson(fixture), fixture.data.buffer as ArrayBuffer);
    expect(parsed.data).toEqual(fixture.data);
    expect(parsed.metadata.sampleRateHz).toBe(48_000);
    expect(parsed.metadata.centerFrequencyHz).toBe(10_000_000);
    expect(parsed.metadata.captureStartedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(parsed.metadata.normalization).toBe(CU8_NORMALIZATION);
    expect(parsed.metadata.provenance).toContain("deterministic generator");
  });

  it.each([
    "float = byte / 128 - 0.995",
    "float = (byte - 127.5) / 127.5",
  ])("rejects the removed CU8 normalization %s", (normalization) => {
    const fixture = createDeterministicRecordingFixture(32);
    expect(() => parseRecording(
      JSON.stringify({ ...fixture.metadata, normalization }),
      fixture.data,
    )).toThrow(/Unsupported recording encoding or normalization/);
  });

  it("keeps legacy metadata compatible and supplies validated SRD defaults", () => {
    const fixture = createDeterministicRecordingFixture(4096);
    expect(parseRecording(recordingMetadataJson(fixture), fixture.data).metadata.srd).toBeUndefined();
    const metadata = {
      ...fixture.metadata,
      mode: "SRD" as const,
      channelBandwidthHz: 32_000,
      squelch: 0,
    };
    // Avoid duplicating defaults in the fixture: the normalized recording path
    // supplies them when older SRD metadata omits the decoder-specific object.
    expect(validateRecordingMetadata(metadata, fixture.data.byteLength)).toMatchObject({
      mode: "SRD",
      srd: { modulation: "ook", protocol: "none" },
    });
  });

  it("stops exactly on an even bounded capacity without accepting more data", () => {
    const fixture = createDeterministicRecordingFixture(64);
    const recorder = new IqRecorder({
      source: "synthetic", sessionGeneration: 1, requestedSampleRateHz: 48_000, actualSampleRateHz: 48_000,
      hardwareCenterFrequencyHz: 10_000_000, selectedChannelFrequencyHz: 10_006_000,
      mode: "AM", channelBandwidthHz: 10_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized",
    }, "2026-09-08T00:00:00.000Z", 10);
    recorder.appendCu8(fixture.data);
    recorder.appendCu8(fixture.data);
    const result = recorder.finish();
    expect(result.data.byteLength).toBe(10);
    expect(result.metadata.sampleCount).toBe(5);
    expect(result.metadata.stopReason).toBe("capacity");
  });

  it.each([
    ["bad JSON", "{"],
    ["wrong format", JSON.stringify({ format: "float32" })],
  ])("rejects %s", (_name, metadata) => {
    expect(() => parseRecording(metadata, new Uint8Array(2))).toThrow();
  });

  it("rejects truncated I/Q frames and sample-count mismatches", () => {
    const fixture = createDeterministicRecordingFixture(32);
    expect(() => parseRecording(recordingMetadataJson(fixture), fixture.data.subarray(0, 3))).toThrow(/truncated/i);
    expect(() => parseRecording(recordingMetadataJson(fixture), fixture.data.subarray(0, 4))).toThrow(/mismatched/i);
  });

  it("preserves the RF carrier bin and decodes the generated 1 kHz AM audio tone", () => {
    const fixture = createDeterministicRecordingFixture();
    const decoded = decodeCu8(fixture.data);
    const size = 4096;
    const spectrumI = decoded.I.slice(0, size);
    const spectrumQ = decoded.Q.slice(0, size);
    fftInPlace(spectrumI, spectrumQ);
    let bestBin = 0;
    let best = 0;
    for (let bin = 0; bin < size; bin += 1) {
      const power = spectrumI[bin]! ** 2 + spectrumQ[bin]! ** 2;
      if (power > best) { best = power; bestBin = bin; }
    }
    const carrierHz = bestBin / size * fixture.metadata.sampleRateHz;
    expect(carrierHz).toBeCloseTo(6_000, -1);
    const audio = replayAudio(fixture).subarray(2_000);
    const source = sourceAudio(fixture).subarray(2_000);
    const replayMagnitude = magnitude(audio, 1_000);
    expect(replayMagnitude).toBeGreaterThan(0.2);
    expect(replayMagnitude).toBeCloseTo(magnitude(source, 1_000), 2);
  });
});
