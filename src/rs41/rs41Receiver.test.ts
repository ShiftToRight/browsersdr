import { describe, expect, it } from "vitest";
import {
  bytesFromHex,
  RS41_EXTENDED_FRAME_HEX,
  RS41_REAL_FRAME_HEX,
} from "./fixtures/referenceFrames";
import { Rs41Receiver } from "./rs41Receiver";
import {
  defaultRs41Configuration,
  validateRs41Configuration,
} from "./settings";
import { xorRs41Whitening } from "./whitening";

function bitsFromBytes(bytes: Uint8Array): number[] {
  return [...bytes].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (byte >>> bit) & 1),
  );
}

function generateIq(
  bits: number[],
  sampleRateHz: number,
  offsetHz: number,
): { I: Float32Array; Q: Float32Array } {
  const length = Math.ceil((bits.length * sampleRateHz) / 4800);
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  let phase = 0.91;
  for (let index = 0; index < length; index++) {
    const bit =
      bits[
        Math.min(bits.length - 1, Math.floor((index * 4800) / sampleRateHz))
      ]!;
    phase += (2 * Math.PI * (offsetHz + (bit ? 2300 : -2300))) / sampleRateHz;
    I[index] = 0.45 * Math.cos(phase);
    Q[index] = 0.45 * Math.sin(phase);
  }
  return { I, Q };
}

describe("RS41 selected-channel receiver", () => {
  it.each([1_024_000, 3_200_000] as const)("decodes offset RF across chunks at %i samples/s", (rate) => {
    const configuration = defaultRs41Configuration(rate, 9, 71_000);
    const receiver = new Rs41Receiver();
    receiver.configure(configuration);
    const onAir = xorRs41Whitening(bytesFromHex(RS41_REAL_FRAME_HEX));
    const preamble = Array.from({ length: 160 }, (_, index) => index & 1);
    const suffix = Array.from({ length: 800 }, (_, index) => index & 1);
    const iq = generateIq(
      [...preamble, ...bitsFromBytes(onAir), ...suffix],
      configuration.actualInputSampleRateHz,
      configuration.selectedChannelOffsetHz,
    );
    let offset = 0;
    for (const size of [1, 53, 8191, 777, 16_384, 29]) {
      if (offset >= iq.I.length) break;
      const end = Math.min(iq.I.length, offset + size);
      receiver.receive({
        I: iq.I.subarray(offset, end),
        Q: iq.Q.subarray(offset, end),
        generation: 9,
        firstSampleIndex: offset,
      });
      offset = end;
    }
    while (offset < iq.I.length) {
      const end = Math.min(iq.I.length, offset + 32_768);
      receiver.receive({
        I: iq.I.subarray(offset, end),
        Q: iq.Q.subarray(offset, end),
        generation: 9,
        firstSampleIndex: offset,
      });
      offset = end;
    }
    const snapshot = receiver.snapshot();
    expect(snapshot.value.sondes).toHaveLength(1);
    expect(snapshot.value.sondes[0]).toMatchObject({
      sondeId: "K1930293",
      lastFrameCounter: 5910,
    });
    expect(snapshot.value.sondes[0]!.track).toHaveLength(1);
    expect(snapshot.value.sondes[0]!.position?.altitudeMeters).toBeCloseTo(
      28_410.02,
      1,
    );
    expect(snapshot.value.counters.uncorrectedFrames).toBe(1);
    expect(snapshot.provenance.generation).toBe(9);

    const secondAir = xorRs41Whitening(bytesFromHex(RS41_EXTENDED_FRAME_HEX));
    const secondIq = generateIq(
      [...preamble, ...bitsFromBytes(secondAir), ...suffix],
      configuration.actualInputSampleRateHz,
      configuration.selectedChannelOffsetHz,
    );
    let secondOffset = 0;
    while (secondOffset < secondIq.I.length) {
      const end = Math.min(secondIq.I.length, secondOffset + 32_768);
      receiver.receive({
        I: secondIq.I.subarray(secondOffset, end),
        Q: secondIq.Q.subarray(secondOffset, end),
        generation: 9,
        firstSampleIndex: offset + secondOffset,
      });
      secondOffset = end;
    }
    const identities = receiver
      .snapshot()
      .value.sondes.map((sonde) => sonde.sondeId)
      .sort();
    expect(identities).toEqual(["K1930293", "K4020244"]);
    expect(receiver.snapshot().value.counters.correctedFrames).toBe(1);
  }, 20_000);

  it("rejects configuration/generation mismatches and clears partial RF state", () => {
    const configuration = defaultRs41Configuration(2_400_000, 3);
    expect(() =>
      validateRs41Configuration({
        ...configuration,
        outputSampleRateHz: 40_000,
      }),
    ).toThrow();
    const receiver = new Rs41Receiver();
    receiver.configure(configuration);
    expect(() =>
      receiver.receive({
        I: new Float32Array(2),
        Q: new Float32Array(2),
        generation: 2,
        firstSampleIndex: 0,
      }),
    ).toThrow(/generation/);
    receiver.reset();
    expect(receiver.snapshot().value.recentFrames).toHaveLength(0);
  });

  it("does not bridge a source gap into a frame or accept RF noise", () => {
    const configuration = defaultRs41Configuration(1_024_000, 11, -73_000);
    configuration.snapshotIntervalInputSamples = 1;
    const receiver = new Rs41Receiver();
    receiver.configure(configuration);
    const onAir = xorRs41Whitening(bytesFromHex(RS41_REAL_FRAME_HEX));
    const iq = generateIq(
      [
        ...Array.from({ length: 160 }, (_, index) => index & 1),
        ...bitsFromBytes(onAir),
      ],
      configuration.actualInputSampleRateHz,
      configuration.selectedChannelOffsetHz,
    );
    const middle = Math.floor(iq.I.length / 2);
    receiver.receive({
      I: iq.I.subarray(0, middle),
      Q: iq.Q.subarray(0, middle),
      generation: 11,
      firstSampleIndex: 0,
    });
    receiver.receive({
      I: iq.I.subarray(middle),
      Q: iq.Q.subarray(middle),
      generation: 11,
      firstSampleIndex: middle + 211,
    });
    expect(receiver.snapshot().value.counters.synchronizedFrames).toBe(0);

    const length = 200_000;
    const I = new Float32Array(length);
    const Q = new Float32Array(length);
    let state = 0x41c0ffee;
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      I[index] = ((state / 0xffffffff) * 2 - 1) * 0.03;
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      Q[index] = ((state / 0xffffffff) * 2 - 1) * 0.03;
    }
    receiver.receive({
      I,
      Q,
      generation: 11,
      firstSampleIndex: iq.I.length + 211,
      discontinuityBefore: {
        reason: "source-gap",
        missingInputSamples: 0,
      },
    });
    const snapshot = receiver.snapshot().value;
    expect(snapshot.counters.synchronizedFrames).toBe(0);
    expect(snapshot.sondes).toHaveLength(0);
  }, 20_000);
});
