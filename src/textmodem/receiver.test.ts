import { describe, expect, it } from "vitest";
import { TextModemCore } from "./receiver";
import {
  defaultTextModemSettings,
  textModemConfiguration,
  type TextMode,
} from "./settings";
import { textModemSignal } from "../testing/textModemSignal";
import {
  AcarsFramer,
  RttyFramer,
  SitorFramer,
  VaricodeFramer,
  type FramedOutput,
  type ModemCallbacks,
} from "./framing";
import { acarsBytes, navtexWords } from "../testing/textModemSignal";

function callbacks() {
  const text: string[] = [],
    messages: FramedOutput[] = [];
  let errors = 0,
    corrections = 0;
  const cb: ModemCallbacks = {
    character: (c) => text.push(c),
    message: (m) => messages.push(m),
    error: () => errors++,
    corrected: () => corrections++,
  };
  return {
    cb,
    text,
    messages,
    get errors() {
      return errors;
    },
    get corrections() {
      return corrections;
    },
  };
}
const bitstream = (
  bytes: number[],
  bits: number,
  push: (bit: number) => void,
) =>
  bytes.forEach((byte) => {
    for (let n = 0; n < bits; n++) push((byte >> n) & 1);
  });
function receive(
  mode: TextMode,
  rate = 1_024_000,
  options: Parameters<typeof textModemSignal>[3] = {},
  chunk = 8192,
) {
  const text =
    mode === "NAVTEX"
      ? "ZCZC AB01\nTEST 123\nNNNN"
      : mode === "ACARS"
        ? "TEST FLIGHT"
        : "CQ TEST 123\n";
  const configuration = textModemConfiguration(
    mode,
    options.settings,
    rate,
    7,
    37_000,
  );
  const signal = textModemSignal(mode, text, rate, options);
  const receiver = new TextModemCore();
  receiver.configure(configuration);
  for (let n = 0; n < signal.I.length; n += chunk)
    receiver.receive({
      I: signal.I.subarray(n, n + chunk),
      Q: signal.Q.subarray(n, n + chunk),
      generation: 7,
      firstSampleIndex: n,
    });
  receiver.flush();
  return { state: receiver.snapshot().value, text, receiver, signal };
}
describe("text modem protocol references", () => {
  it("decodes the fixed ITA2 A, figures 123 and letters E wire vector", () => {
    const f = callbacks(),
      r = new RttyFramer(defaultTextModemSettings(), f.cb);
    const symbols = [
      ...Array(3).fill(1),
      ...[3, 27, 23, 19, 1, 31, 1].flatMap((code) => [
        0,
        ...Array.from({ length: 5 }, (_, bit) => (code >> bit) & 1),
        1,
        1,
      ]),
    ];
    for (const value of symbols)
      for (let n = 0; n < 20; n++) r.push(Boolean(value));
    expect(f.text.join("")).toBe("A123E");
  });
  it("decodes fixed BPSK31 Varicode assignments with double-zero delimiters", () => {
    const f = callbacks(),
      r = new VaricodeFramer(f.cb);
    for (const bit of "111110100111010110011100") r.push(Number(bit));
    expect(f.text.join("")).toBe("ABo");
  });
  it("phases SITOR-B, recovers one damaged copy and assembles complete NAVTEX", () => {
    const f = callbacks(),
      r = new SitorFramer(f.cb);
    const words = navtexWords("ZCZC AB01\nTEST\nNNNN");
    words[52] = 0;
    bitstream(words, 7, (b) => r.push(b));
    expect(f.messages[0]?.text).toBe("ZCZC AB01\nTEST\nNNNN");
    expect(f.corrections).toBeGreaterThan(0);
    expect(f.messages[0]?.complete).toBe(true);
  });
  it("requires ACARS CRC and odd parity and preserves reported address/label", () => {
    const f = callbacks(),
      r = new AcarsFramer(f.cb);
    const bytes = acarsBytes("TEST");
    bitstream(bytes, 8, (b) => r.push(b));
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({
      text: "TEST",
      address: ".N123AB",
      label: "H1",
    });
    bytes[50]! ^= 1;
    bitstream(bytes, 8, (b) => r.push(b));
    expect(f.messages).toHaveLength(1);
  });
});
describe("generated selected-channel text RF", () => {
  for (const mode of ["RTTY", "PSK31", "NAVTEX", "ACARS"] as const)
    it(`${mode} decodes at nonzero offset through I/Q reduction`, () => {
      const { state, text } = receive(mode);
      expect(state.text).toContain(text);
      expect(state.messages.length).toBeGreaterThan(0);
    }, 20000);
});

