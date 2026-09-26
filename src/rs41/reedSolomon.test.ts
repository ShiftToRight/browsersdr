import { describe, expect, it } from "vitest";
import {
  bytesFromHex,
  RS41_EXTENDED_FRAME_HEX,
  RS41_REAL_FRAME_HEX,
} from "./fixtures/referenceFrames";
import {
  correctRs41Frame,
  decodeRs41Codeword,
  rs41Syndromes,
} from "./reedSolomon";

describe("RS41 Reed-Solomon", () => {
  it("matches the independent real-frame codewords", () => {
    const frame = bytesFromHex(RS41_REAL_FRAME_HEX);
    expect(frame).toHaveLength(320);
    const result = correctRs41Frame(frame);
    expect(result.status).toBe("uncorrected");
    expect(result.correctedErrors).toBe(0);
    expect(result.frame).toEqual(frame);
  });

  it("verifies the independent extended-frame interleave", () => {
    const frame = bytesFromHex(RS41_EXTENDED_FRAME_HEX);
    expect(frame).toHaveLength(518);
    expect(correctRs41Frame(frame)).toMatchObject({
      status: "corrected",
      correctedErrors: 2,
    });
  });

  it("corrects twelve symbols in either interleave and rejects thirteen", () => {
    const clean = bytesFromHex(RS41_REAL_FRAME_HEX);
    const correctable = clean.slice();
    for (let index = 0; index < 12; index++)
      correctable[56 + index * 2] =
        correctable[56 + index * 2]! ^ (0x31 + index);
    const corrected = correctRs41Frame(correctable);
    expect(corrected.status).toBe("corrected");
    expect(corrected.correctedErrors).toBe(12);
    expect(corrected.frame).toEqual(clean);

    const rejected = clean.slice();
    for (let index = 0; index < 13; index++)
      rejected[56 + index * 2] = rejected[56 + index * 2]! ^ (0x51 + index);
    expect(correctRs41Frame(rejected).status).toBe("rejected");
  });

  it("rejects arbitrary non-codewords", () => {
    const bad = Uint8Array.from({ length: 255 }, (_, index) => index ^ 0xa5);
    expect(rs41Syndromes(bad).some((value) => value !== 0)).toBe(true);
    expect(decodeRs41Codeword(bad).status).toBe("rejected");
  });
});
