export interface InputClippingSnapshot {
  clippedFraction: number;
  sampledComponents: number;
}

/** Bounded sampling of raw ADC endpoints, before audio/DSP can mutate I/Q.
 * This is a saturation warning, not a calibrated RF overload detector. */
export class InputClippingMonitor {
  private windowStart = 0;
  private sampled = 0;
  private clipped = 0;
  private warningUntil = 0;
  private warning?: InputClippingSnapshot;

  reset(): void {
    this.windowStart = 0;
    this.sampled = 0;
    this.clipped = 0;
    this.warningUntil = 0;
    this.warning = undefined;
  }

  observePlanar(
    I: Float32Array,
    Q: Float32Array,
    source: string,
    now = performance.now(),
  ): void {
    if (source !== "rtl-sdr" && source !== "hackrf") return;
    this.beginWindow(now);
    const length = Math.min(I.length, Q.length);
    const stride = Math.max(1, Math.ceil(length / 1024));
    // RTL uses (byte − 127.5)/128; HackRF uses signed byte/128.
    const low = source === "rtl-sdr" ? -127.5 / 128 : -1;
    const high = source === "rtl-sdr" ? 127.5 / 128 : 127 / 128;
    for (let n = 0; n < length; n += stride) {
      this.sampled += 2;
      if (I[n]! <= low || I[n]! >= high) this.clipped++;
      if (Q[n]! <= low || Q[n]! >= high) this.clipped++;
    }
    this.updateWarning(now);
  }

  observeCi8(bytes: Uint8Array, now = performance.now()): void {
    this.beginWindow(now);
    const length = bytes.byteLength / 2;
    const stride = Math.max(1, Math.ceil(length / 1024));
    for (let n = 0; n < length; n += stride) {
      this.sampled += 2;
      if (bytes[2 * n] === 128 || bytes[2 * n] === 127) this.clipped++;
      if (bytes[2 * n + 1] === 128 || bytes[2 * n + 1] === 127) this.clipped++;
    }
    this.updateWarning(now);
  }

  getSnapshot(now = performance.now()): InputClippingSnapshot | undefined {
    return now < this.warningUntil ? this.warning : undefined;
  }

  private beginWindow(now: number): void {
    if (now - this.windowStart >= 250) {
      this.windowStart = now;
      this.sampled = 0;
      this.clipped = 0;
    }
  }

  private updateWarning(now: number): void {
    const fraction = this.clipped / this.sampled;
    if (this.sampled >= 128 && fraction >= 0.01) {
      this.warning = {
        clippedFraction: fraction,
        sampledComponents: this.sampled,
      };
      this.warningUntil = now + 1500;
    }
  }
}
