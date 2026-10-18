import { describe, expect, it } from "vitest";
import { AisChannelDemodulator, AisReceiver, crc16X25 } from "./aisReceiver";

function write(bits: number[], start: number, length: number, value: number): void {
  for (let bit = 0; bit < length; bit += 1) bits[start + bit] = (value >> (length - bit - 1)) & 1;
}
function positionFrame(latitude = 48.14, mmsi = 211_234_567): Uint8Array {
  const bits = new Array<number>(168).fill(0);
  write(bits, 0, 6, 1); write(bits, 8, 30, mmsi); write(bits, 38, 4, 0); write(bits, 50, 10, 123);
  write(bits, 61, 28, Math.round(11.58 * 600_000)); write(bits, 89, 27, Math.round(latitude * 600_000)); write(bits, 116, 12, 875); write(bits, 128, 9, 88);
  const payload = new Uint8Array(21);
  for (let bit = 0; bit < bits.length; bit += 1) payload[bit >> 3] = (payload[bit >> 3] ?? 0) | (bits[bit]! << (7 - (bit & 7)));
  let crc = 0xffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  crc ^= 0xffff;
  return Uint8Array.from([...payload, crc & 0xff, crc >> 8]);
}

describe("AisReceiver", () => {
  it("validates FCS and decodes vessel position reports", () => {
    const frame = positionFrame();
    expect(crc16X25(frame)).toBe(0xf0b8);
    let latest: import("./aisReceiver").AisSnapshot | undefined;
    const receiver = new AisReceiver((value) => { latest = value; }, () => 5_000);
    receiver.receiveFrame(frame, "AIS 2");
    expect(latest?.frames).toBeGreaterThan(0);
    expect(latest?.validFrames).toBe(1);
    expect(latest?.targets[0]).toMatchObject({ mmsi: 211_234_567, speedKnots: 12.3, headingDegrees: 88, channel: "AIS 2" });
    expect(latest?.targets[0]?.latitude).toBeCloseTo(48.14, 4);
    expect(latest?.targets[0]?.longitude).toBeCloseTo(11.58, 4);
  });
  it.each([192_000, 3_200_000])("demodulates an HDLC frame from the AIS 1 RF channel at %i samples/s", sampleRate => {
    const frame = positionFrame();
    const flag = [0, 1, 1, 1, 1, 1, 1, 0];
    const payloadBits: number[] = [];
    let ones = 0;
    for (const byte of frame) for (let bit = 0; bit < 8; bit += 1) {
      const value = (byte >> bit) & 1; payloadBits.push(value);
      if (value) { ones += 1; if (ones === 5) { payloadBits.push(0); ones = 0; } } else ones = 0;
    }
    const training = Array.from({ length: 24 }, (_, index) => index & 1);
    const bits = [...training, ...flag, ...payloadBits, ...flag, 1, 1, 1];
    const levels: number[] = []; let level = 1;
    for (const bit of bits) { if (!bit) level = -level; levels.push(level); }
    const I = new Float32Array(Math.ceil(bits.length * sampleRate / 9600)), Q = new Float32Array(I.length);
    let phase = 0;
    for (let n = 0; n < I.length; n++) {
      phase += 2 * Math.PI * (-25_000 + levels[Math.min(bits.length - 1, Math.floor(n * 9600 / sampleRate))]! * 2400) / sampleRate;
      I[n] = Math.cos(phase); Q[n] = Math.sin(phase);
    }
    const decodedBits: number[] = [];
    new AisChannelDemodulator(-25_000, () => undefined, (bit) => decodedBits.push(bit)).receive({ I, Q, frequency: 162_000_000 }, sampleRate, 0);
    expect(decodedBits.join("").match(/01111110/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    let latest: import("./aisReceiver").AisSnapshot | undefined;
    const receiver = new AisReceiver((value) => { latest = value; }, () => 5_000);
    receiver.setSampleRate(sampleRate);
    receiver.receiveSamples({ I, Q, frequency: 162_000_000 });
    expect(latest?.frames).toBeGreaterThan(0);
    expect(latest?.validFrames).toBe(1);
    expect(latest?.targets[0]?.mmsi).toBe(211_234_567);
  });
});


it("retains FCS-valid distinct fixes, bounds history/targets and isolates published snapshots and resets", () => {
  let time = 1000, latest: import("./aisReceiver").AisSnapshot | undefined;
  const receiver = new AisReceiver((snapshot) => { latest = snapshot; }, () => time);
  receiver.receiveFrame(positionFrame());
  const held = latest!;
  time += 300; receiver.receiveFrame(positionFrame());
  expect(latest?.targets[0]?.track).toHaveLength(1);
  for (let i = 0; i < 40; i++) { time += 300; receiver.receiveFrame(positionFrame(49 + i / 100)); }
  expect(latest?.targets[0]?.track).toHaveLength(32);
  expect(held.targets[0]?.track).toHaveLength(1);
  expect(held.targets[0]?.latitude).toBeCloseTo(48.14);
  const corrupt = positionFrame(50); corrupt[10] = corrupt[10]! ^ 1;
  time += 300; receiver.receiveFrame(corrupt);
  expect(latest?.targets[0]?.track).toHaveLength(32);
  time += 601_000; receiver.receiveFrame(positionFrame(50));
  expect(latest?.targets[0]?.track).toHaveLength(1);
  for (let i = 0; i < 51; i++) { time += 300; receiver.receiveFrame(positionFrame(50, 211_000_000 + i)); }
  expect(latest?.targets).toHaveLength(50);
  receiver.reset();
  expect(latest?.targets).toEqual([]);
});
