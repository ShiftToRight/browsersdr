import { describe, expect, it } from "vitest";
import { hasValidAx25Fcs, parseAx25UiFrame } from "./ax25";
import { HdlcDeframer } from "./hdlc";
import { buildUiFrame, hdlcBits } from "./fixtures/testSignal";

describe("AX.25 and HDLC", () => {
  it("validates FCS and parses bounded UI addresses", () => {
    const bytes = buildUiFrame("!4903.50N/07201.75W-Test", "APRS", "N0CALL-7", [
      "WIDE1-1",
      "WIDE2-2",
    ]);
    expect(hasValidAx25Fcs(bytes)).toBe(true);
    const frame = parseAx25UiFrame(bytes)!;
    expect(frame.source).toMatchObject({ callsign: "N0CALL", ssid: 7 });
    expect(frame.path).toHaveLength(2);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 1;
    expect(hasValidAx25Fcs(bytes)).toBe(false);
  });

  it("unstuffs across boundaries and rejects non-byte alignment and aborts", () => {
    const frame = buildUiFrame(">11111 forces stuffing");
    const decoder = new HdlcDeframer();
    const decoded = hdlcBits(frame).flatMap((bit, index) =>
      decoder.push(bit, index),
    );
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.bytes).toEqual(frame);

    const malformed = new HdlcDeframer();
    const flag = [0, 1, 1, 1, 1, 1, 1, 0];
    expect(
      [...flag, 1, 0, 1, ...flag].flatMap((bit, index) =>
        malformed.push(bit, index),
      ),
    ).toHaveLength(0);
    const aborted = new HdlcDeframer();
    expect(
      [...flag, ...Array(8).fill(1), ...flag].flatMap((bit, index) =>
        aborted.push(bit, index),
      ),
    ).toHaveLength(0);
  });

  it("rejects overlong paths and information", () => {
    expect(
      parseAx25UiFrame(
        buildUiFrame("x", "APRS", "N0CALL", Array(9).fill("WIDE1-1")),
      ),
    ).toBeUndefined();
    expect(parseAx25UiFrame(buildUiFrame("x".repeat(257)))).toBeUndefined();
  });
});
