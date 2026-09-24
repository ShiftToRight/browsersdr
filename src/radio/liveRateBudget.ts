/** Signals 0.10.1 builds exact rational polyphase filters. Never round a rate
 * 1.024 MS/s -> 44.1 kHz needs 441 phases / 66,591 taps; keep
 * that documented rate usable while rejecting fractional-rate explosions. Never round
 * to hide an unsupported allocation; apply this guard before its setters. */
export function validateLiveRateBudget(sampleRate: number, audioSampleRate: number): void {
  for (const output of [audioSampleRate, 336_000]) {
    let a = sampleRate, b = output;
    while (b) { const remainder = a % b; a = b; b = remainder; }
    const phases = output / a;
    if (!Number.isFinite(phases) || phases > 512 || Math.round(151 * phases) > 80_000) {
      throw new Error("Reported sample rate exceeds the installed Signals resampler budget; this rate is unsupported without a bounded DSP adapter.");
    }
  }
}
