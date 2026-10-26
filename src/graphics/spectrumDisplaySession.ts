import type { SourceSessionMetadata } from "../radio/types";
/** Generation changes alone never prove RF continuity. Only a channel-only
 * change may preserve history; source/rate/center/gain/mode changes cannot. */
export function channelOnlyDisplayChange(a?: SourceSessionMetadata, b?: SourceSessionMetadata): boolean {
  if (!a || !b || b.sessionGeneration < a.sessionGeneration) return false;
  const stable = (session: SourceSessionMetadata) => {
    const {sessionGeneration: _generation, selectedChannelFrequencyHz: _channel, ...rf} = session;
    return JSON.stringify(rf);
  };
  return stable(a) === stable(b);
}

/** Finite, interruptible marker motion. Reduced motion uses the target directly. */
export class SurfaceMarkerMotion {
  private from: number[] = [];
  private target: number[] = [];
  private start = 0;
  private duration = 0;
  private lastFrame = 0;
  set(target: number[], now: number, animate: boolean): void {
    if (target.every((value,index) => value === this.target[index]) && target.length === this.target.length) return;
    this.from = this.sample(now);
    this.target = target;
    this.start = now; this.lastFrame = now;
    this.duration = animate && this.from.length === target.length ? 160 : 0;
  }
  /** Cap visual progress after a slow GPU frame; motion must not collapse to a
   * single jump just because presenting one marker pass exceeded 160 ms. */
  advance(now: number): number[] {
    if (this.duration) this.start += Math.max(0,now-this.lastFrame-40);
    this.lastFrame = now;
    return this.sample(now);
  }
  moving(now: number): boolean { return now < this.start + this.duration; }
  sample(now: number): number[] {
    const t = this.duration ? Math.max(0,Math.min(1,(now-this.start)/this.duration)) : 1;
    if (t >= 1) return this.target.slice();
    const smooth=t*t*(3-2*t);
    return this.target.map((value,index) => (this.from[index] ?? value) + (value-(this.from[index] ?? value))*smooth);
  }
}
