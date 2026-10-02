/** One-shot display scaling in relative dB; it does not change receiver gain. */
export function spectrumDisplayScale(
  bins: Float32Array,
): { floorDb: number; rangeDb: number } | undefined {
  const levels = Array.from(bins)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!levels.length) return undefined;
  const floorDb = Math.max(
    -120,
    Math.min(-30, Math.floor(levels[Math.floor(levels.length * 0.1)]! - 8)),
  );
  const rangeDb = Math.max(
    20,
    Math.min(120, Math.ceil(levels[levels.length - 1]! + 6 - floorDb)),
  );
  return { floorDb, rangeDb };
}
