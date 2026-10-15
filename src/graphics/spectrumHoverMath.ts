export interface HoverSpectrumFrame {
  center: number;
  rate: number;
  bins?: Float32Array;
  columns: number;
  floor: number;
  range: number;
}

/** Sample the rendered polyline, including Canvas2D's peak-preserving columns. */
export function sampleSpectrumTrace(frame: HoverSpectrumFrame, fraction: number) {
  const { bins, columns, floor, range } = frame;
  if (!bins?.length || columns < 2 || range <= 0) return undefined;
  const position = Math.max(0, Math.min(1, fraction)) * (columns - 1);
  const left = Math.floor(position), right = Math.min(columns - 1, left + 1);
  const column = (index: number) => {
    const start = Math.floor(index * bins.length / columns);
    const end = Math.max(start + 1, Math.floor((index + 1) * bins.length / columns));
    let peak = -Infinity;
    for (let bin = start; bin < end; bin++) {
      const value = bins[bin]!;
      if (Number.isFinite(value) && value > -1000) peak = Math.max(peak, value);
    }
    return peak;
  };
  const a = column(left), b = column(right), mix = position - left;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  const normalized = (value: number) => Math.max(0, Math.min(1, (value - floor) / range));
  return {
    level: a + (b - a) * mix,
    y: 0.375 - (normalized(a) + (normalized(b) - normalized(a)) * mix) * 0.335,
  };
}
