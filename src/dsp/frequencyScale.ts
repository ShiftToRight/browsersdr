export function spectrumEdges(centerFrequencyHz: number, sampleRateHz: number): readonly [number, number, number] {
  return [centerFrequencyHz - sampleRateHz / 2, centerFrequencyHz, centerFrequencyHz + sampleRateHz / 2];
}

export function shiftedBinForOffset(offsetHz: number, sampleRateHz: number, fftSize: number): number {
  return Math.round(offsetHz / (sampleRateHz / fftSize)) + fftSize / 2;
}

export function frequencyForPixel(
  pixelX: number,
  width: number,
  centerFrequencyHz: number,
  sampleRateHz: number,
): number {
  if (!Number.isFinite(width) || width <= 0) return centerFrequencyHz;
  const fraction = Math.max(0, Math.min(1, pixelX / width));
  return centerFrequencyHz + (fraction - 0.5) * sampleRateHz;
}