describe("text modem impairment and lifecycle checks", () => {
  for (const mode of ["RTTY", "PSK31", "NAVTEX", "ACARS"] as const)
    it(`${mode} handles 2.4 MS/s, irregular blocks, carrier phase and noise`, () => {
      const { state, text } = receive(
        mode,
        2_400_000,
        {
          noise: 0.04,
          phase: 1.7,
          driftHz: mode === "PSK31" ? 3 : mode === "ACARS" ? 250 : 8,
        },
        32749,
      );
      expect(state.text).toContain(text);
      expect(
        state.messages.every(
          (m) =>
            m.provenance.actualInputSampleRateHz === 2_400_000 &&
            m.provenance.selectedChannelOffsetHz === 37_000 &&
            m.provenance.generation === 7,
        ),
      ).toBe(true);
    }, 20000);
  it("RTTY supports amateur timing, reverse polarity and fine tuning", () => {
    const { state, text } = receive("RTTY", 1_024_000, {
      settings: {
        ...defaultTextModemSettings(),
        baud: 45.45,
        shiftHz: 170,
        inverted: true,
        tuningOffsetHz: 1200,
      },
      clockScale: 1.002,
      noise: 0.03,
    });
    expect(state.text).toContain(text);
  }, 20000);
  it("rejects invalid reconfiguration atomically and stale generations", () => {
    const { receiver } = receive("RTTY");
    const before = receiver.snapshot();
    expect(() =>
      receiver.configure({
        ...textModemConfiguration("RTTY", undefined, 1_024_000, 8, 0),
        settings: { ...defaultTextModemSettings(), baud: 100 as 50 },
      }),
    ).toThrow();
    expect(receiver.snapshot()).toEqual(before);
    expect(() =>
      receiver.receive({
        I: new Float32Array(2),
        Q: new Float32Array(2),
        generation: 6,
        firstSampleIndex: 0,
      }),
    ).toThrow(/generation/);
    receiver.dispose();
    expect(() =>
      receiver.configure(
        textModemConfiguration("RTTY", undefined, 1_024_000, 8, 0),
      ),
    ).toThrow(/disposed/);
  });
  it("cannot stitch an ACARS frame across declared and inferred input gaps", () => {
    const signal = textModemSignal("ACARS", "TEST FLIGHT", 1_024_000);
    const split = Math.floor(signal.I.length * 0.5);
    for (const declared of [false, true]) {
      const r = new TextModemCore();
      r.configure(
        textModemConfiguration("ACARS", undefined, 1_024_000, 9, 37_000),
      );
      r.receive({
        I: signal.I.subarray(0, split),
        Q: signal.Q.subarray(0, split),
        generation: 9,
        firstSampleIndex: 0,
      });
      r.receive({
        I: signal.I.subarray(split),
        Q: signal.Q.subarray(split),
        generation: 9,
        firstSampleIndex: split + 100,
        ...(declared
          ? {
              discontinuityBefore: {
                reason: "source-gap" as const,
                missingInputSamples: 100,
              },
            }
          : {}),
      });
      r.flush();
      expect(r.snapshot().value.messages).toHaveLength(0);
      expect(r.snapshot().value.counters.discontinuities).toBe(1);
    }
  });
});

it("does not call phasing without REP, and preserves an ambiguous valid FEC pair as an erasure", () => {
  const f = callbacks(),
    framer = new SitorFramer(f.cb);
  bitstream(Array(30).fill(0x0f), 7, (bit) => framer.push(bit));
  expect(f.text).toHaveLength(0);
  const words = navtexWords("ZCZC AB01\nTEST\nNNNN");
  words[66] = 0x56;
  bitstream(words, 7, (bit) => framer.push(bit));
  expect(f.messages[0]?.text).toContain("�EST");
  expect(f.messages[0]?.integrity).toContain("1 erasures");
});
