import { imageModemSettings, type ImageModemSettings } from "./settings";

export interface ImageDecoderCallbacks {
  start(mode: "WEFAX" | "Martin M1" | "Martin M2", width: number, height: number, channels: 1 | 3): void;
  row(row: number, pixels: Uint8Array): void;
  end(complete: boolean, reason: string): void;
  error(): void;
}
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/** Original streaming frequency-to-raster implementation. The upstream reducer
 * supplies the analytic USB signal, so phase difference is the audio tone Hz.
 * Row events, not full images, cross the worker boundary. */
export class ImageModem {
  private accumulator = 0;
  private frequencySum = 0;
  private sampleCount = 0;
  private validCount = 0;
  private decoder: WefaxDecoder | MartinDecoder;
  private silent = 0;
  level = 0;
  confidence = 0;
  constructor(mode: "WEFAX" | "SSTV", private rate: number, settings: ImageModemSettings | undefined, callbacks: ImageDecoderCallbacks) {
    const accepted = imageModemSettings(settings);
    this.decoder = mode === "WEFAX" ? new WefaxDecoder(accepted, callbacks) : new MartinDecoder(accepted, callbacks);
  }
  get stage(): string { return this.decoder.stage; }
  push(frequencyHz: number, envelope: number): void {
    this.level += 0.002 * (envelope - this.level);
    this.sampleCount++;
    if (envelope > 0.001 && Number.isFinite(frequencyHz)) { this.frequencySum += frequencyHz; this.validCount++; }
    this.accumulator += 8000;
    if (this.accumulator < this.rate) return;
    this.accumulator -= this.rate;
    const frequency = this.validCount > this.sampleCount / 2 ? this.frequencySum / this.validCount : NaN;
    this.frequencySum = this.sampleCount = this.validCount = 0;
    if (!Number.isFinite(frequency)) {
      if (++this.silent === 1600) this.decoder.abort("Signal lost · partial image");
    } else this.silent = 0;
    this.decoder.push(frequency);
    this.confidence = this.decoder.stage === "Image" ? 1 : 0;
  }
  flush(reason = "End of input · partial image"): void { this.decoder.abort(reason); }
}

