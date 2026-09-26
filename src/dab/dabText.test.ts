import { expect, it } from "vitest";
import { decodeDabText } from "./dabText";

it("decodes the EBU repertoire including German and non-ASCII core characters", () => {
  expect(
    decodeDabText(Uint8Array.of(0xc1, 0x91, 0xd9, 0x99, 0x8d, 0xa9, 0x24), 0),
  ).toBe("ÀäÜüß€ł");
});
it("decodes UTF-8 and big-endian UCS-2 without displaying control codes", () => {
  expect(decodeDabText(new TextEncoder().encode("  München  "), 15)).toBe(
    "München",
  );
  expect(decodeDabText(Uint8Array.of(0, 0x41, 0, 0xfc), 6)).toBe("Aü");
  expect(decodeDabText(Uint8Array.of(0x41, 0, 0x42), 0)).toBe("A B");
  expect(decodeDabText(Uint8Array.of(0xff), 15)).toBeUndefined();
  expect(decodeDabText(Uint8Array.of(0x41), 3)).toBeUndefined();
});
