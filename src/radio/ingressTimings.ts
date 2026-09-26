export interface TimingDistribution { count: number; meanMs: number; p99Ms: number; maxMs: number; lifetimeMaxMs: number }
export interface IngressDiagnostics { stages: Record<string, TimingDistribution>; debtMs: number; budgetMs: number }
/** 256 recent measurements per named stage, no per-block allocation. Sorting is
 * restricted to the existing UI diagnostic poll. Maxima survive the recent window. */
export class IngressTimings {
  private readonly rings: Record<string, { values: Float64Array; cursor: number; count: number; max: number }>;
  constructor(names: string[]) { this.rings = Object.fromEntries(names.map(name => [name, { values: new Float64Array(256), cursor: 0, count: 0, max: 0 }])); }
  record(name: string, elapsedMs: number): void {
    const ring = this.rings[name];
    if (!ring || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    ring.values[ring.cursor] = elapsedMs; ring.cursor = (ring.cursor + 1) % 256;
    ring.count = Math.min(256, ring.count + 1); ring.max = Math.max(ring.max, elapsedMs);
  }
  reset(): void { for (const ring of Object.values(this.rings)) { ring.cursor = 0; ring.count = 0; ring.max = 0; } }
  snapshot(): Record<string, TimingDistribution> {
    return Object.fromEntries(Object.entries(this.rings).filter(([, r]) => r.count).map(([name, r]) => {
      const sorted = r.values.slice(0, r.count).sort();
      return [name, { count: r.count, meanMs: sorted.reduce((a, b) => a + b, 0) / r.count,
        p99Ms: sorted[Math.ceil(r.count * .99) - 1]!, maxMs: sorted[r.count - 1]!, lifetimeMaxMs: r.max }];
    }));
  }
}
