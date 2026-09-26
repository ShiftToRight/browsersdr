import { describe, expect, it, vi } from "vitest";
import { DabPadDecoder, extractDabPad } from "./dabPad";
import { DabMotDecoder, validDabImage } from "./dabMot";
import { dabCrc16 } from "./dabChannelCoding";

const utf8 = (text: string) => new TextEncoder().encode(text);
function crc(data: Uint8Array): Uint8Array {
  const value = dabCrc16(data);
  return Uint8Array.of(...data, value >> 8, value & 255);
}
function label(text: Uint8Array, flags = 0x60, field = 0xf0): Uint8Array {
  return crc(Uint8Array.of(flags | (text.length - 1), field, ...text));
}
function pad(data: Uint8Array, indicator = 2, ci = true): Uint8Array {
  return Uint8Array.of(...data.slice().reverse(), indicator << 4, ci ? 2 : 0);
}
function au(padBytes: Uint8Array): Uint8Array {
  return Uint8Array.of(0x80, padBytes.length, ...padBytes, 0xe0);
}
function variable(
  fields: { type: number; data: Uint8Array; length?: number }[],
): Uint8Array {
  const lengths = [4, 6, 8, 12, 16, 24, 32, 48];
  const entries = fields.map((field) => ({
    ...field,
    length: field.length ?? lengths.find((n) => n >= field.data.length)!,
  }));
  const data = new Uint8Array(
    entries.reduce((sum, field) => sum + field.length, 0) +
      Math.min(4, entries.length + 1),
  );
  entries.forEach((entry, i) => {
    data[i] = (lengths.indexOf(entry.length) << 5) | entry.type;
  });
  let offset = Math.min(4, entries.length + 1);
  for (const entry of entries) {
    data.set(entry.data, offset);
    offset += entry.length;
  }
  return pad(data);
}
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
function header(
  size: number,
  name = "slide.png",
  trigger = true,
  extra = new Uint8Array(),
  type = 2,
  subtype = 3,
): Uint8Array {
  const params = Uint8Array.of(
    0xcc,
    name.length + 1,
    0xf0,
    ...utf8(name),
    ...(trigger ? [0x85, 0, 0, 0, 0] : []),
    ...extra,
  );
  const length = 7 + params.length;
  return Uint8Array.of(
    size >>> 20,
    size >>> 12,
    size >>> 4,
    ((size & 15) << 4) | (length >> 9),
    length >> 1,
    ((length & 1) << 7) | (type << 1) | (subtype >> 8),
    subtype,
    ...params,
  );
}
function motGroup(
  type: number,
  bytes: Uint8Array,
  index = 0,
  last = true,
  id = 42,
): Uint8Array {
  return crc(
    Uint8Array.of(
      0x70 | type,
      0,
      (last ? 128 : 0) | (index >> 8),
      index,
      0x12,
      id >> 8,
      id,
      bytes.length >> 8,
      bytes.length,
      ...bytes,
    ),
  );
}
function sendMot(decoder: DabPadDecoder, group: Uint8Array): void {
  decoder.processAccessUnit(
    au(
      variable([
        { type: 1, data: crc(Uint8Array.of(group.length >> 8, group.length)) },
        { type: 12, data: group.subarray(0, 48), length: 48 },
      ]),
    ),
  );
  for (let i = 48; i < group.length; i += 48)
    decoder.processAccessUnit(
      au(variable([{ type: 13, data: group.subarray(i, i + 48), length: 48 }])),
    );
}

