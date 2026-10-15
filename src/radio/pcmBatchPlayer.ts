import type { Player } from "@jtarrio/signals/demod/player.js";
import { audioCaptureTap } from "./audioCaptureTap";

export const PCM_BATCH_FRAMES = 1024;
/** Fixed stereo PCM staging for high-rate input's tiny demodulator outputs.
 * The underlying player must copy synchronously (Signals AudioPlayer does).
 * RF data, decoders and native recording are unaffected. */
export class PcmBatchPlayer implements Player {
  private readonly left = new Float32Array(PCM_BATCH_FRAMES);
  private readonly right = new Float32Array(PCM_BATCH_FRAMES);
  private count = 0;
  private enabled = false;
  private volume?: number;
  readonly sampleRate: number;
  constructor(private readonly output: Player, private readonly provenance = () => "Decoded receiver audio. Processed audio, not original I/Q.") {
    // Signals starts with 48 kHz PCM and always queues 48 kHz buffers, but its
    // getter reveals the device rate after first play. Keep the established PCM
    // contract for demodulation and capture, independent of device resampling.
    this.sampleRate = output.sampleRate;
  }
  setVolume(value: number): void { this.volume = value; this.output.setVolume(audioCaptureTap.archive?.reviewing ? 0 : value); }
  getVolume(): number { return this.output.getVolume(); }
  configure(enabled: boolean): void { this.enabled = enabled; this.reset(); }
  reset(): void { this.count = 0; audioCaptureTap.archive?.boundary(this); }
  finishAudio(): void { audioCaptureTap.archive?.finish(this); }
  private capture(left: Float32Array, right: Float32Array): void {
    const audioArchive = audioCaptureTap.archive;
    if (!audioArchive?.active) return;
    const volume = this.volume ?? this.output.getVolume();
    audioArchive.push(this, left, right, this.sampleRate, this.provenance(), muted => this.output.setVolume(muted ? 0 : (this.volume ?? volume)));
  }
  flush(): void {
    if (this.count) {
      const left = this.left.subarray(0, this.count), right = this.right.subarray(0, this.count);
      this.capture(left, right); this.output.play(left, right);
    }
    this.count = 0;
  }
  play(left: Float32Array, right: Float32Array): void {
    if (left.length !== right.length) throw new Error("Mismatched stereo PCM lengths.");
    if (!this.enabled) { this.capture(left, right); this.output.play(left, right); return; }
    for (let offset = 0; offset < left.length;) {
      const length = Math.min(PCM_BATCH_FRAMES - this.count, left.length - offset);
      this.left.set(left.subarray(offset, offset + length), this.count);
      this.right.set(right.subarray(offset, offset + length), this.count);
      offset += length; this.count += length;
      if (this.count === PCM_BATCH_FRAMES) this.flush();
    }
  }
}
