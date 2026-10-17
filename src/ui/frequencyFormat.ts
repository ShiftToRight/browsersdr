/** Show at least three decimals, retaining every significant whole-Hz digit. */
export function formatFrequencyMHz(frequencyHz: number): string {
  return Number.isFinite(frequencyHz)
    ? (frequencyHz / 1_000_000).toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1")
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
