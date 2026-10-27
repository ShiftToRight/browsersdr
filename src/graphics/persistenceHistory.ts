import type { SpectrumFrame } from "../radio/types";

export const PERSISTENCE_COLUMNS = 512;
export const PERSISTENCE_LEVELS = 128;
export const PERSISTENCE_CAPACITY = 2048;
const EMPTY = 32767;
const QUANTIZATION = 4;

/** A rolling histogram of observed, frequency-peak-pooled display spectra.
 * One observation per column per accepted frame; never time-peak-pool frames.
 * Retained quarter-dB levels permit honest rebinning when the scale changes.
 */
export class PersistenceHistory {
  readonly counts = new Uint16Array(PERSISTENCE_COLUMNS * PERSISTENCE_LEVELS);
  readonly observations = new Uint16Array(PERSISTENCE_COLUMNS);
  private readonly levels = new Int16Array(
    PERSISTENCE_COLUMNS * PERSISTENCE_CAPACITY,
  );
  private readonly times = new Float64Array(PERSISTENCE_CAPACITY);
  private next = 0;
  count = 0;
  gaps = 0;
  private capacityDropAt = -Infinity;
  private context = "";
  private generation = -1;
  private sequence = -1;
  private lastSample = -1;
  private time = 0;
  private timeOffset = 0;
  private continuation?: number;
  private floor = -105;
  private range = 90;
  private seconds = 10;
  latest?: SpectrumFrame;
  revision = 0;

  reset(generation: number): void {
    this.clear();
    this.generation = generation;
    this.context = "";
    this.sequence = this.lastSample = -1;
    this.time = this.timeOffset = 0;
    this.continuation = undefined;
    this.latest = undefined;
  }

