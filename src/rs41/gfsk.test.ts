import { describe, expect, it } from "vitest";
import { decodeRs41Frame } from "./frame";
import { RS41_REAL_DISCRIMINATOR_PCM_BASE64 } from "./fixtures/realDiscriminatorCapture";
import { bytesFromHex, RS41_REAL_FRAME_HEX } from "./fixtures/referenceFrames";
import { Rs41GfskReceiver } from "./gfsk";
import { RS41_ON_AIR_SYNC, xorRs41Whitening } from "./whitening";

function onAirBits(frame: Uint8Array): number[] {
  return [...frame].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (byte >>> bit) & 1),
  );
}

function syntheticDiscriminator(
  bits: number[],
  sampleRateHz: number,
  options: {
    inverted?: boolean;
    carrierOffsetHz?: number;
    timingError?: number;
  } = {},
): Float32Array {
  const timing = 1 + (options.timingError ?? 0);
  const length = Math.ceil(((bits.length * sampleRateHz) / 4800) * timing);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const bitIndex = Math.min(
      bits.length - 1,
      Math.floor((index * 4800) / sampleRateHz / timing),
    );
    const bit = bits[bitIndex]! ^ (options.inverted ? 1 : 0);
    samples[index] = (options.carrierOffsetHz ?? 0) + (bit ? 2200 : -2200);
  }
  return samples;
}

const provenance = {
  generation: 1,
  firstInputSampleIndex: 0,
  lastInputSampleIndex: 1,
  actualInputSampleRateHz: 1_024_000,
  selectedChannelOffsetHz: 0,
};

describe("RS41 GFSK synchronization", () => {
  it.each([
    { inverted: false, carrierOffsetHz: 0, timingError: 0 },
    { inverted: true, carrierOffsetHz: 450, timingError: 0 },
    { inverted: false, carrierOffsetHz: 0, timingError: -0.002 },
  ])("handles polarity, carrier and timing case %#", (options) => {
    const onAir = xorRs41Whitening(bytesFromHex(RS41_REAL_FRAME_HEX));
    expect(onAir.subarray(0, 8)).toEqual(RS41_ON_AIR_SYNC);
    const bits = [
      ...Array(80)
        .fill(0)
        .map((_, index) => index & 1),
      ...onAirBits(onAir),
    ];
    const samples = syntheticDiscriminator(bits, 48_000, options);
    const receiver = new Rs41GfskReceiver(48_000, 4);
    const frames = receiver.process(samples, 0, 1);
    expect(
      frames.some((frame) =>
        xorRs41Whitening(frame.onAirBytes).every(
          (byte, index) => byte === bytesFromHex(RS41_REAL_FRAME_HEX)[index],
        ),
      ),
    ).toBe(true);
  });

  it("preserves state across arbitrary chunks", () => {
    const onAir = xorRs41Whitening(bytesFromHex(RS41_REAL_FRAME_HEX));
    const samples = syntheticDiscriminator(
      [
        ...Array(80)
          .fill(0)
          .map((_, index) => index & 1),
        ...onAirBits(onAir),
      ],
      60_000,
    );
    const receiver = new Rs41GfskReceiver(60_000, 4);
    const frames = [];
    let offset = 0;
    while (offset < samples.length) {
      const size = [1, 37, 409, 17, 2003][offset % 5]!;
      const end = Math.min(samples.length, offset + size);
      frames.push(
        ...receiver.process(samples.subarray(offset, end), offset, 1),
      );
      offset = end;
    }
    expect(frames).not.toHaveLength(0);
  });

  it("drops a partial capture on reset", () => {
    const onAir = xorRs41Whitening(bytesFromHex(RS41_REAL_FRAME_HEX));
    const samples = syntheticDiscriminator(
      [
        ...Array(80)
          .fill(0)
          .map((_, index) => index & 1),
        ...onAirBits(onAir),
      ],
      48_000,
    );
    const receiver = new Rs41GfskReceiver(48_000, 4);
    const middle = Math.floor(samples.length / 2);
    expect(receiver.process(samples.subarray(0, middle), 0, 1)).toHaveLength(0);
    receiver.reset();
    expect(receiver.process(samples.subarray(middle), middle, 1)).toHaveLength(
      0,
    );
  });

  it("plays back the independent real discriminator capture", () => {
    const pcm = Uint8Array.from(
      Buffer.from(RS41_REAL_DISCRIMINATOR_PCM_BASE64, "base64"),
    );
    const samples = Float32Array.from(pcm, (value) => value - 128);
    const frames = new Rs41GfskReceiver(48_000, 4).process(samples, 0, 1);
    expect(frames).not.toHaveLength(0);
    const decoded = frames.map((raw) =>
      decodeRs41Frame(
        xorRs41Whitening(raw.onAirBytes),
        provenance,
        raw.invertedPolarity,
      ),
    );
    expect(
      decoded.some(
        (frame) => frame.sondeId === "K1930308" && frame.frameCounter === 5047,
      ),
    ).toBe(true);
    expect(decoded.some((frame) => frame.invertedPolarity)).toBe(true);
  });
});
