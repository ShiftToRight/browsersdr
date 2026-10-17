import { formatFrequencyMHz } from "../ui/frequencyFormat";

/** Fixed fractional positions preserve the exact RF window; width limits label density. */
export function spectrumFrequencyTicks(centerHz: number, rateHz: number, width: number) {
  if (!Number.isFinite(centerHz) || !Number.isFinite(rateHz) || rateHz <= 0) return [];
  const ticks = (intervals: number) => Array.from({length: intervals + 1}, (_, index) => {
    const fraction = index / intervals;
    const frequencyHz = centerHz + (fraction - 0.5) * rateHz;
    return {fraction, frequencyHz, label: `${formatFrequencyMHz(frequencyHz)} MHz`};
  });
  // Power-of-two subdivisions avoid repeating decimal fractions. Check anchored
  // edge labels too: they need more room than two centered labels do.
  const available = Math.max(0, width - 28);
  for (const intervals of [8, 4, 2]) {
    const result = ticks(intervals);
    const boxes = result.map(tick => {
      const size = tick.label.length * 8;
      const left = tick.fraction * available - (tick.fraction === 0 ? 0 : tick.fraction === 1 ? size : size / 2);
      return {left, right: left + size};
    });
    if (intervals === 2 || boxes.every((box, index) => !index || box.left >= boxes[index - 1]!.right + 10)) return result;
  }
  return [];
}
