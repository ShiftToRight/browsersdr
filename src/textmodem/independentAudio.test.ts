import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { AcarsMskDemodulator } from "./msk";
import { AcarsFramer, type FramedOutput } from "./framing";
const root = new URL("./fixtures/acarsdec-test.wav", import.meta.url);
describe("pinned independent ACARS audio", () => {
  it("decodes the upstream audio separately from generated RF", () => {
    const bytes = readFileSync(root);
    let offset = 12;
    let channels = 0,
      rate = 0;
    let data = Buffer.alloc(0);
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      const id = bytes.toString("ascii", offset, offset + 4);
      if (id === "fmt ") {
        channels = bytes.readUInt16LE(offset + 10);
        rate = bytes.readUInt32LE(offset + 12);
      }
      if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    const all: FramedOutput[] = [];
    for (let channel = 0; channel < channels; channel++) {
      const frames = Array.from(
        { length: 10 },
        () =>
          new AcarsFramer({
            character: () => {},
            error: () => {},
            corrected: () => {},
            message: (m) => all.push(m),
          }),
      );
      const modem = new AcarsMskDemodulator(rate, (bit, phase) => {
        frames[2 * phase]!.push(bit);
        frames[2 * phase + 1]!.push(1 - bit);
      });
      for (let n = channel * 2; n < data.length; n += channels * 2)
        modem.push(data.readInt16LE(n) / 32768);
    }
    expect(all.find((m) => m.address === ".F-GTAE")).toMatchObject({
      label: "H1",
      header: "Mode G · ACK NAK · block 3",
      text: expect.stringContaining(
        "D65CAF7728#DFB00000/V206,05,124,183,02,00,00000/",
      ),
    });
    expect(all.length).toBeGreaterThan(0);
  });
});
