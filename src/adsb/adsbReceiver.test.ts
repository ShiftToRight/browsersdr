import { describe, expect, it } from "vitest";
import { AdsbReceiver, modeSCrc, validateAdsbSampleRate, type AdsbSnapshot } from "./adsbReceiver";

function fromHex(hex: string): Uint8Array { return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16))); }
function pulseFrame(bytes: Uint8Array) {
  const I = new Float32Array(16 + bytes.length * 16);
  for (const position of [0, 2, 7, 9]) I[position] = 1;
  for (let bit = 0; bit < bytes.length * 8; bit += 1) I[16 + bit * 2 + (((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1) ? 0 : 1)] = 1;
  return { I, Q: new Float32Array(I.length), frequency: 1_090_000_000 };
}
function pulseFrameAtRate(bytes: Uint8Array, sampleRateHz: number) {
  const ideal = pulseFrame(bytes), length = Math.ceil(ideal.I.length * sampleRateHz / 2_000_000) + 2;
  const I = new Float32Array(length);
  for (let index = 0; index < length; index += 1) I[index] = ideal.I[Math.floor((index + 0.5) * 2_000_000 / sampleRateHz)] ?? 0;
  return { I, Q: new Float32Array(length), frequency: 1_090_000_000 };
}
function pulseFrameAtRateAndPhase(bytes: Uint8Array, sampleRateHz: number, phaseSamples: number) {
  const ideal = pulseFrame(bytes);
  const leadingSamples = 12;
  const offset = leadingSamples + phaseSamples;
  const length = Math.ceil(ideal.I.length * sampleRateHz / 2_000_000 + offset) + 4;
  const I = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const idealIndex = Math.floor((index + 0.5 - offset) * 2_000_000 / sampleRateHz);
    if (idealIndex >= 0) I[index] = ideal.I[idealIndex] ?? 0;
  }
  return { I, Q: new Float32Array(length), frequency: 1_090_000_000 };
}
function appendCrc(bytes: Uint8Array) {
  const result = bytes.slice();
  const crc = modeSCrc(result.subarray(0, result.length - 3));
  result[result.length - 3] = crc >> 16;
  result[result.length - 2] = crc >> 8;
  result[result.length - 1] = crc;
  return result;
}

describe("AdsbReceiver", () => {
  it("validates and decodes a real 1090ES identification frame", () => {
    const bytes = fromHex("8D4840D6202CC371C32CE0576098");
    expect(modeSCrc(bytes)).toBe(0);
    let latest: AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
    receiver.setSampleRate(2_000_000);
    receiver.receiveSamples(pulseFrame(bytes));
    expect(latest).toMatchObject({
      frames: 1,
      preamblesDetected: 1,
      crcValidFrames: 1,
      validFrames: 1,
      unsupportedFrames: 0,
      crcFailures: 0,
      ambiguousFrames: 0,
      rejectedFrames: 0,
    });
    expect(latest?.targets[0]).toMatchObject({ icao: "4840D6", callsign: "KLM1023" });
  });
  it("requires a rate capable of resolving Mode-S pulses", () => {
    expect(() => validateAdsbSampleRate(1_024_000)).toThrow(/2.0 MS\/s/);
  });
  it("resamples the RTL-SDR 2.4 MS/s rate before pulse slicing", () => {
    let latest: import("./adsbReceiver").AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
    receiver.setSampleRate(2_400_000);
    receiver.receiveSamples(pulseFrameAtRate(fromHex("8D4840D6202CC371C32CE0576098"), 2_400_000));
    expect(latest?.validFrames).toBe(1);
  });
  it("recovers a 2.4 MS/s frame across representative fractional phases and odd chunks", () => {
    const bytes = fromHex("8D4840D6202CC371C32CE0576098");
    for (const phase of [0, 1 / 12, 2 / 12, 3 / 12, 4 / 12, 5 / 12, 6 / 12]) {
      let latest: AdsbSnapshot | undefined;
      const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
      receiver.setSampleRate(2_400_000);
      const frame = pulseFrameAtRateAndPhase(bytes, 2_400_000, phase);
      for (let start = 0; start < frame.I.length; start += 37) {
        receiver.receiveSamples({
          I: frame.I.subarray(start, start + 37),
          Q: frame.Q.subarray(start, start + 37),
          frequency: frame.frequency,
        });
      }
      expect(latest?.validFrames, `phase ${phase}`).toBe(1);
      expect(latest?.crcValidFrames, `phase ${phase}`).toBe(1);
      expect(latest?.targets[0]).toMatchObject({ icao: "4840D6", messages: 1 });
    }
  });
  it("combines even and odd CPR frames into a global position", () => {
    let time = 1_000, latest: import("./adsbReceiver").AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => time);
    receiver.setSampleRate(2_000_000);
    receiver.receiveSamples(pulseFrame(fromHex("8D40621D58C386435CC412692AD6")));
    time = 2_000;
    receiver.receiveSamples(pulseFrame(fromHex("8D40621D58C382D690C8AC2863A7")));
    expect(latest?.targets[0]?.latitude).toBeCloseTo(52.2572, 3);
    expect(latest?.targets[0]?.longitude).toBeCloseTo(3.9194, 3);
  });
  it("does not turn deterministic receiver noise into CRC-valid frames", () => {
    let latest: AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
    receiver.setSampleRate(2_400_000);
    const I = new Float32Array(240_000), Q = new Float32Array(I.length);
    let state = 0x12345678;
    for (let index = 0; index < I.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      I[index] = ((state >>> 8) / 0x1000000 - 0.5) * 0.1;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      Q[index] = ((state >>> 8) / 0x1000000 - 0.5) * 0.1;
    }
    for (let start = 0; start < I.length; start += 8_191) {
      receiver.receiveSamples({ I: I.subarray(start, start + 8_191), Q: Q.subarray(start, start + 8_191), frequency: 1_090_000_000 });
    }
    expect(latest).toMatchObject({ validFrames: 0, crcValidFrames: 0 });
  });
  it("separates unsupported CRC-valid frames from CRC and timing failures", () => {
    let time = 1_000;
    let latest: AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => time);
    receiver.setSampleRate(2_000_000);

    const unsupported = appendCrc(Uint8Array.of(11 << 3, 0x48, 0x40, 0xd6, 0, 0, 0));
    expect(modeSCrc(unsupported)).toBe(0);
    receiver.receiveSamples(pulseFrame(unsupported));

    const badCrc = fromHex("8D4840D6202CC371C32CE0576098");
    badCrc[4] = badCrc[4]! ^ 1;
    time += 300;
    receiver.receiveSamples(pulseFrame(badCrc));

    const ambiguous = pulseFrame(fromHex("8D4840D6202CC371C32CE0576098"));
    ambiguous.I.fill(1, 16);
    time += 300;
    receiver.receiveSamples(ambiguous);

    expect(latest).toMatchObject({
      frames: 3,
      preamblesDetected: 3,
      crcValidFrames: 1,
      validFrames: 0,
      unsupportedFrames: 1,
      crcFailures: 1,
      ambiguousFrames: 1,
      rejectedFrames: 3,
    });
  });
});
