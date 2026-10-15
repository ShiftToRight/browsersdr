import { audioCaptureTap } from "./audioCaptureTap";

export const AUDIO_REWIND_SECONDS = 60;
export const AUDIO_RECORD_SECONDS = 120;
const MAX_RATE = 96_000;

export interface AudioClip {
  samples: Int16Array<ArrayBuffer>[];
  frames: number;
  rate: number;
  provenance: string;
  startedAt: string;
  reason: string;
}

/** In-memory PCM16 stereo only. Neither RF samples nor browser storage enter here. */
export class AudioArchive {
  rewindEnabled = false;
  recording = false;
  reviewing = false;
  revision = 0;
  message = "Audio recordings stay in this window until downloaded.";
  private owner?: object;
  private monitor?: (muted: boolean) => void;
  private provenance = "";
  private rate = 0;
  private ring?: Int16Array<ArrayBuffer>;
  private ringFrames = 0;
  private ringPosition = 0;
  private clip?: AudioClip;
  private completed = false;

  get active(): boolean { return this.rewindEnabled || this.recording || this.reviewing; }

  get rewindSeconds(): number { return this.rate ? this.ringFrames / this.rate : 0; }
  get recordedSeconds(): number { return this.clip?.rate ? this.clip.frames / this.clip.rate : 0; }
  get hasRecording(): boolean { return Boolean(this.clip?.frames); }
  get memoryBytes(): number {
    return (this.ring?.byteLength ?? 0) + (this.clip?.samples.reduce((sum, chunk) => sum + chunk.byteLength, 0) ?? 0);
  }
  setRewind(enabled: boolean): void {
    this.rewindEnabled = enabled;
    if (!enabled) { this.ring = undefined; this.ringFrames = this.ringPosition = 0; }
  }
  startRecording(): void {
    if (this.hasRecording) throw new Error("Download or discard the previous audio recording first.");
    this.clip = { samples: [], frames: 0, rate: 0, provenance: "", startedAt: new Date().toISOString(), reason: "Recording" };
    this.recording = true;
    this.message = "Waiting for decoded audio…";
  }
  stopRecording(reason = "Stopped by user"): void {
    if (!this.recording) return;
    this.recording = false;
    if (this.clip) this.clip.reason = reason;
    this.message = this.hasRecording ? `${reason}. WAV ready to download.` : `${reason}. No decoded audio received.`;
  }
  discard(): void {
    this.stopRecording(); this.clip = undefined;
    this.message = "Audio recording discarded.";
  }
  setReviewing(reviewing: boolean): void {
    this.reviewing = reviewing;
    this.monitor?.(reviewing);
  }
  /** Called at proven source/tuning/gap boundaries; an export remains available. */
  boundary(owner: object): void {
    if (this.owner !== owner) return;
    if (this.completed) {
      this.setReviewing(false); this.monitor = undefined; this.owner = undefined;
      return; // Closing a completed replay must leave its rewind available.
    }
    this.clearSource();
  }
  clearSource(): void {
    this.stopRecording("Audio source changed or stopped");
    this.setReviewing(false);
    this.monitor = undefined; this.owner = undefined;
    this.ring = undefined; this.ringFrames = this.ringPosition = 0;
    this.rate = 0; this.provenance = ""; this.completed = false; this.revision++;
  }
  /** End-of-file retains rewind while finishing the explicit recording. */
  finish(owner: object): void {
    if (this.owner === owner) { this.stopRecording("Audio reached end of file"); this.completed = true; }
  }
  push(owner: object, left: Float32Array, right: Float32Array, rate: number,
    provenance: string, monitor: (muted: boolean) => void): void {
    if (!this.active) return;
    if (!left.length || left.length !== right.length) return;
    if (!Number.isFinite(rate) || rate < 8_000 || rate > MAX_RATE) {
      this.stopRecording("Unsupported audio sample rate"); return;
    }
    // Remote servers may report fractional clock estimates; WAV uses integer Hz.
    rate = Math.round(rate);
    if (this.completed) {
      // A newly armed, still empty recording belongs to the next replay.
      const armed = this.recording && !this.hasRecording;
      this.clearSource();
      if (armed) { this.recording = true; this.message = "Waiting for decoded audio…"; }
    }
    if (this.owner && (owner !== this.owner || rate !== this.rate || provenance !== this.provenance)) this.boundary(this.owner);
    this.owner = owner; this.monitor = monitor; this.rate = rate; this.provenance = provenance;
    monitor(this.reviewing);
    const pcm = (value: number) => Number.isFinite(value) ? Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)) : 0;
    if (this.rewindEnabled) {
      const capacity = rate * AUDIO_REWIND_SECONDS;
      this.ring ??= new Int16Array(capacity * 2);
      for (let i = Math.max(0, left.length - capacity); i < left.length; i++) {
        this.ring[this.ringPosition * 2] = pcm(left[i]!);
        this.ring[this.ringPosition * 2 + 1] = pcm(right[i]!);
        this.ringPosition = (this.ringPosition + 1) % capacity;
        this.ringFrames = Math.min(capacity, this.ringFrames + 1);
      }
    }
    if (this.recording && this.clip) {
      const clip = this.clip;
      if (!clip.rate) { clip.rate = rate; clip.provenance = provenance; }
      const length = Math.min(left.length, rate * AUDIO_RECORD_SECONDS - clip.frames);
      const samples = new Int16Array(length * 2);
      for (let i = 0; i < length; i++) { samples[i * 2] = pcm(left[i]!); samples[i * 2 + 1] = pcm(right[i]!); }
      // Coalesce tiny demodulator blocks to bound JS object overhead as well as bytes.
      const tail = clip.samples.at(-1);
      const used = clip.frames % rate;
      let offset = 0;
      if (tail && used) {
        const count = Math.min(length, rate - used);
        tail.set(samples.subarray(0, count * 2), used * 2); offset = count;
      }
      while (offset < length) {
        const chunk = new Int16Array(rate * 2);
        const count = Math.min(length - offset, rate);
        chunk.set(samples.subarray(offset * 2, (offset + count) * 2)); clip.samples.push(chunk); offset += count;
      }
      clip.frames += length;
      this.message = "Recording decoded audio · two-minute limit.";
      if (clip.frames === rate * AUDIO_RECORD_SECONDS) this.stopRecording("Two-minute audio limit reached");
    }
  }
  recordingWav(): Blob {
    if (this.recording || !this.clip?.frames) throw new Error("Stop a nonempty audio recording before downloading.");
    return encodeAudioWav(this.clip);
  }
  rewindWav(seconds: number): Blob {
    if (!Number.isFinite(seconds) || seconds <= 0 || !this.ring || !this.ringFrames) throw new Error("Enable rewind and receive some decoded audio first.");
    const frames = Math.min(this.ringFrames, Math.floor(seconds * this.rate));
    const samples = new Int16Array(frames * 2);
    const capacity = this.ring.length / 2;
    const start = (this.ringPosition - frames + capacity) % capacity;
    const first = Math.min(frames, capacity - start);
    samples.set(this.ring.subarray(start * 2, (start + first) * 2));
    if (first < frames) samples.set(this.ring.subarray(0, (frames - first) * 2), first * 2);
    return encodeAudioWav({ samples: [samples], frames, rate: this.rate, provenance: this.provenance,
      startedAt: new Date().toISOString(), reason: "Rolling audio snapshot; sample time, gaps reset history" });
  }
}

