import { describe, expect, it, vi } from "vitest";
import { DAB_FRAME_SAMPLES, DAB_NULL_SAMPLES, DabReceiver, validateDabSampleRate } from "./dabReceiver";

function tone(length: number, amplitude: number, phaseStep = 0.17) {
  const I = new Float32Array(length), Q = new Float32Array(length);
  for (let index = 0; index < length; index += 1) { I[index] = amplitude * Math.cos(index * phaseStep); Q[index] = amplitude * Math.sin(index * phaseStep); }
  return { I, Q, frequency: 220_352_000 };
}

describe("DabReceiver", () => {
  it("acquires a mode-I frame from its null symbol", () => {
    const update = vi.fn(), receiver = new DabReceiver(update);
    receiver.setSampleRate(2_048_000);
    receiver.receiveSamples(tone(24_000, 0.7));
    receiver.receiveSamples(tone(DAB_NULL_SAMPLES, 0.01));
    receiver.receiveSamples(tone(2_552, 0.7));
    expect(receiver.current.state).toBe("synchronized");
    expect(receiver.current.nullSymbolCount).toBe(1);
    expect(receiver.current.estimatedSnrDb).toBeGreaterThan(20);
  });
  it("reports lost lock when the next frame does not arrive", () => {
    const receiver = new DabReceiver(() => undefined);
    receiver.receiveSamples(tone(24_000, 0.7)); receiver.receiveSamples(tone(DAB_NULL_SAMPLES, 0.01)); receiver.receiveSamples(tone(2_552, 0.7));
    receiver.receiveSamples(tone(DAB_FRAME_SAMPLES * 2, 0.7));
    expect(receiver.current.state).toBe("lost");
  });
  it("rejects captures too narrow for a complete ensemble", () => {
    expect(() => validateDabSampleRate(1_024_000)).toThrow(/2.048 MS\/s/);
    expect(() => validateDabSampleRate(2_400_000)).not.toThrow();
  });
});
