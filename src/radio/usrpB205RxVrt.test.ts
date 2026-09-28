import { describe, expect, it } from "vitest";
import { encodeUsrpB205RxData, encodeUsrpB205RxInline } from "../testing/usrpB205RxFixture";
import {
  USRP_B205_SC16_SCALE,
  UsrpB205RxAccumulator,
  decodeUsrpB205RxPacket,
  decodeUsrpB205Sc16Into,
} from "./usrpB205RxVrt";

describe("USRP B205-mini RX VRT and SC16 codec", () => {
  it("decodes independent data and inline golden packets", () => {
    const data = encodeUsrpB205RxData(0xabc, 0x1122334455667788n, [[0x1234, -2], [-32768, 32767]]);
    expect([...data.slice(0, 16)]).toEqual([
      0x18, 0, 0xbc, 0x2a, 0xa0, 0, 0, 0, 0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55,
    ]);
    expect(decodeUsrpB205RxPacket(data)).toMatchObject({ kind: "data", sequence: 0xabc,
      timestampTicks: 0x1122334455667788n, endOfBurst: false, complexSampleCount: 2 });
    const inline = encodeUsrpB205RxInline(7, 99n, 0x8, 0x12345678);
    expect(decodeUsrpB205RxPacket(inline)).toMatchObject({ kind: "inline", sequence: 7,
      timestampTicks: 99n, code: 0x8, detail: 0x12345678 });
  });

  it("reassembles fragmented packets and splits coalesced transfers", () => {
    const one = encodeUsrpB205RxData(1, 16n, [[1, 2], [3, 4]]);
    const two = encodeUsrpB205RxInline(2, 48n, 0x8);
    const joined = new Uint8Array(one.byteLength + two.byteLength);
    joined.set(one); joined.set(two, one.byteLength);
    const parser = new UsrpB205RxAccumulator();
    expect(parser.push(joined.slice(0, 3))).toEqual([]);
    expect(parser.push(joined.slice(3, 19))).toEqual([]);
    expect(parser.retainedByteLength).toBe(19);
    expect(parser.push(joined.slice(19))).toEqual([one, two]);
    expect(parser.retainedByteLength).toBe(0);
  });

  it("preserves an owned exact-packet USB buffer and owns offset views", () => {
    const packet = encodeUsrpB205RxData(1, 16n, [[1, 2], [3, 4]]);
    const parser = new UsrpB205RxAccumulator();
    expect(parser.push(packet)[0]).toBe(packet);
    const backing = new Uint8Array(packet.byteLength + 7);
    backing.set(packet, 3);
    const offset = backing.subarray(3, 3 + packet.byteLength);
    const owned = parser.push(offset)[0]!;
    expect(owned).toEqual(packet);
    expect(owned.buffer).not.toBe(backing.buffer);
  });

  it("accepts only the FX3's one-word zero overrun padding at a chunk tail", () => {
    const packet = encodeUsrpB205RxData(1, 16n, [[1, 2], [3, 4]]);
    const padded = new Uint8Array(packet.byteLength + 4);
    padded.set(packet);
    const parser = new UsrpB205RxAccumulator();
    expect(parser.push(padded)).toEqual([packet]);
    expect(parser.retainedByteLength).toBe(0);
    expect(() => parser.push(new Uint8Array(4))).toThrow(/length 0/);
    const nonzero = new Uint8Array(packet.byteLength + 4);
    nonzero.set(packet); nonzero[nonzero.length - 1] = 1;
    expect(() => new UsrpB205RxAccumulator().push(nonzero)).toThrow(/length 0/);
  });

  it("honors typed-array offsets and SC16 Q-low/I-high signed scaling", () => {
    const backing = new Uint8Array(3 + 16 + 4 * 4 + 5);
    const packet = encodeUsrpB205RxData(0, 0n, [[32767, -32768], [-32768, 32767], [16384, 0], [0, -16384]]);
    backing.set(packet, 3);
    const decoded = decodeUsrpB205RxPacket(backing.subarray(3, 3 + packet.byteLength));
    expect(decoded.kind).toBe("data");
    if (decoded.kind !== "data") return;
    const I = new Float32Array(4); const Q = new Float32Array(4);
    expect(decodeUsrpB205Sc16Into(decoded.payloadBytes, I, Q)).toBe(4);
    expect(I[0]).toBeCloseTo(0.9999997558594347, 7);
    expect(Q[0]).toBeCloseTo(-32768 * USRP_B205_SC16_SCALE, 7);
    expect(I[1]).toBeCloseTo(-32768 * USRP_B205_SC16_SCALE, 7);
    expect(Q[1]).toBeCloseTo(0.9999997558594347, 7);
    expect(I[2]!).toBeGreaterThan(0); expect(Q[2]).toBe(0);
    expect(I[3]).toBe(0); expect(Q[3]!).toBeLessThan(0);
  });

  it("rejects wrong SID/type/timestamp, padding, alignment and size", () => {
    const base = encodeUsrpB205RxData(0, 0n, [[1, 2]]);
    const mutations = [
      (bytes: Uint8Array) => { bytes[4] = 0x50; },
      (bytes: Uint8Array) => { bytes[3] = bytes[3]! & ~0x20; },
      (bytes: Uint8Array) => { bytes[3] = bytes[3]! | 0x40; },
      (bytes: Uint8Array) => { bytes[0] = 21; },
    ];
    for (const mutate of mutations) {
      const value = Uint8Array.from(base); mutate(value);
      expect(() => decodeUsrpB205RxPacket(value)).toThrow();
    }
    const padded = new Uint8Array(base.byteLength + 4); padded.set(base);
    expect(() => decodeUsrpB205RxPacket(padded)).toThrow(/length/);
    const parser = new UsrpB205RxAccumulator();
    expect(() => parser.push(Uint8Array.of(0xff, 0xff, 0, 0))).toThrow(/length/);
    expect(() => parser.push(new Uint8Array(16_361))).toThrow(/16360/);
  });
});
