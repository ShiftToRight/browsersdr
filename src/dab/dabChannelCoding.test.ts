import { describe, expect, it } from "vitest";
import {
  DabFicDatabase,
  DabMscSubchannelDecoder,
  dabCrc16,
  dabDescramble,
  decodeDabConvolutional,
  decodeFicGroup,
} from "./dabChannelCoding";

const POLYNOMIALS = [109, 79, 83, 109];
const COUNTS: Record<number, readonly number[]> = {
  5: [2, 2, 2, 1, 2, 1, 2, 1],
  6: [2, 2, 2, 1, 2, 2, 2, 1],
  7: [2, 2, 2, 2, 2, 2, 2, 1],
  8: [2, 2, 2, 2, 2, 2, 2, 2],
  15: [3, 3, 3, 3, 3, 3, 3, 2],
  16: [3, 3, 3, 3, 3, 3, 3, 3],
  24: [4, 4, 4, 4, 4, 4, 4, 4],
  0: [2, 2, 2, 2, 2, 2],
};

function parity(value: number): number {
  let result = 0;
  while (value) {
    result ^= value & 1;
    value >>>= 1;
  }
  return result;
}

function motherEncode(bytes: Uint8Array): Int8Array {
  const bits = bytes.length * 8 + 6,
    output = new Int8Array(bits * 4);
  let state = 0;
  for (let index = 0; index < bits; index += 1) {
    const input =
      index < bytes.length * 8
        ? (bytes[index >> 3]! >> (7 - (index & 7))) & 1
        : 0;
    const register = (state << 1) | input;
    for (let code = 0; code < 4; code += 1)
      output[index * 4 + code] = parity(register & POLYNOMIALS[code]!)
        ? 100
        : -100;
    state = register & 63;
  }
  return output;
}

function puncture(
  mother: Int8Array,
  segments: readonly { vector: number; motherBits: number }[],
): Int8Array {
  const values: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    const counts = COUNTS[segment.vector]!;
    for (let group = 0; group < segment.motherBits / 4; group += 1) {
      const count = counts[group % counts.length]!;
      for (let bit = 0; bit < count; bit += 1)
        values.push(mother[offset + group * 4 + bit]!);
    }
    offset += segment.motherBits;
  }
  return Int8Array.from(values);
}

function fibWith(body: Uint8Array): Uint8Array {
  const fib = new Uint8Array(32).fill(0xff);
  fib.set(body.subarray(0, 30));
  const crc = dabCrc16(fib.subarray(0, 30));
  fib[30] = crc >> 8;
  fib[31] = crc;
  return fib;
}

describe("DAB channel coding", () => {
  it("decodes the terminated rate-1/4 mother code", () => {
    const source = Uint8Array.from({ length: 24 }, (_, index) => index * 7),
      encoded = motherEncode(source);
    expect(
      decodeDabConvolutional(encoded, [
        { vector: 24, motherBits: encoded.length },
      ]),
    ).toEqual(source);
  });

  it("decodes, descrambles and CRC-checks a Mode-I FIC group", () => {
    const decoded = new Uint8Array(96);
    decoded.set(fibWith(Uint8Array.of(0xff)), 0);
    decoded.set(fibWith(Uint8Array.of(0xff)), 32);
    decoded.set(fibWith(Uint8Array.of(0xff)), 64);
    const dispersed = dabDescramble(decoded),
      mother = motherEncode(dispersed),
      encoded = puncture(mother, [
        { vector: 16, motherBits: 128 * 21 },
        { vector: 15, motherBits: 128 * 3 },
        { vector: 0, motherBits: 24 },
      ]);
    expect(encoded).toHaveLength(2_304);
    expect(decodeFicGroup(encoded)).toHaveLength(3);
  });

  it("discovers an unencrypted DAB+ EEP stream from FIG 0/1 and 0/2", () => {
    const database = new DabFicDatabase();
    // FIG 0/1: subchannel 5, start CU 12, EEP 3-A, 48 CU.
    const subchannel = Uint8Array.of(0x05, 0x01, 0x14, 0x0c, 0x80, 0x30);
    // FIG 0/2: service 0x1234, one primary ASCTy=63 component on subchannel 5.
    const service = Uint8Array.of(
      0x06,
      0x02,
      0x12,
      0x34,
      0x01,
      0x3f,
      0x16,
      0xff,
    );
    database.processFib(
      fibWith(Uint8Array.from([...subchannel, ...service])).subarray(0, 30),
    );
    expect(database.selectedDabPlusService()).toEqual({
      service: {
        serviceId: 0x1234,
        subchannelId: 5,
        primary: true,
        dabPlus: true,
      },
      subchannel: {
        id: 5,
        startAddress: 12,
        length: 48,
        eepType: "A",
        protectionLevel: 0,
      },
    });
  });

  it("time-deinterleaves and EEP-decodes a DAB+ logical frame", () => {
    const source = Uint8Array.from({ length: 24 }, (_, index) => 255 - index),
      dispersed = dabDescramble(source),
      mother = motherEncode(dispersed),
      encoded = puncture(mother, [
        { vector: 8, motherBits: 384 },
        { vector: 7, motherBits: 384 },
        { vector: 0, motherBits: 24 },
      ]);
    expect(encoded).toHaveLength(384);
    const decoder = new DabMscSubchannelDecoder({
      id: 1,
      startAddress: 0,
      length: 6,
      eepType: "A",
      protectionLevel: 2,
    });
    for (let index = 0; index < 15; index += 1)
      expect(decoder.pushCif(encoded)).toBeUndefined();
    expect(decoder.pushCif(encoded)).toEqual(source);
  });
  it("reconstructs changing 64 kb/s EEP 2-B frames across all sixteen CIF delays", () => {
    const delays = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const sources = Array.from({ length: 40 }, (_, frame) =>
      Uint8Array.from(
        { length: 192 },
        (_, byte) => (frame * 73 + byte * 31) ^ (byte >>> 1),
      ),
    );
    const encoded = sources.map((source) =>
      puncture(motherEncode(dabDescramble(source)), [
        { vector: 6, motherBits: 128 * 45 },
        { vector: 5, motherBits: 128 * 3 },
        { vector: 0, motherBits: 24 },
      ]),
    );
    const decoder = new DabMscSubchannelDecoder({
      id: 7,
      startAddress: 123,
      length: 42,
      eepType: "B",
      protectionLevel: 1,
    });
    for (let frame = 0; frame < sources.length; frame += 1) {
      const cif = new Int8Array(55_296);
      for (let bit = 0; bit < 42 * 64; bit += 1) {
        const source = frame - delays[bit & 15]!;
        cif[123 * 64 + bit] = source < 0 ? 0 : encoded[source]![bit]!;
      }
      const result = decoder.pushCif(cif);
      if (frame < 15) expect(result).toBeUndefined();
      else expect(result).toEqual(sources[frame - 15]);
    }
  });
  it("does not activate next-configuration or other-ensemble subchannels", () => {
    const database = new DabFicDatabase();
    for (const flags of [0x80, 0x40]) {
      database.processFib(Uint8Array.of(5, flags | 1, 0x14, 0x0c, 0x88, 0x30));
      expect(database.subchannels.size).toBe(0);
    }
  });
  it("corrects soft errors and erasures across both trellis predecessor halves", () => {
    const source = Uint8Array.from(
      { length: 96 },
      (_, i) => (i * 97) ^ (i >>> 2),
    );
    const encoded = motherEncode(source);
    for (let i = 0; i < encoded.length; i += 1) {
      if (i % 7 === 0) encoded[i] = 0;
      else if (i % 19 === 0) encoded[i] = -encoded[i]! / 10;
      else encoded[i] = encoded[i]! * (0.4 + (i % 4) * 0.2);
    }
    expect(
      decodeDabConvolutional(encoded, [
        { vector: 24, motherBits: encoded.length },
      ]),
    ).toEqual(source);
  });
});

