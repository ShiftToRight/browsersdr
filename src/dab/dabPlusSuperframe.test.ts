import { describe, expect, it, vi } from "vitest";
import {
  DabPlusProgrammeDecoder,
  DabPlusSuperframeSynchronizer,
  correctDabPlusCodeword,
  dabPlusAccessUnitCrc,
  dabPlusFireCode,
  parseDabPlusSuperframe,
} from "./dabPlusSuperframe";
import type { WebCodecsDabAudioDecoder } from "./dabAudio";

const EXP = new Uint8Array(510),
  LOG = new Int16Array(256).fill(-1);
let field = 1;
for (let index = 0; index < 255; index += 1) {
  EXP[index] = field;
  LOG[field] = index;
  field <<= 1;
  if (field & 0x100) field ^= 0x11d;
}
for (let index = 255; index < EXP.length; index += 1)
  EXP[index] = EXP[index - 255]!;
function mul(a: number, b: number) {
  return a && b ? EXP[LOG[a]! + LOG[b]!]! : 0;
}
function encode(data: Uint8Array): Uint8Array {
  let generator = Uint8Array.of(1);
  for (let root = 0; root < 10; root += 1) {
    const next = new Uint8Array(generator.length + 1);
    for (let index = 0; index < generator.length; index += 1) {
      next[index] = next[index]! ^ generator[index]!;
      next[index + 1] = next[index + 1]! ^ mul(generator[index]!, EXP[root]!);
    }
    generator = next;
  }
  const remainder = new Uint8Array(120);
  remainder.set(data);
  for (let index = 0; index < 110; index += 1) {
    const scale = remainder[index]!;
    if (!scale) continue;
    for (let coefficient = 0; coefficient < generator.length; coefficient += 1)
      remainder[index + coefficient] =
        remainder[index + coefficient]! ^ mul(scale, generator[coefficient]!);
  }
  const result = new Uint8Array(120);
  result.set(data);
  result.set(remainder.subarray(110), 110);
  return result;
}
function withCrc(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 2),
    crc = dabPlusAccessUnitCrc(payload);
  framed.set(payload);
  framed[framed.length - 2] = crc >> 8;
  framed[framed.length - 1] = crc;
  return framed;
}
function makeSuperframe(firstPayload = new Uint8Array(20).fill(1)): Uint8Array {
  const data = new Uint8Array(110),
    aus = [
      withCrc(firstPayload),
      withCrc(new Uint8Array(30).fill(2)),
      withCrc(new Uint8Array(48).fill(3)),
    ];
  data[2] = 0x70; // 48 kHz DAC, SBR, stereo core => three AUs
  data[3] = 0x01;
  data[4] = 0xc0; // AU 1 starts at 28
  data[5] = 0x3c; // AU 2 starts at 60
  data.set(aus[0]!, 6);
  data.set(aus[1]!, 28);
  data.set(aus[2]!, 60);
  const fire = dabPlusFireCode(data.subarray(2, 11));
  data[0] = fire >> 8;
  data[1] = fire;
  return encode(data);
}