  /** Caller must establish compatible channel-only RF metadata. A restarted
   * sample clock is joined at the next observed hop; unknown tune time is
   * excluded, never inferred as quiet RF or continuously observed time. */
  continueGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation)
      return;
    this.generation = generation;
    this.continuation = generation;
    if (this.count) this.gaps++;
    if (this.latest)
      this.latest = { ...this.latest, sessionGeneration: generation };
  }

  clear(): void {
    this.count = this.next = this.gaps = 0;
    this.capacityDropAt = -Infinity;
    this.counts.fill(0);
    this.observations.fill(0);
    this.revision++;
  }

  configure(floor: number, range: number, seconds: number): void {
    if (
      !Number.isFinite(floor) ||
      !Number.isFinite(range) ||
      range <= 0 ||
      ![4, 10, 16, 30, 60].includes(seconds)
    )
      return;
    const rebin = this.floor !== floor || this.range !== range;
    this.seconds = seconds;
    this.expire();
    if (rebin) {
      this.floor = floor;
      this.range = range;
      this.counts.fill(0);
      this.observations.fill(0);
      for (let i = 0; i < this.count; i++) this.add(this.oldest(i), 1);
      this.revision++;
    }
  }

  accept(frame: SpectrumFrame): boolean {
    if (
      frame.units !== "relative-dB" ||
      !frame.bins.length ||
      !Number.isSafeInteger(frame.sessionGeneration) ||
      frame.sessionGeneration < 0 ||
      frame.sessionGeneration < this.generation ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 0 ||
      !Number.isSafeInteger(frame.sampleIndex) ||
      frame.sampleIndex < 0 ||
      !Number.isFinite(frame.centerFrequencyHz) ||
      !Number.isFinite(frame.sampleRateHz) ||
      frame.sampleRateHz <= 0
    )
      return false;
    const hop = frame.hopSamples ?? frame.bins.length * 4;
    const key = `${frame.sessionGeneration}:${frame.centerFrequencyHz}:${frame.sampleRateHz}:${frame.bins.length}`;
    if (
      key !== this.context &&
      this.continuation === frame.sessionGeneration &&
      this.context.split(":").slice(1).join(":") ===
        key.split(":").slice(1).join(":")
    ) {
      this.timeOffset =
        this.time +
        hop / frame.sampleRateHz -
        frame.sampleIndex / frame.sampleRateHz;
      this.context = key;
      this.sequence = this.lastSample = -1;
      this.continuation = undefined;
    }
    if (key !== this.context) {
      this.clear();
      this.context = key;
      this.generation = frame.sessionGeneration;
      this.sequence = this.lastSample = -1;
      this.latest = undefined;
      this.timeOffset = 0;
      this.continuation = undefined;
    }
    if (
      frame.sequence <= this.sequence ||
      frame.sampleIndex === this.lastSample
    )
      return false;
    if (frame.sampleIndex < this.lastSample) {
      this.clear();
      this.timeOffset = 0;
    }
    if (
      this.lastSample >= 0 &&
      (frame.droppedFramesBefore > 0 ||
        (frame.missingSamplesBefore ?? 0) > 0 ||
        frame.sampleIndex - this.lastSample > hop * 1.5)
    )
      this.gaps++;
    this.time = frame.sampleIndex / frame.sampleRateHz + this.timeOffset;
    this.expire();
    if (this.count === PERSISTENCE_CAPACITY) {
      this.capacityDropAt = this.times[this.next]!;
      this.add(this.next, -1);
      this.count--;
    }
    const offset = this.next * PERSISTENCE_COLUMNS;
    for (let x = 0; x < PERSISTENCE_COLUMNS; x++) {
      const start = Math.floor((x * frame.bins.length) / PERSISTENCE_COLUMNS);
      const end = Math.max(
        start + 1,
        Math.floor(((x + 1) * frame.bins.length) / PERSISTENCE_COLUMNS),
      );
      let peak = -Infinity;
      for (let i = start; i < end; i++) {
        const v = frame.bins[i]!;
        if (Number.isFinite(v) && v > -8192 && v < EMPTY / QUANTIZATION)
          peak = Math.max(peak, v);
      }
      this.levels[offset + x] = Number.isFinite(peak)
        ? Math.round(peak * QUANTIZATION)
        : EMPTY;
    }
    this.times[this.next] = this.time;
    this.add(this.next, 1);
    this.next = (this.next + 1) % PERSISTENCE_CAPACITY;
    this.count++;
    this.sequence = frame.sequence;
    this.lastSample = frame.sampleIndex;
    this.latest = { ...frame, bins: frame.bins.slice() };
    this.revision++;
    return true;
  }

  get limited(): boolean {
    return this.capacityDropAt >= this.time - this.seconds;
  }

  get duration(): number {
    return this.count ? Math.max(0, this.time - this.times[this.oldest()]!) : 0;
  }
  /** Level bin, not a point estimate, and fraction of finite observed spectra. */
  inspectColumn(column: number, levelFraction: number) {
    return this.inspect(
      (column + 0.5) / PERSISTENCE_COLUMNS,
      this.floor +
        Math.min(1 - Number.EPSILON, Math.max(0, levelFraction)) * this.range,
    );
  }
  inspect(
    fraction: number,
    level: number,
  ):
    | { fraction: number; low: number; high: number; observations: number }
    | undefined {
    if (
      !Number.isFinite(fraction) ||
      fraction < 0 ||
      fraction > 1 ||
      !Number.isFinite(level)
    )
      return;
    const x = Math.min(
      PERSISTENCE_COLUMNS - 1,
      Math.floor(fraction * PERSISTENCE_COLUMNS),
    );
    const y = this.bin(level);
    const n = this.observations[x]!;
    if (y < 0 || !n) return;
    const low = this.floor + (y * this.range) / PERSISTENCE_LEVELS;
    return {
      fraction: this.counts[y * PERSISTENCE_COLUMNS + x]! / n,
      low,
      high: low + this.range / PERSISTENCE_LEVELS,
      observations: n,
    };
  }

  private oldest(offset = 0): number {
    return (
      (this.next + PERSISTENCE_CAPACITY - this.count + offset) %
      PERSISTENCE_CAPACITY
    );
  }
  private bin(level: number): number {
    if (level < this.floor || level >= this.floor + this.range) return -1;
    return Math.floor(((level - this.floor) / this.range) * PERSISTENCE_LEVELS);
  }
  private add(row: number, direction: 1 | -1): void {
    const offset = row * PERSISTENCE_COLUMNS;
    for (let x = 0; x < PERSISTENCE_COLUMNS; x++) {
      const q = this.levels[offset + x]!;
      if (q === EMPTY) continue;
      this.observations[x] = this.observations[x]! + direction;
      const y = this.bin(q / QUANTIZATION);
      if (y >= 0)
        this.counts[y * PERSISTENCE_COLUMNS + x] =
          this.counts[y * PERSISTENCE_COLUMNS + x]! + direction;
    }
  }
  private expire(): void {
    while (
      this.count &&
      this.time - this.times[this.oldest()]! > this.seconds
    ) {
      this.add(this.oldest(), -1);
      this.count--;
      this.revision++;
    }
  }
}