function labelFig(
  extension: number,
  id: number,
  text: Uint8Array,
  mask = 0xffff,
  charset = 0,
): Uint8Array {
  const idBytes = extension === 5 ? 4 : 2;
  const body = new Uint8Array(1 + idBytes + 18).fill(0x20);
  body[0] = (charset << 4) | extension;
  for (let i = 0; i < idBytes; i++) body[idBytes - i] = (id / 256 ** i) & 255;
  body.set(text.subarray(0, 16), 1 + idBytes);
  body[17 + idBytes] = mask >> 8;
  body[18 + idBytes] = mask;
  return Uint8Array.of(0x20 | body.length, ...body);
}

it("joins labels received before service definitions and selects individual components", () => {
  const database = new DabFicDatabase();
  database.processFib(
    labelFig(0, 0x1234, new TextEncoder().encode("My ensemble")),
  );
  database.processFib(
    labelFig(1, 0x1234, new TextEncoder().encode(" My station"), 0x7f80),
  );
  database.processFib(Uint8Array.of(9, 1, 0x14, 0, 0x88, 6, 0x18, 6, 0x88, 6));
  database.processFib(
    Uint8Array.of(8, 2, 0x12, 0x34, 2, 0x3f, 0x16, 0x3f, 0x18),
  );
  expect(database.ensemble).toMatchObject({ id: 0x1234, label: "My ensemble" });
  expect(database.stations()).toEqual([
    expect.objectContaining({
      key: "4660:5",
      label: "My station",
      shortLabel: "My stati",
      bitrateKbps: 8,
      playable: true,
    }),
    expect.objectContaining({
      key: "4660:6",
      label: "My station",
      primary: false,
      playable: true,
    }),
  ]);
  expect(database.selectedDabPlusService("4660:6")?.subchannel.id).toBe(6);
  expect(database.selectedDabPlusService("4660:9")).toBeUndefined();
  database.reset();
  expect(database.ensemble).toBeUndefined();
  expect(database.stations()).toEqual([]);
  expect(database.labels.size).toBe(0);
});

it("ignores malformed, other-ensemble and unsupported-charset labels", () => {
  const database = new DabFicDatabase();
  const valid = labelFig(1, 0x1234, new TextEncoder().encode("Station"));
  database.processFib(valid.subarray(0, 15));
  const other = valid.slice();
  other[1] = other[1]! | 8;
  database.processFib(other);
  database.processFib(labelFig(1, 0x1234, Uint8Array.of(65), 0xffff, 3));
  expect(database.labels.size).toBe(0);
  database.processFib(
    labelFig(5, 0xf1234567, new TextEncoder().encode("Data service")),
  );
  expect(database.labels.get(0xf1234567)?.label).toBe("Data service");
});
