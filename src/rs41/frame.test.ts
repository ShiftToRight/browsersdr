import { describe, expect, it } from "vitest";
import { decodeRs41Frame, ecefToWgs84, rs41Crc16 } from "./frame";
import {
  bytesFromHex,
  RS41_EXTENDED_FRAME_HEX,
  RS41_REAL_FRAME_EXPECTED,
  RS41_REAL_FRAME_HEX,
} from "./fixtures/referenceFrames";

const provenance = {
  generation: 7,
  firstInputSampleIndex: 100,
  lastInputSampleIndex: 200,
  actualInputSampleRateHz: 1_024_000,
  selectedChannelOffsetHz: 25_000,
};

describe("RS41 frame parsing", () => {
  it("matches the real capture-derived frame and independent expected values", () => {
    const result = decodeRs41Frame(
      bytesFromHex(RS41_REAL_FRAME_HEX),
      provenance,
    );
    expect(result).toMatchObject({
      variant: "standard",
      fecStatus: "uncorrected",
      sondeId: RS41_REAL_FRAME_EXPECTED.sondeId,
      frameCounter: RS41_REAL_FRAME_EXPECTED.frameCounter,
    });
    expect(result.gpsTime).toEqual({
      week: RS41_REAL_FRAME_EXPECTED.gpsWeek,
      timeOfWeekMilliseconds:
        RS41_REAL_FRAME_EXPECTED.gpsTimeOfWeekMilliseconds,
    });
    expect(result.position?.latitudeDegrees).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.latitudeDegrees,
      4,
    );
    expect(result.position?.longitudeDegrees).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.longitudeDegrees,
      4,
    );
    expect(result.position?.altitudeMeters).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.altitudeMeters,
      1,
    );
    expect(result.position?.horizontalSpeedMetersPerSecond).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.horizontalSpeedMetersPerSecond,
      1,
    );
    expect(result.position?.headingDegrees).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.headingDegrees,
      1,
    );
    expect(result.position?.upVelocityMetersPerSecond).toBeCloseTo(
      RS41_REAL_FRAME_EXPECTED.upVelocityMetersPerSecond,
      1,
    );
  });

  it("uses CRC-16/CCITT-FALSE and gates every sub-block after FEC rejection", () => {
    expect(rs41Crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
    const frame = bytesFromHex(RS41_REAL_FRAME_HEX);
    frame[0x097] = frame[0x097]! ^ 1;
    // Make the whole RS frame uncorrectable elsewhere so FEC cannot repair GPS-INFO.
    for (let index = 0; index < 13; index++)
      frame[0x070 + index * 2] = frame[0x070 + index * 2]! ^ 0x80;
    const result = decodeRs41Frame(frame, provenance);
    expect(result.fecStatus).toBe("rejected");
    expect(Object.values(result.subblockIntegrity)).toEqual(
      Array(5).fill(false),
    );
    expect(result.gpsTime).toBeUndefined();
    expect(result.sondeId).toBeUndefined();
    expect(result.frameCounter).toBeUndefined();
    expect(result.position).toBeUndefined();
  });

  it("labels the verified 518-byte extended frame", () => {
    const result = decodeRs41Frame(
      bytesFromHex(RS41_EXTENDED_FRAME_HEX),
      provenance,
    );
    expect(result).toMatchObject({
      variant: "extended",
      fecStatus: "corrected",
      correctedErrors: 2,
      sondeId: "K4020244",
    });
  });

  it("converts WGS-84 ECEF and rejects impossible coordinates", () => {
    const equator = ecefToWgs84(6_378_137, 0, 0)!;
    expect(equator.latitudeDegrees).toBeCloseTo(0, 9);
    expect(equator.longitudeDegrees).toBeCloseTo(0, 9);
    expect(equator.altitudeMeters).toBeCloseTo(0, 5);
    expect(ecefToWgs84(0, 0, 0)).toBeUndefined();
  });
});
