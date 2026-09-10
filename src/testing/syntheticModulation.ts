import type { SampleGenerator } from "@jtarrio/signals/sources/generated.js";
import { modulateAM, modulateFM, tone } from "@jtarrio/signals/sources/generators.js";

/** Deterministic AM fixture with a continuous carrier and audio tone. */
export function syntheticAm(carrierHz: number, audioToneHz: number, audioAmplitude = 0.7): SampleGenerator {
  return modulateAM(carrierHz, 0.8, tone(audioToneHz, audioAmplitude));
}

/** Deterministic narrow-FM fixture with continuous phase across arbitrary blocks. */
export function syntheticFm(
  carrierHz: number,
  audioToneHz: number,
  maximumDeviationHz: number,
  audioAmplitude = 0.65,
): SampleGenerator {
  return modulateFM(carrierHz, maximumDeviationHz, 0.8, tone(audioToneHz, audioAmplitude));
}

/**
 * An analytic single-sideband fixture. A positive audio offset is USB and a
 * negative offset is LSB; its absolute offset is the recovered audio tone.
 */
export function syntheticSideband(
  carrierHz: number,
  audioToneHz: number,
  sideband: "USB" | "LSB",
  amplitude = 0.7,
): SampleGenerator {
  return tone(carrierHz + (sideband === "USB" ? audioToneHz : -audioToneHz), amplitude);
}
