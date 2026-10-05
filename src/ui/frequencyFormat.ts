/** Compact MHz readouts share 1 kHz display precision without rounding tuning state. */
export function formatFrequencyMHz(frequencyHz: number): string {
  return Number.isFinite(frequencyHz)
    ? (Math.round(frequencyHz / 1_000) / 1_000).toFixed(3)
    : "";
}

/** Editing exposes whole-Hz precision while keeping the accepted value internally. */
export function editableFrequencyMHz(frequencyHz: number): string {
  return Number.isFinite(frequencyHz)
    ? (frequencyHz / 1_000_000).toFixed(6)
    : "";
}

export function formatSampleRate(sampleRateHz: number): string {
  return `${(sampleRateHz / 1_000_000).toFixed(3)} MS/s`;
}