/** Standard RIFF PCM16 stereo plus a human-readable INFO comment for provenance. */
export function encodeAudioWav(clip: AudioClip): Blob {
  const info = new TextEncoder().encode(`${clip.provenance}\n${clip.startedAt}\n${clip.reason}\0`);
  const padded = info.length + info.length % 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + clip.frames * 4 + 20 + padded, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, clip.rate, true); view.setUint32(28, clip.rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, clip.frames * 4, true);
  const parts: BlobPart[] = [header];
  let remaining = clip.frames * 2;
  for (const chunk of clip.samples) {
    const count = Math.min(remaining, chunk.length);
    const bytes = new ArrayBuffer(count * 2); const output = new DataView(bytes);
    for (let i = 0; i < count; i++) output.setInt16(i * 2, chunk[i]!, true);
    parts.push(bytes); remaining -= count;
  }
  const footer = new ArrayBuffer(20 + padded); const end = new DataView(footer);
  new Uint8Array(footer).set(new TextEncoder().encode("LIST")); end.setUint32(4, 12 + padded, true);
  new Uint8Array(footer, 8, 8).set(new TextEncoder().encode("INFOICMT")); end.setUint32(16, info.length, true);
  new Uint8Array(footer, 20).set(info); parts.push(footer);
  return new Blob(parts, { type: "audio/wav" });
}

export const audioArchive = new AudioArchive();
audioCaptureTap.archive = audioArchive;
