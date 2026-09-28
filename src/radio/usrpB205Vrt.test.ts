import { describe, expect, it } from "vitest";
import { encodeUsrpB205ControlAck } from "../testing/usrpB205ControlFixture";
import {
  UsrpB205ControlAccumulator,
  decodeUsrpB205ControlResponse,
  decodeUsrpB205VrtPacket,
  encodeUsrpB205ControlRequest,
} from "./usrpB205Vrt";

describe("USRP B205-mini VRT control codec", () => {
  it("derives the pinned local compatibility and radio-format golden bytes", () => {
    expect([...encodeUsrpB205ControlRequest(0x40, 0, 32, 0)]).toEqual([
      0x10, 0, 0, 0x80, 0x40, 0, 0, 0, 0x20, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect([...encodeUsrpB205ControlRequest(0x10, 0, 136, 0)]).toEqual([
      0x10, 0, 0, 0x80, 0x10, 0, 0, 0, 0x88, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const response = encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x40, 0, 32, 0), {
      readback: 0xace0ba5e00070000n,
    });
    expect([...response]).toEqual([
      0x18, 0, 0, 0xa0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0x5e, 0xba, 0xe0, 0xac, 0, 0, 7, 0,
    ]);
    expect(decodeUsrpB205ControlResponse(response)).toEqual({ sid: 0x00400000, sequence: 0,
      timestamp: 0n, readback: 0xace0ba5e00070000n });
  });

  it("round-trips timestamp, SID, sequence and high/low word order", () => {
    const response = encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x10, 0xfff, 136, 0), {
      timestamp: 0x1122334455667788n, readback: 0x99aabbccddeeff00n,
    });
    expect(decodeUsrpB205VrtPacket(response)).toMatchObject({ context: true, hasTimestamp: true,
      endOfBurst: false, sequence: 0xfff, byteLength: 24, sid: 0x00100000,
      timestamp: 0x1122334455667788n, payloadWords: [0x99aabbcc, 0xddeeff00] });
  });

  it("assembles partial and multiple packets and bounds retained bytes", () => {
    const accumulator = new UsrpB205ControlAccumulator();
    const one = encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x40, 0, 32, 0));
    const two = encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x10, 0, 136, 0));
    expect(accumulator.push(one.slice(0, 7))).toHaveLength(0);
    expect(accumulator.retainedByteLength).toBe(7);
    const rest = new Uint8Array(one.byteLength - 7 + two.byteLength);
    rest.set(one.slice(7)); rest.set(two, one.byteLength - 7);
    expect(accumulator.push(rest)).toEqual([one, two]);
    expect(accumulator.retainedByteLength).toBe(0);
  });

  it("rejects every fixed acknowledgement-header invariant", () => {
    const original = encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x40, 3, 32, 0));
    for (const mutate of [
      (bytes: Uint8Array) => { bytes[3] = 0x20; },
      (bytes: Uint8Array) => { bytes[3] = 0xb0; },
      (bytes: Uint8Array) => { bytes[0] = 20; },
      (bytes: Uint8Array) => { bytes[4] = 0x7f; },
    ]) {
      const bytes = Uint8Array.from(original); mutate(bytes);
      expect(() => decodeUsrpB205ControlResponse(bytes)).toThrow(/Malformed/);
    }
    expect(() => decodeUsrpB205ControlResponse(original.slice(0, 20))).toThrow(/length/);
    expect(() => encodeUsrpB205ControlRequest(0x40, 4096, 0, 0)).toThrow(/12-bit/);
  });
});