describe("DAB+ programme-associated data", () => {
  it("extracts a leading DSE without altering AAC or interpreting other elements", () => {
    const bytes = au(Uint8Array.of(0, 0));
    expect(extractDabPad(bytes)).toEqual(Uint8Array.of(0, 0));
    expect(bytes).toEqual(Uint8Array.of(0x80, 2, 0, 0, 0xe0));
    expect(extractDabPad(Uint8Array.of(0, 2, 0, 0))).toBeUndefined();
    expect(extractDabPad(Uint8Array.of(0x80, 255))).toBeUndefined();
    expect(extractDabPad(Uint8Array.of(0x80, 9, 0, 0))).toBeUndefined();
  });
  it("reassembles multibyte text across segments, ignores repeats and obeys clear", () => {
    const update = vi.fn(),
      decoder = new DabPadDecoder(update);
    const text = utf8("Now: München – Café");
    decoder.processPad(
      variable([{ type: 2, data: label(text.subarray(0, 7), 0x40) }]),
    );
    expect(update).not.toHaveBeenCalled();
    const end = variable([
      { type: 2, data: label(text.subarray(7), 0x20, 0x10) },
    ]);
    decoder.processPad(end);
    expect(update).toHaveBeenLastCalledWith({ text: "Now: München – Café" });
    decoder.processPad(end);
    expect(update).toHaveBeenCalledTimes(1);
    decoder.processPad(
      variable([{ type: 2, data: crc(Uint8Array.of(0x71, 0)) }]),
    );
    expect(update).toHaveBeenLastCalledWith({ text: "" });
  });
  it("handles short X-PAD, CRC failures, toggles and missing starts", () => {
    const update = vi.fn(),
      decoder = new DabPadDecoder(update),
      group = label(utf8("Radio"));
    decoder.processPad(pad(Uint8Array.of(2, ...group.subarray(0, 3)), 1));
    decoder.processPad(pad(group.subarray(3, 7), 1, false));
    decoder.processPad(
      pad(Uint8Array.of(...group.subarray(7), 0, 0), 1, false),
    );
    expect(update).toHaveBeenLastCalledWith({ text: "Radio" });
    const bad = label(utf8("Bad"), 0xe0);
    bad[3] = 0;
    decoder.processPad(variable([{ type: 2, data: bad }]));
    expect(update).toHaveBeenCalledTimes(1);
    decoder.reset();
    update.mockClear();
    decoder.processPad(variable([{ type: 3, data: group }]));
    expect(update).not.toHaveBeenCalled();
  });
  it("uses the last sub-field for CI-free variable continuation", () => {
    const update = vi.fn(),
      decoder = new DabPadDecoder(update),
      group = label(utf8("1234567890123456"));
    decoder.processPad(
      variable([
        { type: 31, data: new Uint8Array(4) },
        { type: 2, data: group.subarray(0, 4), length: 4 },
      ]),
    );
    // Previous field was 11 bytes total. Its last application was DLS.
    decoder.processPad(pad(group.subarray(4, 15), 2, false));
    const rest = new Uint8Array(11);
    rest.set(group.subarray(15));
    decoder.processPad(pad(rest, 2, false));
    expect(update).toHaveBeenLastCalledWith({ text: "1234567890123456" });
  });
  it("carries MOT through DGLI and PAD while interleaving live text", () => {
    const update = vi.fn(),
      decoder = new DabPadDecoder(update);
    sendMot(decoder, motGroup(3, header(PNG.length)));
    decoder.processPad(
      variable([{ type: 2, data: label(utf8("Now playing")) }]),
    );
    sendMot(decoder, motGroup(4, PNG));
    expect(update).toHaveBeenLastCalledWith({
      text: "Now playing",
      slide: expect.objectContaining({
        name: "slide.png",
        mimeType: "image/png",
        data: PNG,
      }),
    });
    decoder.reset();
    expect(update).toHaveBeenLastCalledWith({});
  });
  it("discards partial metadata after lost access units and rejects malformed CI lists", () => {
    const update = vi.fn(),
      decoder = new DabPadDecoder(update),
      group = label(utf8("1234567890123456"));
    decoder.processPad(
      variable([{ type: 2, data: group.subarray(0, 4), length: 4 }]),
    );
    decoder.discontinuity();
    decoder.processPad(variable([{ type: 3, data: group.subarray(4) }]));
    decoder.processPad(pad(Uint8Array.of(0xe2, 0, 1, 2, 3)));
    expect(update).not.toHaveBeenCalled();
  });
});

describe("MOT slideshows", () => {
  it("reassembles body-before-header and out-of-order segments, suppressing repetition", () => {
    const onSlide = vi.fn(),
      decoder = new DabMotDecoder(onSlide);
    decoder.processGroup(motGroup(4, PNG.subarray(25), 1));
    decoder.processGroup(motGroup(4, PNG.subarray(0, 25), 0, false));
    expect(onSlide).not.toHaveBeenCalled();
    decoder.processGroup(motGroup(3, header(PNG.length)));
    expect(onSlide).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: PNG }),
    );
    decoder.processGroup(motGroup(3, header(PNG.length)));
    decoder.processGroup(motGroup(4, PNG));
    expect(onSlide).toHaveBeenCalledTimes(1);
  });
  it("holds untriggered slides until a ContentName-matched header update", () => {
    const onSlide = vi.fn(),
      decoder = new DabMotDecoder(onSlide);
    decoder.processGroup(motGroup(3, header(PNG.length, "held.png", false)));
    decoder.processGroup(motGroup(4, PNG));
    expect(onSlide).not.toHaveBeenCalled();
    decoder.processGroup(
      motGroup(3, header(0, "held.png", true, undefined, 5, 0), 0, true, 43),
    );
    expect(onSlide).toHaveBeenCalledOnce();
  });
  it("rejects bad CRC, size mismatches, invalid images and oversized dimensions", () => {
    const onSlide = vi.fn(),
      decoder = new DabMotDecoder(onSlide);
    decoder.processGroup(motGroup(3, header(PNG.length)));
    const bad = motGroup(4, PNG);
    bad[20] = bad[20]! ^ 1;
    decoder.processGroup(bad);
    expect(onSlide).not.toHaveBeenCalled();
    decoder.processGroup(motGroup(4, PNG.subarray(0, 10)));
    expect(onSlide).not.toHaveBeenCalled();
    const huge = PNG.slice();
    huge[16] = 0xff;
    expect(validDabImage(huge, 3)).toBe(false);
    expect(validDabImage(utf8("<svg/>"), 3)).toBe(false);
    expect(validDabImage(PNG, 1)).toBe(false);
  });
  it("drops old partial objects and never combines data across station resets", () => {
    let now = 0;
    const onSlide = vi.fn(),
      decoder = new DabMotDecoder(onSlide, () => now);
    decoder.processGroup(motGroup(3, header(PNG.length)));
    now = 120001;
    decoder.tick();
    decoder.processGroup(motGroup(4, PNG));
    expect(onSlide).not.toHaveBeenCalled();
    decoder.reset();
    decoder.processGroup(motGroup(3, header(PNG.length)));
    expect(onSlide).not.toHaveBeenCalled();
  });
});

