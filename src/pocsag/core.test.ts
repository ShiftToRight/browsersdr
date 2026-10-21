import { describe, it, expect } from "vitest";
import { correctPocsagWord, pocsagSyndrome } from "./bch";
import { PocsagFramer, type FramedMessage } from "./framing";
import { PocsagDemodulator } from "./demodulator";
import { defaultPocsagSettings, normalizePocsagSettings } from "./settings";
import {
  encodeWord,
  pocsagBits,
  pocsagAudio,
  wordBits,
} from "./fixtures/testSignal";
import { interpretPocsag } from "./characters";
import type { PocsagRate } from "./types";
describe("POCSAG extended BCH", () => {
  for (const word of [
    0x7a89c197,
    0x7cd215d8,
    encodeWord(0),
    encodeWord(0x1fffff),
    encodeWord(0x123456),
  ]) {
    it(`corrects every one/two-bit mask for ${word.toString(16)}`, () => {
      expect(pocsagSyndrome(word)).toBe(0);
      for (let a = 0; a < 32; a++) {
        const mask = 2 ** a;
        expect(correctPocsagWord(word ^ mask)).toEqual({
          corrected: word,
          mask: mask >>> 0,
          count: 1,
        });
        expect(correctPocsagWord(word ^ mask, 0)).toBeNull();
        for (let b = a + 1; b < 32; b++) {
          const pair = (mask ^ (2 ** b)) >>> 0;
          expect(correctPocsagWord(word ^ pair)).toEqual({
            corrected: word,
            mask: pair,
            count: 2,
          });
          expect(correctPocsagWord(word ^ pair, 1)).toBeNull();
        }
      }
    });
  }
  it("rejects all three-bit masks for a reference idle word", () => {
    for (let a = 0; a < 32; a++)
      for (let b = a + 1; b < 32; b++)
        for (let c = b + 1; c < 32; c++)
          expect(
            correctPocsagWord(0x7a89c197 ^ (2 ** a) ^ (2 ** b) ^ (2 ** c)),
          ).toBeNull();
  });
});
it("strictly validates portable settings", () => {
  expect(normalizePocsagSettings()).toEqual(defaultPocsagSettings());
  expect(() =>
    normalizePocsagSettings({ ...defaultPocsagSettings(), rate: 300 as 512 }),
  ).toThrow();
});
it("decodes every numeric symbol in transmitted LSB order", () => {
  const bits = Array.from({ length: 16 }, (_, value) =>
    Array.from({ length: 4 }, (_, n) => (value >>> n) & 1).join(""),
  ).join("");
  expect(interpretPocsag(bits, "numeric")).toBe("0123456789.U -][");
});
for (const address of [0, 7, 8, 123456, 2097151])
  it(`reconstructs address/frame and split characters ${address}`, () => {
    const messages: FramedMessage[] = [];
    const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
      messages.push(m),
    );
    pocsagBits("HELLO " + "LONG MESSAGE ".repeat(15), address).forEach(
      (bit, n) => f.push(bit, n),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      address,
      function: 3,
      complete: true,
      ending: "idle",
    });
    expect(messages[0]!.text).toBe("HELLO " + "LONG MESSAGE ".repeat(15));
  });
it("EOF/gaps do not fabricate completion or carry an address", () => {
  const messages: FramedMessage[] = [];
  const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    messages.push(m),
  );
  pocsagBits("INCOMPLETE", 123456, 3, false).forEach((bit, n) =>
    f.push(bit, n),
  );
  f.end("eof");
  expect(messages[0]).toMatchObject({
    complete: false,
    ending: "eof",
    address: 123456,
  });
  f.reset("source-gap");
  pocsagBits("AFTER GAP", 123464).forEach((bit, n) => f.push(bit, n + 5000));
  expect(messages.at(-1)).toMatchObject({
    address: 123464,
    text: "AFTER GAP",
    complete: true,
  });
});
it("late entry confirms a subsequent batch before publishing", () => {
  const messages: FramedMessage[] = [];
  const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    messages.push(m),
  );
  const bits = pocsagBits("MULTIBATCH ".repeat(20), 123456).slice(640);
  bits.forEach((bit, n) => f.push(bit, n));
  expect(messages[0]?.text).toBe("MULTIBATCH ".repeat(20));
});
it("does not accept one accidental sync with short noise", () => {
  const messages: FramedMessage[] = [];
  const f = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    messages.push(m),
  );
  [
    ...wordBits(0x7cd215d8),
    ...wordBits(encodeWord(1234)),
    ...wordBits(0x7a89c197),
  ].forEach((b, n) => f.push(b, n));
  f.end("eof");
  expect(messages).toEqual([]);
});
for (const rate of [512, 1200, 2400] as PocsagRate[])
  for (const sampleRate of [22050, 60000, 64000])
    it(`fractional modem ${rate} at ${sampleRate}`, () => {
      const messages: FramedMessage[] = [];
      const modem = new PocsagDemodulator(
        sampleRate,
        defaultPocsagSettings(),
        sampleRate,
        (m) => messages.push(m),
      );
      const audio = pocsagAudio(
        pocsagBits("MODEM CHECK", 123456),
        rate,
        sampleRate,
        true,
        1500,
        100,
      );
      for (let n = 0; n < audio.length; n += 997)
        modem.process(audio.subarray(n, n + 997), n, 1);
      modem.flush();
      expect(messages.find((m) => m.complete)).toMatchObject({
        rate,
        address: 123456,
        text: "MODEM CHECK",
        polarity: "inverted",
      });
    });
it("carrier and deterministic noise do not create messages", () => {
  const messages: FramedMessage[] = [];
  const m = new PocsagDemodulator(60000, defaultPocsagSettings(), 60000, (x) =>
    messages.push(x),
  );
  let seed = 19;
  const audio = Float32Array.from({ length: 600000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed / 2 ** 20;
  });
  m.process(audio, 0, 1);
  m.flush();
  expect(messages).toEqual([]);
});
