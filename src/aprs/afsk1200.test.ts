import { describe, expect, it } from "vitest";
import { Bell202Receiver } from "./afsk1200";
import { hasValidAx25Fcs } from "./ax25";
import {
  buildUiFrame,
  encodedPacketBits,
  generateAfsk,
} from "./fixtures/testSignal";

describe("Bell 202 receiver", () => {
  it.each([
    { phase: 0.17, frequencyOffsetHz: 0, timingError: 0, noise: 0 },
    { phase: 2.2, frequencyOffsetHz: 35, timingError: 0, noise: 0.08 },
    { phase: 5.7, frequencyOffsetHz: 0, timingError: -0.002, noise: 0.08 },
  ])("decodes arbitrary phase and representative impairment %#", (options) => {
    const frame = buildUiFrame("!4903.50N/07201.75W-Test");
    const samples = generateAfsk(encodedPacketBits(frame), 48_000, options);
    const receiver = new Bell202Receiver(48_000);
    const decoded = receiver.process(samples, 0, 1);
    expect(
      decoded.some(
        (candidate) =>
          hasValidAx25Fcs(candidate.bytes) &&
          candidate.bytes.length === frame.length,
      ),
    ).toBe(true);
  });

  it("is invariant to arbitrary block splits", () => {
    const frame = buildUiFrame(">split test");
    const samples = generateAfsk(encodedPacketBits(frame), 60_000, {
      phase: 1.1,
    });
    const receiver = new Bell202Receiver(60_000);
    const decoded = [];
    let offset = 0;
    for (const size of [1, 17, 503, 29, 4096, 7, 877]) {
      if (offset >= samples.length) break;
      const end = Math.min(samples.length, offset + size);
      decoded.push(
        ...receiver.process(samples.subarray(offset, end), offset, 1),
      );
      offset = end;
    }
    while (offset < samples.length) {
      const end = Math.min(samples.length, offset + 313);
      decoded.push(
        ...receiver.process(samples.subarray(offset, end), offset, 1),
      );
      offset = end;
    }
    expect(decoded.some((candidate) => hasValidAx25Fcs(candidate.bytes))).toBe(
      true,
    );
  });

  it("does not produce valid frames from noise", () => {
    const noise = generateAfsk(Array(300).fill(1), 48_000, {
      amplitude: 0,
      noise: 1,
    });
    const decoded = new Bell202Receiver(48_000).process(noise, 0, 1);
    expect(decoded.some((candidate) => hasValidAx25Fcs(candidate.bytes))).toBe(
      false,
    );
  });
});
