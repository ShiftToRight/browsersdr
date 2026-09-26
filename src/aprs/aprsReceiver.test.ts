import { describe, expect, it } from "vitest";
import { AprsReceiver } from "./aprsReceiver";
import { buildUiFrame, encodedPacketBits } from "./fixtures/testSignal";
import {
  defaultAprsConfiguration,
  validateAprsConfiguration,
} from "./settings";

function generateIq(
  bits: number[],
  sampleRateHz: number,
  offsetHz: number,
  amplitude = 0.8,
): { I: Float32Array; Q: Float32Array } {
  const length = Math.ceil((bits.length * sampleRateHz) / 1200);
  const I = new Float32Array(length);
  const Q = new Float32Array(length);
  let tone = 1;
  let audioPhase = 0.73;
  let rfPhase = 1.91;
  for (let index = 0; index < length; index++) {
    const bitIndex = Math.min(
      bits.length - 1,
      Math.floor((index * 1200) / sampleRateHz),
    );
    if (
      index === Math.ceil((bitIndex * sampleRateHz) / 1200) &&
      bits[bitIndex] === 0
    )
      tone ^= 1;
    audioPhase += (2 * Math.PI * (tone ? 1200 : 2200)) / sampleRateHz;
    const deviation = 3200 * Math.sin(audioPhase);
    rfPhase += (2 * Math.PI * (offsetHz + deviation)) / sampleRateHz;
    I[index] = amplitude * Math.cos(rfPhase);
    Q[index] = amplitude * Math.sin(rfPhase);
  }
  return { I, Q };
}

describe("APRS selected-channel receiver", () => {
  it("decodes an end-to-end offset FM RF packet across block splits", () => {
    const configuration = defaultAprsConfiguration(1_024_000, 4, 83_000);
    configuration.stationExpiryInputSamples = 100_000;
    const receiver = new AprsReceiver();
    receiver.configure(configuration);
    const expected = "!4903.50N/07201.75W-End to end";
    const iq = generateIq(
      encodedPacketBits(buildUiFrame(expected), 32),
      configuration.actualInputSampleRateHz,
      configuration.selectedChannelOffsetHz,
      0.35,
    );
    let offset = 0;
    for (const size of [53, 8191, 1024, 33, 16384, 777]) {
      if (offset >= iq.I.length) break;
      const end = Math.min(iq.I.length, offset + size);
      receiver.receive({
        I: iq.I.subarray(offset, end),
        Q: iq.Q.subarray(offset, end),
        generation: 4,
        firstSampleIndex: offset,
      });
      offset = end;
    }
    while (offset < iq.I.length) {
      const end = Math.min(iq.I.length, offset + 32_768);
      receiver.receive({
        I: iq.I.subarray(offset, end),
        Q: iq.Q.subarray(offset, end),
        generation: 4,
        firstSampleIndex: offset,
      });
      offset = end;
    }
    const snapshot = receiver.snapshot();
    expect(snapshot.value.counters.validAx25Frames).toBeGreaterThan(0);
    expect(snapshot.value.stations[0]?.key).toBe("N0CALL-1");
    expect(snapshot.value.stations[0]?.position?.latitudeDegrees).toBeCloseTo(
      49.058333,
      5,
    );
    expect(snapshot.provenance.generation).toBe(4);

    receiver.receive({
      I: new Float32Array(120_001),
      Q: new Float32Array(120_001),
      generation: 4,
      firstSampleIndex: offset,
    });
    expect(receiver.snapshot().value.stations).toHaveLength(0);
  }, 20_000);

  it("rejects invalid configuration/generation and resets partial state", () => {
    const configuration = defaultAprsConfiguration(2_400_000, 2);
    expect(() =>
      validateAprsConfiguration({
        ...configuration,
        outputSampleRateHz: 44_100,
      }),
    ).toThrow();
    const receiver = new AprsReceiver();
    receiver.configure(configuration);
    expect(() =>
      receiver.receive({
        I: new Float32Array(2),
        Q: new Float32Array(2),
        generation: 1,
        firstSampleIndex: 0,
      }),
    ).toThrow(/generation/);
    receiver.reset();
    expect(receiver.snapshot().value.recentPackets).toHaveLength(0);
  });

  it("does not bridge a source gap into a packet or accept RF noise", () => {
    const configuration = defaultAprsConfiguration(1_024_000, 6, -67_000);
    configuration.snapshotIntervalInputSamples = 1;
    const receiver = new AprsReceiver();
    receiver.configure(configuration);
    const iq = generateIq(
      encodedPacketBits(buildUiFrame(">must not cross a gap"), 24),
      configuration.actualInputSampleRateHz,
      configuration.selectedChannelOffsetHz,
      0.5,
    );
    const middle = Math.floor(iq.I.length / 2);
    receiver.receive({
      I: iq.I.subarray(0, middle),
      Q: iq.Q.subarray(0, middle),
      generation: 6,
      firstSampleIndex: 0,
    });
    receiver.receive({
      I: iq.I.subarray(middle),
      Q: iq.Q.subarray(middle),
      generation: 6,
      firstSampleIndex: middle + 137,
    });
    expect(receiver.snapshot().value.counters.validAx25Frames).toBe(0);

    const length = 200_000;
    const I = new Float32Array(length);
    const Q = new Float32Array(length);
    let state = 0x5eed1234;
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      I[index] = ((state / 0xffffffff) * 2 - 1) * 0.03;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      Q[index] = ((state / 0xffffffff) * 2 - 1) * 0.03;
    }
    receiver.receive({
      I,
      Q,
      generation: 6,
      firstSampleIndex: iq.I.length + 137,
      discontinuityBefore: {
        reason: "source-gap",
        missingInputSamples: 0,
      },
    });
    expect(receiver.snapshot().value.counters.validAx25Frames).toBe(0);
    expect(receiver.snapshot().value.stations).toHaveLength(0);
  }, 20_000);
});
