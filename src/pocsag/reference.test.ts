import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PocsagDemodulator } from "./demodulator";
import { defaultPocsagSettings } from "./settings";
import type { FramedMessage } from "./framing";
import { pocsagDisplayText } from "./characters";
// Explicit native-reference qualification, optional for installations without the
// separately pinned native tool/corpus. The reference runner supplies this path.
for (const rate of [512, 1200, 2400] as const)
  it.skipIf(!process.env.POCSAG_REFERENCE_DIR)(
    `pinned multimon-ng independent sample ${rate}`,
    () => {
      const dir = process.env.POCSAG_REFERENCE_DIR!;
      const bytes = readFileSync(join(dir, `${rate}.s16le`));
      const pcm = Float32Array.from(
        { length: bytes.length / 2 },
        (_, n) => bytes.readInt16LE(n * 2) / 32768,
      );
      const messages: FramedMessage[] = [];
      const m = new PocsagDemodulator(
        22050,
        { ...defaultPocsagSettings(), interpretation: "alpha" },
        22050,
        (x) => messages.push(x),
      );
      for (let n = 0; n < pcm.length; n += 313)
        m.process(pcm.subarray(n, n + 313), n, 1);
      m.flush();
      const expected = readFileSync(join(dir, `${rate}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              address: number;
              function: number;
              alpha?: string;
            },
        );
      // Intentional differential: native tracing shows 0xffffffff in the next
      // required batch-sync position, followed by the reference-only address.
      // BrowserSDR rejects that invalid framing (see acquisition.test.ts).
      // Assert both full lists; do not hide the extra native record.
      if (rate === 1200) {
        expect(expected).toEqual([
          {
            demod_name: "POCSAG1200",
            address: 273040,
            function: 3,
            alpha: "+++TIME=0008300324+++TIME=0008300324<NUL>",
          },
          { demod_name: "POCSAG1200", address: 671968, function: 1 },
        ]);
        expect(
          messages.map((m) => ({
            address: m.address,
            function: m.function,
            alpha: m.text,
            complete: m.complete,
          })),
        ).toEqual([
          {
            address: 273040,
            function: 3,
            alpha: "+++TIME=0008300324+++TIME=0008300324",
            complete: true,
          },
        ]);
        return;
      }
      expect(
        messages
          .filter((m) => m.complete)
          .map((m) => ({
            address: m.address,
            function: m.function,
            alpha: m.text,
          })),
      ).toEqual(
        expected
          .map((m) => ({
            ...m,
            alpha: pocsagDisplayText(m.alpha ?? ""),
            demod_name: undefined,
          }))
          .map((m) => ({
            address: m.address,
            function: m.function,
            alpha: m.alpha,
          })),
      );
    },
  );

const referenceCases = process.env.POCSAG_REFERENCE_DIR
  ? [
      "generated-512",
      "generated-1200",
      "generated-2400",
      "pocsag_clean",
      "pocsag_1bit",
      "pocsag_2bit",
      "pocsag_inv_clean",
      "pocsag_inv_1bit",
      "pocsag_inv_2bit",
    ]
  : [];
for (const id of referenceCases)
  it(`pinned reference generated/error vector ${id}`, () => {
    const dir = process.env.POCSAG_REFERENCE_DIR!;
    const bytes = readFileSync(join(dir, `${id}.s16le`));
    const pcm = Float32Array.from(
      { length: bytes.length / 2 },
      (_, n) => bytes.readInt16LE(n * 2) / 32768,
    );
    const records: FramedMessage[] = [];
    const modem = new PocsagDemodulator(
      22050,
      { ...defaultPocsagSettings(), interpretation: "alpha" },
      22050,
      (m) => records.push(m),
    );
    for (let n = 0; n < pcm.length; n += 997)
      modem.process(pcm.subarray(n, n + 997), n, 1);
    modem.flush();
    const expected = readFileSync(join(dir, `${id}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            address: number;
            function: number;
            alpha?: string;
          },
      );
    expect(
      records
        .filter((m) => m.complete)
        .map((m) => ({
          address: m.address,
          function: m.function,
          alpha: m.text,
        })),
    ).toEqual(
      expected.map((m) => ({
        address: m.address,
        function: m.function,
        alpha: pocsagDisplayText(m.alpha ?? ""),
      })),
    );
  });
