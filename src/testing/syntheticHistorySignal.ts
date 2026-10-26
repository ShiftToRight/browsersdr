/** Deterministic, band-limited complex noise bursts for the explicit history demo.
 * Adds generated RF before the existing analysis path; never fabricates FFT rows.
 */
export class SyntheticHistorySignal {
  private random = 4721;
  private i = 0;
  private q = 0;
  private sample = 0;
  private noise(): number {
    this.random ^= this.random << 13;
    this.random ^= this.random >>> 17;
    this.random ^= this.random << 5;
    return (this.random >>> 0) / 0x80000000 - 1;
  }
  mix(I: Float32Array, Q: Float32Array, rate: number): void {
    for (let n = 0; n < I.length; n++) {
      this.i += .24 * (this.noise() - this.i);
      this.q += .24 * (this.noise() - this.q);
      const phase = (this.sample++ / rate) % 2.4;
      // A short ramp avoids an artificial broadband switching impulse.
      const envelope = Math.max(0, Math.min(1, phase / .012, (.65 - phase) / .012));
      I[n] = I[n]! + this.i * envelope;
      Q[n] = Q[n]! + this.q * envelope;
    }
  }
}
