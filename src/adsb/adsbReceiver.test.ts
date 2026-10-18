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
  it.each([{ rate: 2_400_000, chunk: 37 }, ...[1, 7, 29, 37, 61, 512].map(chunk => ({ rate: 3_200_000, chunk }))])("recovers $rate samples/s frames across phases and $chunk-sample chunks", ({ rate, chunk }) => {
    const bytes = fromHex("8D4840D6202CC371C32CE0576098");
    for (const phase of [0, 1 / 12, 2 / 12, 3 / 12, 4 / 12, 5 / 12, 6 / 12]) {
      let latest: AdsbSnapshot | undefined;
      const receiver = new AdsbReceiver((value) => { latest = value; }, () => 1_000);
      receiver.setSampleRate(rate);
      const frame = pulseFrameAtRateAndPhase(bytes, rate, phase);
      for (let start = 0; start < frame.I.length; start += chunk) {
        receiver.receiveSamples({
          I: frame.I.subarray(start, start + chunk),
          Q: frame.Q.subarray(start, start + chunk),
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


it.each([[4, 7, "A7"], [4, 1, "A1"], [4, 3, "A3"], [3, 7, "B7"], [2, 1, "C1"], [1, 1, "D1"]])("parses CRC-valid identification category set %s / %s", (tc, category, expected) => {
  let latest: AdsbSnapshot | undefined;
  const receiver = new AdsbReceiver((snapshot) => { latest = snapshot; }, () => 1000);
  receiver.setSampleRate(2_000_000);
  const bytes = fromHex("8D4840D6202CC371C32CE0576098");
  bytes[4] = (Number(tc) << 3) | Number(category);
  receiver.receiveSamples(pulseFrame(appendCrc(bytes)));
  expect(latest?.targets[0]?.category).toBe(expected);
});

it("retains only new CPR fixes and clears history at reset or expired identity reuse", () => {
  let time = 1000, latest: AdsbSnapshot | undefined;
  const receiver = new AdsbReceiver((snapshot) => { latest = snapshot; }, () => time);
  receiver.setSampleRate(2_000_000);
  const even = pulseFrame(fromHex("8D40621D58C386435CC412692AD6"));
  const odd = pulseFrame(fromHex("8D40621D58C382D690C8AC2863A7"));
  receiver.receiveSamples(even);
  expect(latest?.targets[0]?.track).toEqual([]);
  time += 1000; receiver.receiveSamples(odd);
  const held = latest!;
  expect(held.targets[0]?.track).toHaveLength(1);
  time += 1000; receiver.receiveSamples(even);
  expect(latest?.targets[0]?.track).toHaveLength(2);
  expect(held.targets[0]?.track).toHaveLength(1);
  time += 1000; receiver.receiveSamples(even);
  expect(latest?.targets[0]?.track).toHaveLength(2);
  time += 121_000; receiver.receiveSamples(odd);
  expect(latest?.targets[0]?.track).toEqual([]);
  receiver.reset();
  expect(latest?.targets).toEqual([]);
});

function setField(
  bytes: Uint8Array,
  at: number,
  length: number,
  value: number,
) {
  for (let n = 0; n < length; n++) {
    const bit = at + n,
      mask = 1 << (7 - (bit & 7));
    bytes[bit >> 3] =
      (bytes[bit >> 3]! & ~mask) | ((value >> (length - n - 1)) & 1 ? mask : 0);
  }
}
function harness() {
  let time = 0,
    latest: AdsbSnapshot;
  const receiver = new AdsbReceiver(
    (s) => {
      latest = s;
    },
    () => time,
  );
  receiver.setSampleRate(2_000_000);
  return {
    receiver,
    get latest() {
      return latest!;
    },
    send(bytes: Uint8Array, delay = 1000) {
      time += delay;
      receiver.receiveSamples(pulseFrame(appendCrc(bytes)));
    },
  };
}

it("does not merge identical address bytes across DF18 sources or count unknown formats as decoded", () => {
  const h = harness();
  for (const first of [0x8d, 0x90, 0x91, 0x92, 0x95, 0x96, 0x93, 0x94, 0x97]) {
    const bytes = fromHex("8D4840D6202CC371C32CE0576098");
    bytes[0] = first;
    h.send(bytes);
  }
  expect(h.latest).toMatchObject({
    validFrames: 6,
    crcValidFrames: 9,
    unsupportedFrames: 3,
    rejectedFrames: 3,
  });
  expect(h.latest.targets).toHaveLength(6);
  expect(new Set(h.latest.targets.map((t) => t.id)).size).toBe(6);
  expect(h.latest.targets.filter((t) => t.icao !== null)).toHaveLength(2);
});

it("never pairs CPR across direct/rebroadcast origins, altitude kinds, surface or expired pairs", () => {
  for (const kind of ["origin", "altitude", "surface", "expired"]) {
    const h = harness(),
      even = fromHex("8D40621D58C386435CC412692AD6"),
      odd = fromHex("8D40621D58C382D690C8AC2863A7");
    h.send(even);
    if (kind === "origin") odd[0] = 0x90;
    if (kind === "altitude") setField(odd, 32, 5, 20);
    if (kind === "surface") setField(odd, 32, 5, 7);
    h.send(odd, kind === "expired" ? 11000 : 1000);
    expect(
      h.latest.targets.every(
        (t) => t.latitude === null && t.longitude === null,
      ),
      kind,
    ).toBe(true);
  }
});

it("clears unavailable velocity/altitude and expires position and version-qualified quality", () => {
  const h = harness();
  h.send(fromHex("8D40621D58C386435CC412692AD6"));
  h.send(fromHex("8D40621D58C382D690C8AC2863A7"));
  expect(h.latest.targets[0]?.latitude).not.toBeNull();
  const b = fromHex("8D40621D00000000000000000000");
  setField(b, 32, 5, 19);
  setField(b, 37, 3, 1);
  setField(b, 46, 10, 100);
  setField(b, 57, 10, 100);
  setField(b, 69, 9, 10);
  h.send(b);
  expect(h.latest.targets[0]?.groundSpeedKt).toBeGreaterThan(0);
  setField(b, 46, 10, 0);
  setField(b, 69, 9, 0);
  h.send(b);
  expect(h.latest.targets[0]).toMatchObject({
    groundSpeedKt: null,
    trackDegrees: null,
    verticalRateFpm: null,
  });
  const p = fromHex("8D40621D58C386435CC412692AD6");
  setField(p, 40, 12, 0);
  h.send(p);
  expect(h.latest.targets[0]?.altitudeFt).toBeNull();
  const q = fromHex("8D40621D00000000000000000000");
  setField(q, 32, 5, 31);
  setField(q, 72, 3, 2);
  setField(q, 76, 4, 9);
  h.send(q);
  expect(h.latest.targets[0]?.quality).toMatchObject({ version: 2, nacP: 9 });
  h.send(b, 31000);
  expect(h.latest.targets[0]).toMatchObject({
    latitude: null,
    longitude: null,
    positionStatus: "Position expired",
  });
  expect(h.latest.targets[0]?.quality).toBeUndefined();
});

it("shows surface movement but withholds ambiguous cold-start positions", () => {
  const h = harness();
  h.send(fromHex("8C4841753AAB238733C8CD4020B1"));
  h.send(fromHex("8C4841753A8A35323FAEBDAC702D"));
  expect(h.latest.targets[0]).toMatchObject({
    onGround: true,
    altitudeFt: null,
    latitude: null,
    longitude: null,
    surfaceSpeedRangeKt: [16, 17],
    trackDegrees: 98.4375,
    positionStatus: expect.stringContaining("recent airborne fix"),
  });
});

it("resolves surface pairs using only a fresh airborne fix from the same qualified target", () => {
  for (const delay of [1000, 61000]) {
    const h = harness();
    h.send(fromHex("8D40621D58C386435CC412692AD6"));
    h.send(fromHex("8D40621D58C382D690C8AC2863A7"));
    const even = fromHex("8C4841753AAB238733C8CD4020B1"),
      odd = fromHex("8C4841753A8A35323FAEBDAC702D");
    // Re-address published surface vectors to exercise a generated landing
    // sequence; this is not an independently observed aircraft trajectory.
    for (const b of [even, odd]) b.set([0x40, 0x62, 0x1d], 1);
    h.send(even, delay);
    h.send(odd);
    if (delay === 1000) {
      expect(h.latest.targets[0]?.latitude).toBeCloseTo(52.320607, 5);
      expect(h.latest.targets[0]?.longitude).toBeCloseTo(4.734735, 5);
      expect(h.latest.targets[0]?.positionStatus).toContain("Surface CPR");
    } else expect(h.latest.targets[0]?.latitude).toBeNull();
  }
});

it("keeps geometric height distinct from barometric altitude", () => {
  const h = harness();
  const even = fromHex("8D40621D58C386435CC412692AD6"),
    odd = fromHex("8D40621D58C382D690C8AC2863A7");
  setField(even, 32, 5, 20);
  setField(odd, 32, 5, 20);
  h.send(even);
  h.send(odd);
  expect(h.latest.targets[0]).toMatchObject({
    altitudeFt: null,
    geometricAltitudeFt: 38000,
  });
  expect(h.latest.targets[0]?.latitude).toBeCloseTo(52.2572, 3);
});

it("can maintain surface CPR beyond the initial airborne reference while valid fixes continue", () => {
  const h = harness();
  h.send(fromHex("8D40621D58C386435CC412692AD6")); h.send(fromHex("8D40621D58C382D690C8AC2863A7"));
  const even = fromHex("8C4841753AAB238733C8CD4020B1"), odd = fromHex("8C4841753A8A35323FAEBDAC702D");
  for (const b of [even, odd]) b.set([0x40, 0x62, 0x1d], 1);
  for (let n = 0; n < 40; n++) { h.send(even); h.send(odd); }
  expect(h.latest.targets[0]?.latitude).toBeCloseTo(52.320607, 5);
});