describe("DAB+ superframes", () => {
  it("corrects five byte errors in shortened RS(120,110)", () => {
    const source = Uint8Array.from({ length: 110 }, (_, index) => index),
      encoded = encode(source);
    for (const position of [0, 17, 51, 89, 119])
      encoded[position] = encoded[position]! ^ 0x5a;
    const corrected = correctDabPlusCodeword(encoded);
    expect(corrected?.correctedBytes).toBe(5);
    expect(corrected?.data).toEqual(source);
  });

  it("extracts only CRC-valid raw AAC access units", () => {
    const encoded = makeSuperframe();
    const corrected = correctDabPlusCodeword(encoded);
    expect(corrected).toBeDefined();
    expect(dabPlusFireCode(corrected!.data.subarray(2, 11))).toBe(
      (corrected!.data[0]! << 8) | corrected!.data[1]!,
    );
    const parsed = parseDabPlusSuperframe(encoded);
    expect(parsed?.format).toMatchObject({
      dacRate: true,
      sbr: true,
      stereo: true,
    });
    expect(parsed?.accessUnits.map((unit) => unit.data.length)).toEqual([
      20, 30, 48,
    ]);
    expect(parsed?.rejectedAccessUnits).toBe(0);
  });

  it("synchronizes from five 24 ms logical frames", () => {
    const sync = new DabPlusSuperframeSynchronizer(),
      encoded = makeSuperframe();
    for (let index = 0; index < 4; index += 1)
      expect(
        sync.push(encoded.slice(index * 24, (index + 1) * 24)),
      ).toBeUndefined();
    expect(sync.push(encoded.slice(96))).toMatchObject({
      accessUnits: expect.any(Array),
    });
    expect(sync.diagnostics).toMatchObject({
      candidateWindows: 1,
      reedSolomonFailures: 0,
      bestCorrectedColumns: 1,
    });
  });

  it("reports how far a rejected Reed-Solomon candidate decoded", () => {
    const sync = new DabPlusSuperframeSynchronizer(),
      encoded = makeSuperframe();
    for (let index = 60; index < 66; index += 1)
      encoded[index] = encoded[index]! ^ 0xff;
    for (let index = 0; index < 5; index += 1)
      sync.push(encoded.slice(index * 24, (index + 1) * 24));
    expect(sync.diagnostics).toMatchObject({
      candidateWindows: 1,
      reedSolomonFailures: 1,
      lastCorrectedColumns: 0,
    });
  });

  it("configures the browser decoder and sends every valid AU", async () => {
    const configure = vi.fn(async () => undefined),
      decode = vi.fn(),
      flush = vi.fn(async () => undefined);
    const audio = {
      configure,
      decode,
      flush,
      reset: vi.fn(),
      close: vi.fn(),
    } as unknown as WebCodecsDabAudioDecoder;
    const programme = new DabPlusProgrammeDecoder(audio);
    const encoded = makeSuperframe();
    for (let index = 0; index < 5; index += 1)
      programme.pushLogicalFrame(encoded.slice(index * 24, (index + 1) * 24));
    await programme.flush();
    expect(configure).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("reports asynchronous browser decoder failures", async () => {
    const failure = new DOMException("AAC unavailable", "NotSupportedError"),
      onError = vi.fn();
    const audio = {
      configure: vi.fn(async () => Promise.reject(failure)),
      decode: vi.fn(),
      flush: vi.fn(async () => undefined),
      reset: vi.fn(),
      close: vi.fn(),
    } as unknown as WebCodecsDabAudioDecoder;
    const programme = new DabPlusProgrammeDecoder(audio, undefined, onError);
    const encoded = makeSuperframe();
    for (let index = 0; index < 5; index += 1)
      programme.pushLogicalFrame(encoded.slice(index * 24, (index + 1) * 24));
    await programme.flush();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(audio.decode).not.toHaveBeenCalled();
  });
  it("discards pending audio delivery when reception is reset", async () => {
    let ready!: () => void;
    const decode = vi.fn();
    const audio = {
      configure: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      ),
      reset: vi.fn(),
      decode,
      flush: vi.fn(async () => undefined),
    } as unknown as WebCodecsDabAudioDecoder;
    const programme = new DabPlusProgrammeDecoder(audio);
    const encoded = makeSuperframe();
    for (let i = 0; i < 5; i += 1)
      programme.pushLogicalFrame(encoded.slice(i * 24, (i + 1) * 24));
    await Promise.resolve();
    programme.reset();
    ready();
    await programme.flush();
    expect(decode).not.toHaveBeenCalled();
  });
});

it("extracts live text from CRC-validated AAC without changing the decoder payload", async () => {
  const audio = {
    configure: vi.fn().mockResolvedValue(undefined),
    decode: vi.fn(),
    reset: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebCodecsDabAudioDecoder;
  const update = vi.fn(),
    programme = new DabPlusProgrammeDecoder(
      audio,
      undefined,
      undefined,
      update,
    );
  // DLS single UTF-8 segment: Song, CRC, then variable X-PAD (8-byte field).
  const group = withCrc(Uint8Array.of(0x63, 0xf0, 83, 111, 110, 103));
  const xpad = Uint8Array.of(0x42, 0, ...group).reverse();
  const payload = new Uint8Array(20);
  payload.set(Uint8Array.of(0x80, 12, ...xpad, 0x20, 2));
  const frame = makeSuperframe(payload);
  for (let i = 0; i < 5; i++)
    programme.pushLogicalFrame(frame.subarray(i * 24, (i + 1) * 24));
  expect(update).toHaveBeenLastCalledWith({ text: "Song" });
  await programme.flush();
  expect(audio.decode).toHaveBeenCalledWith(payload);
  programme.reset();
  expect(update).toHaveBeenLastCalledWith({});
});
