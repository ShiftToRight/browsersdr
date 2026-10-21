import { expect, it } from "vitest";
import { PocsagDemodulator } from "./demodulator";
import { PocsagFramer, POCSAG_SYNC, type FramedMessage } from "./framing";
import { correctPocsagWord } from "./bch";
import { defaultPocsagSettings } from "./settings";
import { pocsagAudio, pocsagBits, wordBits } from "./fixtures/testSignal";

for (const rate of [512, 1200, 2400] as const)
  for (const clock of [60000, 64000])
    for (const offset of [-2000, 2000])
      for (const inverted of [false, true])
        it(`acquires minimum preamble at ${rate}/${clock}, offset ${offset}, inverted ${inverted}`, () => {
          // 576 alternating transmitted bits; ±2250 Hz deviation, ±250 Hz
          // deterministic discriminator noise. Offset approaches the deviation.
          const bits = pocsagBits("OFFSET ACQUISITION").slice(64);
          const audio = pocsagAudio(bits, rate, clock, inverted, offset);
          let seed = 0x12345678;
          for (let n = 0; n < audio.length; n++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
            audio[n] =
              (audio[n]! - offset) / 2 + offset + (seed / 2 ** 31) * 250;
          }
          const run = (chunk: number) => {
            const records: FramedMessage[] = [];
            const modem = new PocsagDemodulator(
              clock,
              defaultPocsagSettings(),
              clock,
              (m) => records.push(m),
            );
            for (let at = 0; at < audio.length; at += chunk)
              modem.process(audio.subarray(at, at + chunk), at, 1);
            modem.flush();
            return records;
          };
          const streamed = run(997);
          expect(streamed).toHaveLength(1);
          expect(streamed[0]).toMatchObject({
            rate,
            address: 123456,
            function: 3,
            text: "OFFSET ACQUISITION",
            complete: true,
            polarity: inverted ? "inverted" : "normal",
          });
          expect(streamed).toEqual(run(audio.length));
        });

it("rejects BCH-valid information at the required batch-sync position and reacquires a fresh burst", () => {
  const messages: FramedMessage[] = [];
  const framer = new PocsagFramer(1200, defaultPocsagSettings(), 1, (m) =>
    messages.push(m),
  );
  // Literal invalid boundary/address words from the pinned reference trace:
  // a valid BCH word is insufficient when the batch requires a sync word.
  const boundary = 0xffffffff;
  expect(correctPocsagWord(boundary)?.corrected).toBe(boundary);
  expect(correctPocsagWord(boundary)?.corrected).not.toBe(POCSAG_SYNC);
  const address = correctPocsagWord(0x29828c72)!;
  expect(((address.corrected >>> 13) & 0x3ffff) * 8).toBe(671968);
  const bits = [
    ...pocsagBits("VALID BATCH"),
    ...wordBits(boundary),
    ...wordBits(0x29828c72),
    ...wordBits(0x4c0c6247),
  ];
  bits.forEach((bit, n) => framer.push(bit, n));
  framer.end("eof");
  expect(framer.confirmed).toBe(false);
  expect(messages.map((m) => m.address)).toEqual([123456]);
  pocsagBits("RECOVERED", 123464).forEach((bit, n) =>
    framer.push(bit, bits.length + n),
  );
  expect(
    messages.map((m) => ({
      address: m.address,
      text: m.text,
      complete: m.complete,
    })),
  ).toEqual([
    { address: 123456, text: "VALID BATCH", complete: true },
    { address: 123464, text: "RECOVERED", complete: true },
  ]);
});
