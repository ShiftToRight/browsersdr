import { describe, expect, it } from "vitest";
import {
  classifyAdsbAddress,
  decodeAdsbQuality,
  decodeGlobalCpr,
  surfaceMovement,
} from "./adsbFields";

function frame(cf: number | null, tc: number, imfAt?: number): Uint8Array {
  const b = new Uint8Array(14);
  b[0] = cf === null ? 0x8d : 0x90 | cf;
  b.set([0x48, 0x40, 0xd6], 1);
  b[4] = tc << 3;
  if (imfAt !== undefined) b[imfAt >> 3]! |= 1 << (7 - (imfAt & 7));
  return b;
}
function setBits(b: Uint8Array, at: number, length: number, value: number) {
  for (let n = 0; n < length; n++) {
    const bit = at + n,
      mask = 1 << (7 - (bit & 7));
    b[bit >> 3] =
      (b[bit >> 3]! & ~mask) | ((value >> (length - n - 1)) & 1 ? mask : 0);
  }
}

describe("qualified DF18 addressing", () => {
  it.each([
    [null, "ads-b", "icao"],
    [0, "ads-b-non-transponder", "icao"],
    [1, "ads-b", "other"],
    [2, "tis-b", "icao"],
    [5, "tis-b", "other"],
    [6, "ads-r", "icao"],
  ] as const)(
    "classifies CF %s without aliasing direct aircraft",
    (cf, origin, addressType) => {
      expect(classifyAdsbAddress(frame(cf, 11))).toMatchObject({
        origin,
        addressType,
        address: "4840D6",
        icao: addressType === "icao" ? "4840D6" : null,
      });
    },
  );
  it.each([3, 4, 7])("rejects unsupported CF %i payload layouts", (cf) =>
    expect(classifyAdsbAddress(frame(cf, 4))).toBeUndefined(),
  );
  it.each([
    [5, 52],
    [11, 39],
    [21, 39],
    [19, 40],
    [28, 87],
    [31, 87],
    [29, 82],
  ])("reads the type %i IMF from its own field", (tc, at) => {
    for (const cf of [2, 6]) {
      const b = frame(cf, tc, at);
      if (tc === 19 || tc === 28) setBits(b, 37, 3, 1);
      expect(classifyAdsbAddress(b)).toMatchObject({
        addressType: cf === 2 ? "track-file" : "other",
        icao: null,
      });
    }
  });
  it("keeps identification without an IMF unqualified and namespaces all controls", () => {
    const addresses = [null, 0, 1, 2, 5, 6].map((cf) =>
      classifyAdsbAddress(frame(cf, 4))!,
    );
    expect(new Set(addresses.map((a) => a.id)).size).toBe(6);
    expect(addresses[3]).toMatchObject({ addressType: "unknown", icao: null });
    expect(addresses[5]).toMatchObject({ addressType: "unknown", icao: null });
  });
});

it("decodes only supported operational quality versions and non-reserved NACp", () => {
  const b = frame(null, 31);
  setBits(b, 72, 3, 2);
  setBits(b, 76, 4, 10);
  setBits(b, 82, 2, 3);
  setBits(b, 86, 1, 1);
  expect(decodeAdsbQuality(b, 123)).toEqual({
    version: 2,
    nacP: 10,
    sil: 3,
    silBasis: "per-sample",
    reportedAtMs: 123,
  });
  setBits(b, 76, 4, 15);
  expect(decodeAdsbQuality(b, 123)?.nacP).toBeNull();
  setBits(b, 72, 3, 1);
  expect(decodeAdsbQuality(b, 123)?.silBasis).toBe("unknown");
  setBits(b, 72, 3, 7);
  expect(decodeAdsbQuality(b, 123)).toMatchObject({
    version: 7,
    nacP: null,
    sil: null,
  });
  setBits(b, 37, 3, 2);
  expect(decodeAdsbQuality(b, 123)).toBeUndefined();
});

it("resolves the independently published surface CPR vector only near its reference", () => {
  // Junzi Sun, The 1090 MHz Riddle, Surface Position (2021), even/odd
  // 8C4841753AAB238733C8CD4020B1 / 8C4841753A8A35323FAEBDAC702D.
  const even = { lat: 115609, lon: 116941, time: 1000 },
    odd = { lat: 39199, lon: 110269, time: 2000 };
  expect(
    decodeGlobalCpr(even, odd, { latitude: 51.99, longitude: 4.375 }),
  ).toEqual({
    latitude: expect.closeTo(52.320607, 5),
    longitude: expect.closeTo(4.734735, 5),
  });
  expect(
    decodeGlobalCpr(even, odd, { latitude: 51, longitude: 4 }),
  ).toBeUndefined();
  expect(
    decodeGlobalCpr(
      even,
      { ...odd, time: 7001 },
      { latitude: 51.99, longitude: 4.375 },
    ),
  ).toBeUndefined();
  expect(
    decodeGlobalCpr(even, odd, {
      latitude: -37.68,
      longitude: -84.44096274997877,
    }),
  ).toEqual({
    latitude: expect.closeTo(-37.679393, 5),
    longitude: expect.any(Number),
  });
});

it("rejects out-of-range airborne latitudes even when both NL values agree", () => {
  // j=25 => both decoded latitudes around 150 degrees, not a terrestrial fix.
  expect(
    decodeGlobalCpr(
      { lat: 32768, lon: 100, time: 0 },
      { lat: 0, lon: 100, time: 1 },
    ),
  ).toBeUndefined();
});

it.each([
  [0, null],
  [1, [0, 0.125]],
  [2, [0.125, 0.25]],
  [8, [0.875, 1]],
  [9, [1, 1.25]],
  [38, [14.5, 15]],
  [39, [15, 16]],
  [94, [70, 72]],
  [123, [170, 175]],
  [124, [175, null]],
  [125, null],
  [127, null],
] as const)(
  "preserves movement %s as a range/unavailable code",
  (code, range) => expect(surfaceMovement(code, 0)).toEqual(range),
);

it("guards the version-dependent sub-1 kt surface movement bins", () => {
  expect(surfaceMovement(2)).toEqual([0, 1]);
  expect(surfaceMovement(8, 7)).toEqual([0, 1]);
  expect(surfaceMovement(2, 2)).toEqual([0, .125]);
  expect(surfaceMovement(3, 2)).toEqual([.125, expect.closeTo(.125 + .875 / 6, 8)]);
});
