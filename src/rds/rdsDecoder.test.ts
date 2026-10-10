import { describe, expect, it } from "vitest";
import { RdsDecoder } from "./rdsDecoder";
import { createRdsMultiplexFixture } from "../testing/rdsFixture";

function decodeInBlocks(samples: Float32Array, blocks: readonly number[] = [samples.length], rate = 228_000) {
  const decoder = new RdsDecoder();
  decoder.configure(rate);
  let position = 0;
  let block = 0;
  while (position < samples.length) {
    const length = blocks[block++ % blocks.length]!;
    decoder.process(samples.subarray(position, Math.min(samples.length, position + length)));
    position += length;
  }
  return decoder;
}

describe("RDS decoder", () => {
  it.each([228_000, 336_000])("isolates low-level RDS from stronger mono, pilot and stereo at %i sample/s", rate => {
    const fixture = createRdsMultiplexFixture({ sampleRate: rate, rdsAmplitude: 0.03,
      pilotAmplitude: 0.09, audioAmplitude: 0.36, stereoAmplitude: 0.18, carrierOffsetHz: 0.3 });
    const decoder = decodeInBlocks(fixture.subarray(37), [1, 173, 4097, 29, 8192], rate);
    expect(decoder.getState()).toMatchObject({ pi: "C201", programmeService: "CODEX FM",
      radioText: "BrowserSDR RDS fixture" });
    expect(decoder.getState().validGroups).toBeGreaterThanOrEqual(10);
    expect(decoder.getState()).toEqual(decodeInBlocks(fixture.subarray(37), undefined, rate).getState());
  });

  it("withholds station data on noise with strong audio and pilot", () => {
    const samples = new Float32Array(228_000);
    let seed = 1;
    for (let n = 0; n < samples.length; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const time = n / 228_000;
      samples[n] = 0.1 * (seed / 2 ** 32 - 0.5)
        + 0.1 * Math.cos(2 * Math.PI * 19_000 * time)
        + 0.4 * Math.sin(2 * Math.PI * 1_000 * time);
    }
    expect(decodeInBlocks(samples).getState()).toEqual({
      pi: null, programmeService: null, radioText: null, validGroups: 0,
    });
  });

  it("recovers validated PI, Programme Service and RadioText across arbitrary blocks", () => {
    const decoder = decodeInBlocks(createRdsMultiplexFixture().subarray(37), [1, 173, 4097, 29, 8192]);
    expect(decoder.getState()).toMatchObject({
      pi: "C201",
      programmeService: "CODEX FM",
      radioText: "BrowserSDR RDS fixture",
    });
    expect(decoder.getState().validGroups).toBeGreaterThanOrEqual(10);
  });

  it("rejects a group containing a corrupted block", () => {
    const clean = decodeInBlocks(createRdsMultiplexFixture()).getState();
    const corrupt = decodeInBlocks(createRdsMultiplexFixture({ corruptGroup: 2 })).getState();
    expect(corrupt.validGroups).toBe(clean.validGroups - 1);
    expect(corrupt.programmeService).toBe("CODEX FM");
  });

  it("clears segmented text and station identity on reset", () => {
    const decoder = decodeInBlocks(createRdsMultiplexFixture());
    decoder.reset();
    expect(decoder.getState()).toEqual({ pi: null, programmeService: null, radioText: null, validGroups: 0 });
  });

  it("clears old strings when PI or RadioText A/B changes", () => {
    const decoder = new RdsDecoder();
    decoder.configure(228_000);
    decoder.process(createRdsMultiplexFixture({ pi: 0x1234, programmeService: "FIRST FM", radioText: "First text" }));
    expect(decoder.getState().programmeService).toBe("FIRST FM");
    decoder.process(createRdsMultiplexFixture({ pi: 0x5678, programmeService: "NEXT FM", radioText: "Second text" }));
    expect(decoder.getState()).toMatchObject({ pi: "5678", programmeService: "NEXT FM", radioText: "Second text" });
    decoder.process(createRdsMultiplexFixture({ pi: 0x5678, programmeService: "NEXT FM", radioText: "A/B replacement", radioTextAb: 1 }));
    expect(decoder.getState()).toMatchObject({ pi: "5678", radioText: "A/B replacement" });
  });
});
