import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ChannelCaptureFilter, planChannelCapture } from "./channelRecording";
import { RecordingConvolver, recordingKernels } from "./recordingConvolver";
import { RECORDING_CONVOLVER } from "./recordingConvolverBytes";

function noise(length: number, initial = 0x6ad42f01): Float32Array {
  let seed = initial;
  return Float32Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  });
}
function compare(actual: Float32Array, expected: Float32Array) {
  expect(actual.length).toBe(expected.length);
  let maximum = 0,
    ci8 = 0,
    ci16 = 0;
  const quantize = (value: number, scale: number) =>
    Math.max(-scale, Math.min(scale - 1, Math.round(value * scale)));
  for (let n = 0; n < actual.length; n++) {
    maximum = Math.max(maximum, Math.abs(actual[n]! - expected[n]!));
    ci8 = Math.max(
      ci8,
      Math.abs(quantize(actual[n]!, 128) - quantize(expected[n]!, 128)),
    );
    ci16 = Math.max(
      ci16,
      Math.abs(quantize(actual[n]!, 32768) - quantize(expected[n]!, 32768)),
    );
  }
  expect(maximum).toBeLessThan(1e-6);
  expect(ci8).toBeLessThanOrEqual(1);
  expect(ci16).toBeLessThanOrEqual(1);
}
it("preserves the original half-band output bytes at vector and tail boundaries", () => {
  // Captured from the original WAT (SHA-256
  // 190c8b2459f445f4889b468d2af60eb7321e5f089112c7b81e53420e94d1cfbc).
  const hash = createHash("sha256");
  for (const taps of [15, 31, 95]) {
    const coefficients = new Float32Array(taps);
    for (let n = 0; n < (taps - 1) / 2; n += 2)
      coefficients[n] = coefficients[taps - 1 - n] =
        ((n % 4 ? -1 : 1) * (n + 1)) / 128;
    coefficients[(taps - 1) / 2] = 0.5;
    const kernel = new RecordingConvolver();
    kernel.setCoefs(coefficients);
    for (const count of [0, 1, 2, 3, 4, 5, 7, 137, 4095, 16384])
      for (const skip of [0, 1]) {
        const output = kernel.halfBand(
          noise(count * 2 + taps - 1),
          count,
          skip,
        );
        hash.update(
          new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
        );
      }
  }
  expect(hash.digest("hex")).toBe(
    "8d10880ce7aeb8a02f83f039ec8a892cac3e0b186bd62abede05167f465c649e",
  );
});
it("preserves original FIR output bytes for specialized and generic kernels", () => {
  // Same original WAT as the half-band reference above; 50 complete outputs.
  const hash = createHash("sha256");
  for (const taps of [1, 8, 16, 48, 95]) {
    const coefficients = noise(taps);
    for (let n = 0; n <= Math.floor(taps / 2); n++)
      coefficients[taps - 1 - n] = coefficients[n]! / taps;
    for (let n = 0; n < Math.floor(taps / 2); n++)
      coefficients[n] = coefficients[taps - 1 - n]!;
    const kernel = new RecordingConvolver();
    kernel.setCoefs(coefficients);
    for (const count of [0, 1, 2, 3, 4, 5, 7, 137, 4095, 32768]) {
      const output = kernel.convolveWithStride(
        noise(count + taps - 1),
        count,
        1,
        0,
      );
      hash.update(
        new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
      );
    }
  }
  expect(hash.digest("hex")).toBe(
    "cccaf132f370299d16d476f51cb8c81f98e275a47f46555cbd78d7b62f5fb1dd",
  );
});
it.each([1, 8, 16, 48, 95])(
  "matches independent full scalar %i-tap convolution at vector, tail and maximum boundaries",
  (taps) => {
    const coefficients = noise(taps);
    for (let n = 0; n <= Math.floor(taps / 2); n++)
      coefficients[taps - 1 - n] = coefficients[n]! / taps;
    for (let n = 0; n < Math.floor(taps / 2); n++)
      coefficients[n] = coefficients[taps - 1 - n]!;
    const kernel = new RecordingConvolver();
    kernel.setCoefs(coefficients);
    for (const count of [0, 1, 2, 3, 4, 5, 7, 137, 4095, 32768]) {
      const input = noise(count + taps - 1),
        original = input.slice();
      const reference = Float32Array.from({ length: count }, (_, n) => {
        let sum = 0;
        for (let t = 0; t < taps; t++) sum += input[n + t]! * coefficients[t]!;
        return sum;
      });
      compare(kernel.convolveWithStride(input, count, 1, 0), reference);
      expect(input).toEqual(original);
    }
  },
);
it("rejects invalid kernels, layouts and lengths and cannot grow memory", () => {
  const kernel = new RecordingConvolver();
  for (const coefficients of [
    new Float32Array(),
    new Float32Array(96),
    Float32Array.of(NaN),
    Float32Array.of(Infinity),
  ])
    expect(() => recordingKernels.fir(coefficients)).toThrow(/finite/);
  for (const coefficients of [
    new Float32Array(),
    new Float32Array(96),
    Float32Array.of(1, 2),
    Float32Array.of(NaN),
    Float32Array.of(Infinity),
  ])
    expect(() => kernel.setCoefs(coefficients)).toThrow(/symmetric/);
  expect(() => kernel.convolveWithStride(new Float32Array(), 0, 1, 0)).toThrow(
    /bounded/,
  );
  kernel.setCoefs(Float32Array.of(1));
  for (const count of [-1, 0.5, NaN, 32769])
    expect(() =>
      kernel.convolveWithStride(new Float32Array(1), count, 1, 0),
    ).toThrow(/bounded/);
  expect(() => kernel.convolveWithStride(new Float32Array(2), 1, 1, 0)).toThrow(
    /bounded/,
  );
  expect(() => kernel.convolveWithStride(new Float32Array(1), 1, 2, 0)).toThrow(
    /bounded/,
  );
  expect(() => kernel.convolveWithStride(new Float32Array(1), 1, 1, 1)).toThrow(
    /bounded/,
  );
  expect(() => kernel.halfBand(new Float32Array(1), 0, 0)).toThrow(/half-band/);
  const halfBand = new Float32Array(15);
  halfBand[7] = 1;
  kernel.setCoefs(halfBand);
  expect(() => kernel.halfBand(new Float32Array(15), 1, 2)).toThrow(
    /half-band/,
  );
  expect(() => kernel.halfBand(new Float32Array(15), 2, 0)).toThrow(
    /half-band/,
  );
  expect(() => kernel.halfBand(new Float32Array(32768 + 15), 16384, 0)).toThrow(
    /half-band/,
  );
  const partial = kernel.halfBand(
    Float32Array.from({ length: 15 }, (_, n) => n),
    1,
    0,
  );
  expect(partial).toEqual(Float32Array.of(7));
  const memory = new WebAssembly.Instance(
    new WebAssembly.Module(RECORDING_CONVOLVER),
  ).exports.memory as WebAssembly.Memory;
  expect(memory.buffer.byteLength).toBe(5 * 65536);
  expect(() => memory.grow(1)).toThrow();
});
it.each([
  { rate: 1_024_000, offset: 100_000, bandwidth: 15_000, mode: "AM" },
  { rate: 2_400_000, offset: 0, bandwidth: 1_171, mode: "USB" },
  { rate: 2_400_000, offset: 0, bandwidth: 1_536_000, mode: "DAB" },
  { rate: 3_200_000, offset: -37_000, bandwidth: 15_000, mode: "APRS" },
  { rate: 4_800_000, offset: -800_000, bandwidth: 1_536_000, mode: "DAB" },
  { rate: 9_600_000, offset: 1_000_000, bandwidth: 1_536_000, mode: "DAB" },
  { rate: 19_200_000, offset: 0, bandwidth: 1_536_000, mode: "DAB" },
  { rate: 19_200_000, offset: 7_000_000, bandwidth: 1_536_000, mode: "DAB" },
] as const)(
  "preserves complete channel filtering, odd history and gap reset at $rate / $offset ($mode, $bandwidth Hz)",
  ({ rate, offset, bandwidth, mode }) => {
    const plan = planChannelCapture({
      actualSampleRateHz: rate,
      hardwareCenterFrequencyHz: 100_000_000,
      selectedChannelFrequencyHz: 100_000_000 + offset,
      channelBandwidthHz: bandwidth,
      mode,
    });
    const original = new ChannelCaptureFilter(plan),
      fast = new ChannelCaptureFilter(plan, recordingKernels);
    for (let pass = 0; pass < 2; pass++) {
      for (const count of [1, 3, 4095, 32768, 137, 2]) {
        const I = noise(count),
          Q = noise(count, 0x19a17f9a);
        const untouchedI = I.slice(),
          untouchedQ = Q.slice();
        const expected = original.process(I, Q),
          actual = fast.process(I, Q);
        compare(actual.I, expected.I);
        compare(actual.Q, expected.Q);
        expect(I).toEqual(untouchedI);
        expect(Q).toEqual(untouchedQ);
      }
      original.reset();
      fast.reset();
    }
  },
);