class WefaxDecoder {
  stage = "Waiting for APT start";
  private index = 0;
  private width: number;
  private lineSamples: number;
  private active = false;
  private rows = 0;
  private lineStart = 0;
  private sums: Float64Array;
  private counts: Uint16Array;
  private aptCount = 0;
  private aptSum = 0;
  private aptSquare = 0;
  private aptEdges = 0;
  private high = false;
  private startWindows = 0;
  private stopWindows = 0;
  private whiteSince = -1;
  private previousPulse = -1;
  private phasePulses = 0;
  private scheduledStart = Infinity;
  constructor(private settings: ImageModemSettings, private callbacks: ImageDecoderCallbacks) {
    this.width = Math.floor(Math.PI * settings.ioc);
    this.lineSamples = 8000 * 60 / settings.lpm;
    this.sums = new Float64Array(this.width); this.counts = new Uint16Array(this.width);
    if (!settings.automatic) this.stage = "Manual · waiting for signal";
  }
  push(frequency: number): void {
    const now = this.index++;
    if (!Number.isFinite(frequency)) return;
    const gray = byte((frequency - (1900 - this.settings.shiftHz / 2)) * 255 / this.settings.shiftHz);
    if (!this.settings.automatic && !this.active && this.stage === "Manual · waiting for signal") this.start(now);
    if (gray > 210 && !this.high) { this.high = true; this.aptEdges++; }
    else if (gray < 45) this.high = false;
    this.aptCount++; this.aptSum += frequency; this.aptSquare += frequency * frequency;
    if (this.aptCount === 4000) {
      const mean = this.aptSum / this.aptCount;
      const deviation = Math.sqrt(Math.max(0, this.aptSquare / this.aptCount - mean * mean));
      const startHz = this.settings.ioc === 576 ? 300 : 675;
      const near = (target: number) => (deviation < 40 && Math.abs(mean - target) < 15) || Math.abs(this.aptEdges * 2 - target) < 12;
      this.startWindows = near(startHz) ? this.startWindows + 1 : 0;
      this.stopWindows = near(450) ? this.stopWindows + 1 : 0;
      this.aptCount = this.aptSum = this.aptSquare = this.aptEdges = 0;
      if (this.settings.automatic && this.startWindows >= 2 && this.stage !== "Phasing") {
        this.abort("New APT start · partial image"); this.stage = "Phasing";
        this.phasePulses = 0; this.previousPulse = this.whiteSince = -1; this.scheduledStart = Infinity;
      }
      if (this.stopWindows >= 2 && this.active) { this.finish(true, "APT stop detected · no image checksum"); return; }
    }
    if (this.stage === "Phasing") {
      if (gray > 210) {
        if (this.whiteSince < 0) this.whiteSince = now;
        // The full white end-of-phasing line follows the 5%-white pulse train.
        if (this.phasePulses >= 3 && now - this.whiteSince > this.lineSamples * 0.8) this.scheduledStart = Math.min(this.scheduledStart, this.whiteSince + this.lineSamples * 1.025);
      } else if (gray < 45 && this.whiteSince >= 0) {
        const duration = now - this.whiteSince;
        if (duration > this.lineSamples * 0.025 && duration < this.lineSamples * 0.09) {
          const center = this.whiteSince + duration / 2;
          if (this.previousPulse >= 0 && Math.abs(center - this.previousPulse - this.lineSamples) < this.lineSamples * 0.04) {
            this.phasePulses++;
            this.lineSamples = this.lineSamples * 0.8 + (center - this.previousPulse) * 0.2;
          } else this.phasePulses = 1;
          this.previousPulse = center;
        }
        this.whiteSince = -1;
      }
      if (now >= this.scheduledStart) this.start(this.scheduledStart);
    }
    if (!this.active) return;
    while (now >= this.lineStart + this.lineSamples) {
      this.emitRow(); this.lineStart += this.lineSamples;
      if (!this.active) return;
    }
    const x = Math.floor((now - this.lineStart) * this.width / this.lineSamples);
    if (x >= 0 && x < this.width) { this.sums[x]! += gray; this.counts[x]!++; }
  }
  private start(index: number): void {
    this.active = true; this.rows = 0; this.lineStart = index; this.stage = "Image";
    this.sums.fill(0); this.counts.fill(0);
    this.callbacks.start("WEFAX", this.width, 2048, 1);
  }
  private emitRow(): void {
    const pixels = new Uint8Array(this.width);
    for (let x = 0; x < this.width; x++) pixels[x] = this.counts[x] ? byte(this.sums[x]! / this.counts[x]!) : 127;
    this.callbacks.row(this.rows++, pixels); this.sums.fill(0); this.counts.fill(0);
    if (this.rows >= 2048) this.finish(false, "2,048-row retention limit · partial image");
  }
  private finish(complete: boolean, reason: string): void {
    this.active = false; this.stage = reason; this.callbacks.end(complete, reason);
  }
  abort(reason: string): void { if (this.active) this.finish(false, reason); }
}