function utcParameter(ms: number): number[] {
  const date = new Date(ms),
    mjd = Math.floor(ms / 86400000) + 40587;
  return [
    0x80 | (mjd >> 10),
    (mjd >> 2) & 255,
    ((mjd & 3) << 6) | 8 | (date.getUTCHours() >> 2),
    ((date.getUTCHours() & 3) << 6) | date.getUTCMinutes(),
    date.getUTCSeconds() << 2,
    0,
  ];
}
it("honours timed triggers and expiry without displaying expired slides", () => {
  let now = Date.UTC(2026, 8, 26, 10, 0, 0);
  const onSlide = vi.fn(),
    decoder = new DabMotDecoder(onSlide, () => now);
  const params = Uint8Array.of(
    0xc5,
    6,
    ...utcParameter(now + 10000),
    0xc4,
    6,
    ...utcParameter(now + 20000),
  );
  decoder.processGroup(motGroup(3, header(PNG.length, "timed", false, params)));
  decoder.processGroup(motGroup(4, PNG));
  expect(onSlide).not.toHaveBeenCalled();
  now += 10000;
  decoder.tick();
  expect(onSlide).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "timed" }),
  );
  now += 10000;
  decoder.tick();
  expect(onSlide).toHaveBeenLastCalledWith(undefined);
});
it("bounds the MOT object cache and rejects conflicting repeated segments", () => {
  const onSlide = vi.fn(),
    decoder = new DabMotDecoder(onSlide);
  for (let id = 0; id < 9; id++)
    decoder.processGroup(motGroup(3, header(PNG.length), 0, true, id));
  decoder.processGroup(motGroup(4, PNG, 0, true, 0));
  expect(onSlide).not.toHaveBeenCalled(); // oldest header was evicted
  const partial = PNG.subarray(0, 20);
  decoder.processGroup(motGroup(4, partial, 0, false, 100));
  decoder.processGroup(motGroup(4, new Uint8Array(20), 0, false, 100));
  decoder.processGroup(motGroup(4, PNG.subarray(20), 1, true, 100));
  decoder.processGroup(motGroup(3, header(PNG.length), 0, true, 100));
  expect(onSlide).not.toHaveBeenCalled();
});

it("accepts the Latin-1 MOT ContentName charset used by live Dlf broadcasts", () => {
  const onSlide = vi.fn(),
    decoder = new DabMotDecoder(onSlide);
  // Received header shape: JPEG, trigger NOW, ContentName charset 0x4.
  const bytes = header(PNG.length, "Klassik-Pop-et-cetera");
  bytes[9] = 0x40;
  decoder.processGroup(motGroup(3, bytes));
  decoder.processGroup(motGroup(4, PNG));
  expect(onSlide).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "Klassik-Pop-et-cetera", data: PNG }),
  );
});

it("reconstructs a JPEG using the captured Dlf MOT header and declared body size", () => {
  const onSlide = vi.fn(), decoder = new DabMotDecoder(onSlide);
  const captured = Uint8Array.of(0,7,190,208,18,4,1,133,0,0,0,0,204,22,64,75,108,97,115,115,105,107,45,80,111,112,45,101,116,45,99,101,116,101,114,97);
  const body = new Uint8Array(31725);
  // Minimal SOF0 for the image-dimension gate; browser decoding is tested live.
  body.set([255,216,255,192,0,11,8,0,240,1,64,1,1,0x11,0]);
  decoder.processGroup(motGroup(3, captured));
  for (let offset = 0, index = 0; offset < body.length; offset += 4096, index++)
    decoder.processGroup(motGroup(4, body.subarray(offset, offset + 4096), index, offset + 4096 >= body.length));
  expect(onSlide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "Klassik-Pop-et-cetera", mimeType: "image/jpeg", data: body }));
});
