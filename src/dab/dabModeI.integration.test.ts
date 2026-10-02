import { getRealResampler } from "@jtarrio/signals/dsp/resamplers.js";
import { describe, expect, it, vi } from "vitest";
import { DAB_MODE_I_NULL, DabModeIProcessor } from "./dabModeI";
import { ficBits, mscBits, transmissionBody } from "../testing/dabEnsembleFixture";

describe("DAB Mode-I live chain", () => {
  it.each([
    [2_048_000, 0],
    [2_400_000, 0],
    [2_400_000, 2180],
    [2_400_000, -3180],
  ])(
    "decodes null/OFDM/FIC/MSC at %i samples/s with %i Hz offset",
    (sampleRateHz, frequencyOffsetHz) => {
      const logical = Uint8Array.from({ length: 24 }, (_, index) => index * 9),
        body = transmissionBody(ficBits(), mscBits(logical)),
        delivered = vi.fn(),
        status = vi.fn(),
        processor = new DabModeIProcessor(delivered, status);
      processor.setSampleRate(sampleRateHz);
      const upsampleI =
          sampleRateHz === 2_048_000
            ? undefined
            : getRealResampler(2_048_000, sampleRateHz),
        upsampleQ = upsampleI?.clone(),
        phaseStep = (2 * Math.PI * frequencyOffsetHz) / 2_048_000;
      let sampleIndex = 0;
      const push = (I: Float32Array, Q: Float32Array) => {
        const shiftedI = new Float32Array(I.length),
          shiftedQ = new Float32Array(Q.length);
        for (let i = 0; i < I.length; i += 1) {
          const angle = phaseStep * sampleIndex++,
            c = Math.cos(angle),
            s = Math.sin(angle);
          shiftedI[i] = I[i]! * c - Q[i]! * s;
          shiftedQ[i] = I[i]! * s + Q[i]! * c;
        }
        const nativeI = upsampleI?.resample(shiftedI) ?? shiftedI;
        const nativeQ = upsampleQ?.resample(shiftedQ) ?? shiftedQ;
        for (let offset = 0; offset < nativeI.length; offset += 32_768)
          processor.push(
            nativeI.subarray(offset, offset + 32_768),
            nativeQ.subarray(offset, offset + 32_768),
          );
      };
      const warmI = body.I.slice(0, 8_192),
        warmQ = body.Q.slice(0, 8_192),
        nulls = new Float32Array(DAB_MODE_I_NULL);
      // Real null symbols contain receiver noise and occasional impulses. A
      // detector based on consecutive raw samples loses acquisition here;
      // the energy-envelope detector must retain it.
      for (let index = 31; index < nulls.length; index += 127)
        nulls[index] = 0.02;
      push(warmI, warmQ);
      for (let frame = 0; frame < 12; frame += 1) {
        push(nulls, nulls);
        // AGC level changes must not defeat tracking after acquisition.
        const gain = [1, 0.35, 2, 0.8][frame & 3]!;
        push(
          body.I.map((value) => value * gain),
          body.Q.map((value) => value * gain),
        );
      }
      push(warmI, warmQ);
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({ state: "service", ficBlocks: 12 }),
      );
      expect(status.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ state: "service", ficBlocks: 144 }),
      );
      expect(delivered).toHaveBeenCalledWith(logical);
    },
    20_000,
  );
});

it.each([false, true])(
  "chooses the stronger FIC convention after a corrupt startup frame (reversed=%s)",
  (reversed) => {
    const logical = Uint8Array.from({ length: 24 }, (_, index) => index * 9);
    const fic = ficBits(),
      msc = mscBits(logical);
    if (reversed) {
      // Change the transmitted quadrature bit convention independently of the
      // receiver. The chosen convention must correct both FIC and MSC payloads.
      for (const bits of [fic, msc])
        for (let symbol = 0; symbol < bits.length; symbol += 3_072)
          for (let bit = symbol + 1_536; bit < symbol + 3_072; bit++)
            bits[bit] = bits[bit]! ^ 1;
    }
    const body = transmissionBody(fic, msc);
    const corrupt = transmissionBody(new Uint8Array(9_216), mscBits(logical));
    const delivered = vi.fn(),
      status = vi.fn();
    const processor = new DabModeIProcessor(delivered, status);
    processor.setSampleRate(2_048_000);
    const nulls = new Float32Array(DAB_MODE_I_NULL);
    processor.push(body.I.subarray(0, 8_192), body.Q.subarray(0, 8_192));
    processor.push(nulls, nulls);
    processor.push(corrupt.I, corrupt.Q);
    for (let frame = 0; frame < 12; frame++) {
      processor.push(nulls, nulls);
      processor.push(body.I, body.Q);
    }
    processor.push(body.I.subarray(0, 8_192), body.Q.subarray(0, 8_192));
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({
      quadraturePolarity: reversed ? "reversed" : "standard",
      // Fresh null acquisition after the corrupt frame skips one good frame.
      ficCompleteFrames: 11,
      ficBlocks: 132,
      ficAttempts: 144,
      ficFrames: 12,
    });
    expect(delivered).toHaveBeenCalledWith(logical);
  },
);

it("switches MSC programmes while preserving FIC synchronization", () => {
  const first = new Uint8Array(24).fill(0x31),
    second = new Uint8Array(24).fill(0x92);
  const msc = mscBits(first),
    secondMsc = mscBits(second);
  for (let cif = 0; cif < 4; cif++)
    msc.set(
      secondMsc.subarray(cif * 55296, cif * 55296 + 384),
      cif * 55296 + 384,
    );
  const body = transmissionBody(ficBits(true), msc);
  const delivered = vi.fn(),
    status = vi.fn(),
    changed = vi.fn();
  const processor = new DabModeIProcessor(delivered, status, changed);
  processor.setSampleRate(2048000);
  processor.push(body.I.subarray(0, 8192), body.Q.subarray(0, 8192));
  const nulls = new Float32Array(DAB_MODE_I_NULL);
  const frames = () => {
    for (let i = 0; i < 10; i++) {
      processor.push(nulls, nulls);
      processor.push(body.I, body.Q);
    }
  };
  frames();
  expect(delivered).toHaveBeenCalledWith(first);
  const before = status.mock.calls.at(-1)![0];
  processor.selectService("4661:1");
  expect(status.mock.calls.at(-1)![0]).toMatchObject({
    ficFrames: before.ficFrames,
    service: { serviceId: 4661 },
  });
  delivered.mockClear();
  frames();
  expect(delivered).toHaveBeenCalledWith(second);
  expect(delivered).not.toHaveBeenCalledWith(first);
  expect(changed).toHaveBeenCalledTimes(2);
  processor.selectService("invalid");
  processor.selectService("4661:1");
  expect(changed).toHaveBeenCalledTimes(2);
});