interface ToneRun { tone: number; start: number; duration: number; }
class MartinDecoder {
  stage = "Waiting for VIS";
  private index = 0;
  private tone = 0;
  private candidate = 0;
  private candidateSince = 0;
  private toneSince = 0;
  private history: ToneRun[] = [];
  private vis?: { start: number; next: number; bits: number[] };
  private active = false;
  private width = 320;
  private scan = 146.432 * 8;
  private lineSamples = 446.446 * 8;
  private lineStart = 0;
  private lastSync = 0;
  private rows = 0;
  private sums = new Float64Array(960);
  private counts = new Uint16Array(960);
  constructor(private settings: ImageModemSettings, private callbacks: ImageDecoderCallbacks) {
    if (settings.sstvMode !== "auto") this.stage = `Manual ${settings.sstvMode} · waiting for line sync`;
  }
  push(frequency: number): void {
    const now = this.index++;
    if (!Number.isFinite(frequency)) return;
    const tone = [1100, 1200, 1300, 1900].find(hz => Math.abs(frequency - hz) < 40) ?? 0;
    if (tone !== this.candidate) { this.candidate = tone; this.candidateSince = now; }
    if (tone !== this.tone && now - this.candidateSince >= 7) {
      const start = this.candidateSince;
      if (start - this.toneSince >= 32) this.history = [...this.history.slice(-7), { tone: this.tone, start: this.toneSince, duration: start - this.toneSince }];
      this.tone = tone; this.toneSince = start;
      if (tone === 1200) this.sync(start);
    }
    if (this.vis && now >= this.vis.next) {
      const data = this.vis;
      if (data.bits.length < 8) {
        if (Math.abs(frequency - 1100) < 55) data.bits.push(1);
        else if (Math.abs(frequency - 1300) < 55) data.bits.push(0);
        else { this.vis = undefined; this.callbacks.error(); this.stage = "Invalid VIS · waiting"; }
        data.next += 240;
      } else {
        this.vis = undefined;
        const code = data.bits.slice(0, 7).reduce((value, bit, i) => value | bit << i, 0);
        if (Math.abs(frequency - 1200) >= 55 || data.bits.reduce((a, b) => a + b, 0) % 2) { this.callbacks.error(); this.stage = "VIS parity/stop failed"; }
        else if (code === 44 || code === 40) this.start(code === 44 ? "Martin M1" : "Martin M2", data.start + 2400);
        else this.stage = `Unsupported VIS ${code} · Martin M1/M2 only`;
      }
    }
    if (!this.active || now < this.lineStart) return;
    if (now - this.lastSync > this.lineSamples * 2.5) { this.abort("Line sync lost · partial image"); return; }
    if (now >= this.lineStart + this.lineSamples) { this.emitRow(); this.lineStart += this.lineSamples; }
    if (!this.active) return;
    const t = now - this.lineStart - (4.862 + 0.572) * 8;
    const channel = Math.floor(t / (this.scan + 0.572 * 8));
    const phase = t - channel * (this.scan + 0.572 * 8);
    if (channel < 0 || channel > 2 || phase < 0 || phase >= this.scan) return;
    const x = Math.min(this.width - 1, Math.floor(phase * this.width / this.scan));
    const component = [1, 2, 0][channel]!;
    const at = x * 3 + component;
    this.sums[at]! += byte((frequency - 1500) * 255 / 800); this.counts[at]!++;
  }
  private sync(start: number): void {
    const runs = this.history;
    const a = runs.at(-3), b = runs.at(-2), c = runs.at(-1);
    if (a?.tone === 1900 && a.duration > 2000 && b?.tone === 1200 && b.duration >= 40 && b.duration <= 160 && c?.tone === 1900 && c.duration > 2000) {
      if (this.active) this.abort("New VIS header · partial image");
      this.vis = { start, next: start + 360, bits: [] }; return;
    }
    if (this.active) {
      if (Math.abs(start - this.lineStart - this.lineSamples) < 100) { this.emitRow(); this.lineStart = start; }
      else if (Math.abs(start - this.lineStart) < 100) this.lineStart = start;
      this.lastSync = start;
    } else if (this.settings.sstvMode !== "auto" && !this.stage.startsWith("256")) this.start(this.settings.sstvMode, start);
  }
  private start(mode: "Martin M1" | "Martin M2", start: number): void {
    if (this.active) this.abort("New VIS header · partial image");
    this.width = mode === "Martin M1" ? 320 : 160;
    this.scan = (mode === "Martin M1" ? 146.432 : 73.216) * 8;
    this.lineSamples = (4.862 + 4 * 0.572) * 8 + 3 * this.scan;
    this.active = true; this.rows = 0; this.lineStart = this.lastSync = start; this.stage = "Image";
    this.sums.fill(0); this.counts.fill(0); this.callbacks.start(mode, this.width, 256, 3);
  }
  private emitRow(): void {
    const pixels = new Uint8Array(this.width * 3);
    for (let x = 0; x < pixels.length; x++) pixels[x] = this.counts[x] ? byte(this.sums[x]! / this.counts[x]!) : 127;
    this.callbacks.row(this.rows++, pixels); this.sums.fill(0); this.counts.fill(0);
    if (this.rows === 256) { this.active = false; this.stage = "256 scan lines · no image checksum"; this.callbacks.end(true, this.stage); }
  }
  abort(reason: string): void { if (this.active) { this.active = false; this.stage = reason; this.callbacks.end(false, reason); } }
}
