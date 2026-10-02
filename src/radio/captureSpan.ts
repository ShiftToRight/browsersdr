/**
 * Keeps the complete channel passband away from the capture's Nyquist edge.
 * The 20 kHz guard is wider than the center-to-first-null estimate for the
 * installed 151-tap Hamming FIR at 1.024 MS/s (~13.6 kHz).
 */
export const CAPTURE_EDGE_GUARD_HZ = 20_000;

/** Preserve the conservative 151-tap FIR guard in normalized frequency units. */
export function captureEdgeGuardHz(sampleRateHz: number): number {
  return (CAPTURE_EDGE_GUARD_HZ * sampleRateHz) / 1_024_000;
}
