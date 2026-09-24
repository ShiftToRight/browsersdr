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

describe("AdsbReceiver", () => {
  it("validates and decodes a real 1090ES identification frame", () => {
    const bytes = fromHex("8D4840D6202CC371C32CE0576098");
    expect(modeSCrc(bytes)).toBe(0);
    let latest: AdsbSnapshot | undefined;
    const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
    receiver.setSampleRate(2_000_000);
    receiver.receiveSamples(pulseFrame(bytes));
    expect(latest?.validFrames).toBe(1);
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
});
