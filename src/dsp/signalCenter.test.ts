import { describe, expect, it } from "vitest";
import { SignalCenterEstimator, type SignalCenterResult } from "./signalCenter";
import type { SourceSessionMetadata } from "../radio/types";

function metadata(
  mode: "AM" | "NBFM" | "WBFM",
  rate = 1_024_000,
): SourceSessionMetadata {
  return {
    source: "replay",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: 100_000_000,
    selectedChannelFrequencyHz: 100_120_000,
    mode,
    channelBandwidthHz: mode === "WBFM" ? 150_000 : 12_500,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
}
function measure(
  session: SourceSessionMetadata,
  offset: number,
  options: {
    noise?: number;
    amplitude?: number;
    adjacent?: number;
    adjacentAmplitude?: number;
    dc?: boolean;
    duration?: number;
    modulation?: boolean;
    depth?: number;
    drift?: number;
    burst?: boolean;
    fade?: boolean;
    adjacentModulation?: boolean;
    deviation?: number;
  } = {},
): SignalCenterResult | undefined {
  const estimator = new SignalCenterEstimator(session);
  let phase = 0,
    otherPhase = 0;
  let seed = 12345;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const native =
    session.selectedChannelFrequencyHz - session.hardwareCenterFrequencyHz;
  const deviation =
    options.deviation ??
    (session.mode === "WBFM"
      ? 55_000
      : Math.min(2500, session.channelBandwidthHz * 0.2));
  for (
    let start = 0;
    start < session.actualSampleRateHz * (options.duration ?? 0.7);
    start += 8192
  ) {
    const I = new Float32Array(8192),
      Q = new Float32Array(8192);
    for (let n = 0; n < 8192; n++) {
      const t = (start + n) / session.actualSampleRateHz;
      const mod =
        options.modulation === false
          ? 0
          : Math.sin(
              2 * Math.PI * Math.min(1000, session.channelBandwidthHz / 8) * t,
            ) +
            (options.depth === 1 ? 0 : 0.1 * Math.sin(2 * Math.PI * 71 * t));
      const f = options.dc
        ? 0
        : native +
          offset +
          (options.drift ?? 0) * t +
          (session.mode === "AM" ? 0 : deviation * mod);
      phase += (2 * Math.PI * f) / session.actualSampleRateHz;
      const amplitude =
        (options.burst && t > 0.2 ? 0 : (options.amplitude ?? 0.7)) *
        (options.fade ? 0.2 + 0.8 * Math.sin(2 * Math.PI * 4 * t) ** 2 : 1) *
        (session.mode === "AM" ? 1 + (options.depth ?? 0.6) * mod : 1);
      otherPhase +=
        (2 *
          Math.PI *
          (native +
            (options.adjacent ?? 0) +
            (options.adjacentModulation
              ? deviation * Math.sin(2 * Math.PI * 731 * t)
              : 0))) /
        session.actualSampleRateHz;
      I[n] =
        amplitude * Math.cos(phase) +
        (options.noise ?? 0.015) * noise() +
        (options.adjacent === undefined
          ? 0
          : (options.adjacentAmplitude ?? 0.7) * Math.cos(otherPhase));
      Q[n] =
        amplitude * Math.sin(phase) +
        (options.noise ?? 0.015) * noise() +
        (options.adjacent === undefined
          ? 0
          : (options.adjacentAmplitude ?? 0.7) * Math.sin(otherPhase));
    }
    const result = estimator.accept(I, Q);
    if (result) return result;
  }
  return undefined;
}

describe("bounded local signal center", () => {
  for (const mode of ["AM", "NBFM", "WBFM"] as const) {
    for (const offset of [-1_350, 1_735])
      it(`${mode} measures ${offset} Hz with modulation`, () => {
        const result = measure(metadata(mode), offset);
        expect(result?.kind, result?.message).toBe("estimate");
        expect(result?.offsetHz).toBeCloseTo(offset, -2);
      });
    it(`${mode} reports an already centered measurement`, () => {
      const result = measure(metadata(mode), 0);
      expect(result?.kind, result?.message).toBe("estimate");
      expect(Math.abs(result!.offsetHz!)).toBeLessThan(result!.toleranceHz!);
    });
    it(`${mode} rejects noise and a weak signal`, () => {
      expect(
        measure(metadata(mode), 1200, { amplitude: 0, noise: 0.5 })?.kind,
      ).toBe("no-signal");
      expect(
        measure(metadata(mode), 1200, { amplitude: 0.001, noise: 0.5 })?.kind,
      ).toBe("no-signal");
    });
    it(`${mode} rejects ambiguity`, () => {
      expect(measure(metadata(mode), -1500, { adjacent: 2800 })?.kind).toBe(
        "no-signal",
      );
    });
    it(`${mode} rejects hardware DC artifacts`, () => {
      const session = metadata(mode);
      session.selectedChannelFrequencyHz = session.hardwareCenterFrequencyHz;
      expect(measure(session, 0, { dc: true, modulation: false })?.kind).toBe(
        "no-signal",
      );
    });
    it(`${mode} rejects capture-edge measurements`, () => {
      const session = metadata(mode);
      session.selectedChannelFrequencyHz =
        session.hardwareCenterFrequencyHz +
        session.actualSampleRateHz / 2 -
        session.channelBandwidthHz / 2 -
        10_000;
      expect(measure(session, 0)?.kind).toBe("no-signal");
    });
    it(`${mode} supports 2.4 MS/s`, () => {
      const result = measure(metadata(mode, 2_400_000), -1700);
      expect(result?.kind, result?.message).toBe("estimate");
      expect(result?.offsetHz).toBeCloseTo(-1700, -2);
    });
  }
  it("accepts ordinary 100%-depth AM sidebands", () => {
    const result = measure(metadata("AM"), 1700, { depth: 1 });
    expect(result?.kind, result?.message).toBe("estimate");
    expect(result?.offsetHz).toBeCloseTo(1700, -1);
  });
  it("rejects a moving or intermittent AM carrier", () => {
    expect(measure(metadata("AM"), 1000, { drift: 3000 })?.kind).toBe(
      "no-signal",
    );
    expect(measure(metadata("AM"), 1000, { burst: true })?.kind).toBe(
      "no-signal",
    );
  });
  it.each(["AM", "NBFM"] as const)(
    "measures the minimum 250 Hz %s channel at a native high rate",
    (mode) => {
      const session = metadata(mode, 19_200_000);
      session.channelBandwidthHz = 250;
      const result = measure(session, -65);
      expect(result?.kind, result?.message).toBe("estimate");
      expect(result?.offsetHz).toBeCloseTo(-65, -1);
    },
  );
  it("measures WBFM at the highest native rate", () => {
    const result = measure(metadata("WBFM", 19_200_000), -8000);
    expect(result?.kind, result?.message).toBe("estimate");
    expect(result?.offsetHz).toBeCloseTo(-8000, -2);
  });
  it("does not return a result from short or interrupted input", () => {
    expect(measure(metadata("NBFM"), 1000, { duration: 0.15 })).toBeUndefined();
    expect(
      new SignalCenterEstimator(metadata("NBFM")).accept(
        new Float32Array(8192),
        new Float32Array(8192),
        true,
      )?.kind,
    ).toBe("failure");
  });
  it("never follows a stronger station outside the local correction range", () => {
    expect(
      measure(metadata("NBFM"), 1000, {
        adjacent: 15_000,
        adjacentAmplitude: 3,
      })?.kind,
    ).toBe("no-signal");
  });
  it("rejects FM whose occupied spectrum reaches the analysis edge", () => {
    expect(measure(metadata("WBFM"), 70_000)?.kind).toBe("no-signal");
  });
  it("measures an off-center WBFM station through slow RF envelope fading", () => {
    const result = measure(metadata("WBFM", 2_400_000), -10_500, {
      fade: true,
    });
    expect(result?.diagnostics?.envelopeRatio).toBeGreaterThan(1.3);
    expect(result?.diagnostics?.localEnvelopeRatio).toBeLessThan(1.3);
    expect(result?.kind, result?.message).toBe("estimate");
    expect(result?.offsetHz).toBeCloseTo(-10_500, -2);
  });
  it("rejects overlapping modulated WBFM stations even through slow fading", () => {
    const result = measure(metadata("WBFM", 2_400_000), -10_500, {
      fade: true,
      adjacent: 30_000,
      adjacentModulation: true,
    });
    expect(result?.kind, result?.message).toBe("no-signal");
  });
  it.each(["NBFM", "WBFM"] as const)(
    "rejects close beating unmodulated %s carriers",
    (mode) => {
      const result = measure(metadata(mode), -1500, {
        adjacent: -1450,
        modulation: false,
      });
      expect(result?.kind, result?.message).toBe("no-signal");
    },
  );
  it("rejects an intermittent FM signal", () => {
    const result = measure(metadata("WBFM"), -10_500, { burst: true });
    expect(result?.kind, result?.message).toBe("no-signal");
  });
  it("rejects a noisy hardware DC line when adaptive filtering makes it visible", () => {
    const session = metadata("WBFM", 2_400_000);
    session.selectedChannelFrequencyHz = session.hardwareCenterFrequencyHz + 10_000;
    const result = measure(session, 0, {
      dc: true, modulation: false, amplitude: 0.14, noise: 1,
    });
    expect(result?.kind, result?.message).toBe("no-signal");
  });
  it.each([-10_500, 10_500])(
    "isolates a quiet noisy WBFM station at %s Hz",
    (offset) => {
      const result = measure(metadata("WBFM", 2_400_000), offset, {
        deviation: 6000,
        amplitude: 0.2,
        noise: 1,
      });
      expect(result?.kind, result?.message).toBe("estimate");
      expect(result?.diagnostics?.refinement).toBeDefined();
      expect(
        Math.abs(result!.diagnostics!.refinement!.offsetHz!),
      ).toBeGreaterThan(500);
      expect(result?.diagnostics?.envelopeRatio).toBeGreaterThan(1.3);
      expect(result?.diagnostics?.refinement?.envelopeRatio).toBeLessThan(1.3);
      expect(Math.abs(result!.offsetHz! - offset)).toBeLessThan(500);
    },
  );
});
