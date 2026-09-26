import { describe, expect, it } from "vitest";
import {
  DAB_MODE_I_CARRIERS,
  DAB_MODE_I_FFT,
  DAB_MODE_I_GUARD,
  DAB_MODE_I_SYMBOL,
  DAB_MODE_I_SYMBOLS,
  createDabCarrierMap,
  demapDabDqpsk,
  findDabModeITimingStart,
} from "./dabModeI";

describe("DAB Mode-I OFDM", () => {
  it("constructs the standard one-to-one carrier permutation", () => {
    const map = createDabCarrierMap();
    expect(map).toHaveLength(DAB_MODE_I_CARRIERS);
    expect(new Set(map).size).toBe(DAB_MODE_I_CARRIERS);
    expect(Math.min(...map)).toBe(0);
    expect(Math.max(...map)).toBe(DAB_MODE_I_CARRIERS - 1);
  });

  it("frequency-deinterleaves differential QPSK into soft bits", () => {
    const map = createDabCarrierMap(),
      previousI = new Float32Array(DAB_MODE_I_FFT),
      previousQ = new Float32Array(DAB_MODE_I_FFT),
      currentI = new Float32Array(DAB_MODE_I_FFT),
      currentQ = new Float32Array(DAB_MODE_I_FFT);
    for (let logical = 0; logical < DAB_MODE_I_CARRIERS; logical += 1) {
      const physical = map[logical]!,
        carrier = physical < 768 ? physical - 768 : physical - 767,
        bin = (DAB_MODE_I_FFT + carrier) % DAB_MODE_I_FFT;
      previousI[bin] = 1;
      currentI[bin] = logical & 1 ? -1 : 1;
      currentQ[bin] = logical & 2 ? -1 : 1;
    }
    const bits = demapDabDqpsk(previousI, previousQ, currentI, currentQ);
    for (let logical = 0; logical < DAB_MODE_I_CARRIERS; logical += 1) {
      expect(bits[logical]! > 0).toBe(Boolean(logical & 1));
      expect(bits[logical + DAB_MODE_I_CARRIERS]! > 0).toBe(
        Boolean(logical & 2),
      );
    }
  });

  it("down-weights carriers in a deep frequency-selective fade", () => {
    const map = createDabCarrierMap(),
      previousI = new Float32Array(DAB_MODE_I_FFT),
      previousQ = new Float32Array(DAB_MODE_I_FFT),
      currentI = new Float32Array(DAB_MODE_I_FFT),
      currentQ = new Float32Array(DAB_MODE_I_FFT),
      fadedLogical = 731;
    for (let logical = 0; logical < DAB_MODE_I_CARRIERS; logical += 1) {
      const physical = map[logical]!,
        carrier = physical < 768 ? physical - 768 : physical - 767,
        bin = (DAB_MODE_I_FFT + carrier) % DAB_MODE_I_FFT,
        amplitude = logical === fadedLogical ? 0.04 : 1;
      previousI[bin] = 1;
      currentI[bin] = amplitude;
      currentQ[bin] = amplitude;
    }

    const bits = demapDabDqpsk(previousI, previousQ, currentI, currentQ);
    expect(Math.abs(bits[0]!)).toBeGreaterThan(120);
    expect(Math.abs(bits[fadedLogical]!)).toBeLessThan(10);
    expect(
      Math.abs(bits[fadedLogical + DAB_MODE_I_CARRIERS]!),
    ).toBeLessThan(10);
  });

  it("removes residual common DQPSK phase before producing soft bits", () => {
    const map = createDabCarrierMap(),
      previousI = new Float32Array(DAB_MODE_I_FFT),
      previousQ = new Float32Array(DAB_MODE_I_FFT),
      currentI = new Float32Array(DAB_MODE_I_FFT),
      currentQ = new Float32Array(DAB_MODE_I_FFT),
      rotation = (38 * Math.PI) / 180,
      cosine = Math.cos(rotation),
      sine = Math.sin(rotation);
    for (let logical = 0; logical < DAB_MODE_I_CARRIERS; logical += 1) {
      const physical = map[logical]!,
        carrier = physical < 768 ? physical - 768 : physical - 767,
        bin = (DAB_MODE_I_FFT + carrier) % DAB_MODE_I_FFT,
        expectedI = logical & 1 ? -1 : 1,
        expectedQ = logical & 2 ? -1 : 1;
      previousI[bin] = 1;
      currentI[bin] = expectedI * cosine - expectedQ * sine;
      currentQ[bin] = expectedI * sine + expectedQ * cosine;
    }

    const bits = demapDabDqpsk(previousI, previousQ, currentI, currentQ);
    for (let logical = 0; logical < DAB_MODE_I_CARRIERS; logical += 1) {
      expect(bits[logical]! > 0).toBe(Boolean(logical & 1));
      expect(bits[logical + DAB_MODE_I_CARRIERS]! > 0).toBe(
        Boolean(logical & 2),
      );
    }
  });

  it("finds a delayed cyclic-prefix boundary from the received samples", () => {
    const offset = 237,
      length = DAB_MODE_I_SYMBOL * DAB_MODE_I_SYMBOLS + 512,
      frameI = new Float32Array(length),
      frameQ = new Float32Array(length);
    for (let symbol = 0; symbol < DAB_MODE_I_SYMBOLS; symbol += 1) {
      const usefulI = new Float32Array(DAB_MODE_I_FFT),
        usefulQ = new Float32Array(DAB_MODE_I_FFT);
      for (let index = 0; index < DAB_MODE_I_FFT; index += 1) {
        usefulI[index] = Math.sin((index + symbol * 17) * 0.071);
        usefulQ[index] = Math.cos((index + symbol * 29) * 0.053);
      }
      const start = offset + symbol * DAB_MODE_I_SYMBOL;
      frameI.set(usefulI.subarray(DAB_MODE_I_FFT - DAB_MODE_I_GUARD), start);
      frameQ.set(usefulQ.subarray(DAB_MODE_I_FFT - DAB_MODE_I_GUARD), start);
      frameI.set(usefulI, start + DAB_MODE_I_GUARD);
      frameQ.set(usefulQ, start + DAB_MODE_I_GUARD);
    }

    expect(findDabModeITimingStart(frameI, frameQ)).toBe(offset);
  });
});
