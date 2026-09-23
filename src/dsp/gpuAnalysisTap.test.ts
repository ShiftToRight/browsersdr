import { describe, expect, it } from "vitest";
import { GpuAnalysisTap, type GpuInputBlock } from "./gpuAnalysisTap";
import { checkGpuFftLimits, gpuFftSize } from "./gpuSpectrum";

const block = (length: number, extra: Partial<GpuInputBlock> = {}): GpuInputBlock => ({
  I: new Float32Array(length).fill(0.5), Q: new Float32Array(length).fill(-0.25),
  sessionGeneration: 2, centerFrequencyHz: 100e6, sampleRateHz: 1024000,
  discontinuity: false, missingSamples: 0, ...extra,
});
describe("experimental GPU analysis ownership", () => {
  it("keeps the source clock when graphics initialization or retry attaches late", () => {
    const frames: number[] = [];
    const tap = new GpuAnalysisTap(4096, 2, async (_, frame) => { frames.push(frame.sampleIndex); }, () => {});
    tap.accept(block(16384, { sampleIndex: 50000, discontinuity: true, missingSamples: 123 }));
    expect(frames).toEqual([66384]);
  });
  it("assembles split blocks, copies borrowed arrays and bounds pending work", async () => {
    let finish!: () => void;
    const submitted: { input: Float32Array; sampleIndex: number; dropped: number }[] = [];
    const tap = new GpuAnalysisTap(4096, 2, (input, frame) => {
      submitted.push({ input: input.slice(), sampleIndex: frame.sampleIndex, dropped: frame.droppedFramesBefore });
      return new Promise<void>((resolve) => { finish = resolve; });
    }, () => { throw new Error("unexpected failure"); });
    const first = block(8000); tap.accept(first, 0); first.I.fill(99);
    tap.accept(block(8384), 0);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.input[0]).toBe(0.5);
    expect(submitted[0]!.input[1]).toBe(-0.25);
    for (let k = 0; k < 10; k++) tap.accept(block(16384), 100);
    expect(submitted).toHaveLength(1);
    finish(); await Promise.resolve();
    tap.accept(block(16384), 200);
    expect(submitted[1]!.sampleIndex).toBe(12 * 16384);
    expect(submitted[1]!.dropped).toBe(10);
    tap.dispose(); finish(); await Promise.resolve(); tap.accept(block(16384), 300);
    expect(submitted).toHaveLength(2);
  });
  it("rejects generations and resets partial averages across gaps", () => {
    const frames: number[] = [];
    const tap = new GpuAnalysisTap(4096, 2, async (_, frame) => { frames.push(frame.sampleIndex); }, () => {});
    tap.accept(block(16384, { sessionGeneration: 1 }));
    tap.accept(block(1000));
    tap.accept(block(16000, { discontinuity: true, missingSamples: 500 }));
    expect(frames).toEqual([]);
    tap.accept(block(384));
    expect(frames).toEqual([17884]);
  });
  it("disables after submission failure without throwing into acquisition", async () => {
    let failures = 0; let submissions = 0;
    const tap = new GpuAnalysisTap(4096, 2, async () => { submissions++; throw new Error("lost"); }, () => { failures++; });
    tap.accept(block(16384)); await Promise.resolve(); await Promise.resolve();
    tap.accept(block(16384));
    expect(failures).toBe(1); expect(submissions).toBe(1);
  });
  it("keeps GPU opt-in and restricts sizes and limits", () => {
    expect(gpuFftSize("")).toBeUndefined();
    expect(gpuFftSize("?analysis=wasm")).toBeUndefined();
    expect(gpuFftSize("?analysis=gpu")).toBe(4096);
    expect(gpuFftSize("?analysis=gpu&fft=16384")).toBe(16384);
    expect(() => checkGpuFftLimits({ limits: {} as GPUSupportedLimits }, 8192)).toThrow(/only/);
    expect(() => checkGpuFftLimits({ limits: { maxBufferSize: 1024 } as GPUSupportedLimits }, 4096)).toThrow(/limits/);
  });
});
