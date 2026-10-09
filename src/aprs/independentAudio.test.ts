import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bell202Receiver } from "./afsk1200";
import { formatAx25Address, hasValidAx25Fcs, parseAx25UiFrame } from "./ax25";
import provenance from "./fixtures/picoSoundcard.json";
import { parseAprsPayload } from "./payload";

describe("independent Pico soundcard recording (not off-air RF)", () => {
  it.each([57330, 997, 313])(
    "decodes unchanged captured audio in %i-sample blocks",
    (blockSize) => {
      const pcm = readFileSync(
        new URL("./fixtures/picoSoundcard.s16le", import.meta.url),
      );
      expect(createHash("sha256").update(pcm).digest("hex")).toBe(
        provenance.excerptSha256,
      );
      expect(pcm.length).toBe(provenance.sampleCount * 2);
      const audio = Float32Array.from(
        { length: provenance.sampleCount },
        (_, index) => pcm.readInt16LE(index * 2) / 32768,
      );
      const receiver = new Bell202Receiver(provenance.sampleRateHz);
      const packets = [];
      for (let start = 0; start < audio.length; start += blockSize) {
        packets.push(
          ...receiver.process(
            audio.subarray(start, start + blockSize),
            start,
            1,
          ),
        );
      }
      const valid = packets.filter((packet) => hasValidAx25Fcs(packet.bytes));
      expect(valid).toHaveLength(1);
      const frame = parseAx25UiFrame(valid[0]!.bytes)!;
      expect(formatAx25Address(frame.source)).toBe(provenance.expectedSource);
      expect(formatAx25Address(frame.destination)).toBe(
        provenance.expectedDestination,
      );
      expect(frame.path.map(formatAx25Address)).toEqual(
        provenance.expectedPath,
      );
      expect(new TextDecoder().decode(frame.information)).toBe(
        provenance.expectedInformation,
      );
      const payload = parseAprsPayload(frame);
      expect(payload.kind).toBe("position");
      if (payload.kind !== "position")
        throw new Error("Expected recorded position");
      expect(payload.position.format).toBe("compressed");
      expect(payload.position.latitudeDegrees).toBeCloseTo(
        provenance.expectedLatitudeDegrees,
        4,
      );
      expect(payload.position.longitudeDegrees).toBeCloseTo(
        provenance.expectedLongitudeDegrees,
        4,
      );
      expect(
        Math.abs(payload.altitudeMeters! - provenance.expectedAltitudeMeters),
      ).toBeLessThan(0.5);
      expect(payload.comment).toContain("APRS by RPi-Pico");
      // Starting the filter at the excerpt boundary can shift timing by one sample.
      expect(Math.abs(valid[0]!.firstSampleIndex - 12683)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(valid[0]!.lastSampleIndex - 48768)).toBeLessThanOrEqual(
        1,
      );
    },
  );
});
