import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";

export const AIS_CENTER_FREQUENCY_HZ = 162_000_000;
export const AIS_BANDWIDTH_HZ = 100_000;
export const AIS_BAUD = 9_600;

export interface AisTarget {
  mmsi: number;
  name: string | null;
  callSign: string | null;
  shipType: number | null;
  latitude: number | null;
  longitude: number | null;
  speedKnots: number | null;
  courseDegrees: number | null;
  headingDegrees: number | null;
  navigationStatus: number | null;
  channel: "AIS 1" | "AIS 2";
  messages: number;
  lastSeenMs: number;
}

export interface AisSnapshot {
  frames: number;
  validFrames: number;
  rejectedFrames: number;
  channel1Frames: number;
  channel2Frames: number;
  targets: AisTarget[];
  message: string;
}

interface MutableTarget extends AisTarget {}

const AIS_CHARS = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?";

class HdlcDecoder {
  private shift = 0;
  private collecting = false;
  private raw: number[] = [];
  constructor(private readonly onFrame: (bytes: Uint8Array) => void) {}
  reset(): void { this.shift = 0; this.collecting = false; this.raw = []; }
  push(bit: number): void {
    this.shift = ((this.shift >> 1) | (bit << 7)) & 0xff;
    if (this.collecting) this.raw.push(bit);
    if (this.shift === 0x7e) {
      if (this.collecting && this.raw.length >= 24) this.finish(this.raw.slice(0, -8));
      this.collecting = true; this.raw = [];
      return;
    }
    if (this.raw.length > 8_192) { this.collecting = false; this.raw = []; }
  }
  private finish(raw: number[]): void {
    const bits: number[] = [];
    let ones = 0;
    for (let index = 0; index < raw.length; index += 1) {
      const bit = raw[index]!;
      if (bit) { ones += 1; bits.push(1); }
      else {
        if (ones === 5) { ones = 0; continue; }
        if (ones > 5) return;
        ones = 0; bits.push(0);
      }
    }
    if (bits.length < 24 || bits.length % 8 !== 0) return;
    const bytes = new Uint8Array(bits.length / 8);
    for (let index = 0; index < bits.length; index += 1) bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (bits[index]! << (index & 7));
    this.onFrame(bytes);
  }
}

export class AisChannelDemodulator {
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private previousI = 0;
  private previousQ = 0;
  private accumulator = 0;
  private clock = 0;
  private previousLevel = 1;
  private instantLevel: number | undefined;
  private readonly filterI = new Float64Array(3);
  private readonly filterQ = new Float64Array(3);
  private readonly hdlc: HdlcDecoder;
  constructor(private readonly channelOffsetHz: number, private readonly onFrame: (bytes: Uint8Array) => void, private readonly onBit?: (bit: number) => void) {
    this.hdlc = new HdlcDecoder(onFrame);
  }
  reset(): void {
    this.oscillatorI = 1; this.oscillatorQ = 0; this.previousI = 0; this.previousQ = 0;
    this.accumulator = 0; this.clock = 0; this.previousLevel = 1; this.instantLevel = undefined; this.hdlc.reset();
    this.filterI.fill(0); this.filterQ.fill(0);
  }
  receive(block: SampleBlock, sampleRateHz: number, centerOffsetHz: number): void {
    const angle = -2 * Math.PI * (centerOffsetHz + this.channelOffsetHz) / sampleRateHz;
    const rotationI = Math.cos(angle), rotationQ = Math.sin(angle);
    const filterAlpha = 1 - Math.exp(-2 * Math.PI * 20_000 / sampleRateHz);
    const samplesPerSymbol = sampleRateHz / AIS_BAUD;
    for (let index = 0; index < block.I.length; index += 1) {
      const rawI = block.I[index] ?? 0, rawQ = block.Q[index] ?? 0;
      let i = rawI * this.oscillatorI - rawQ * this.oscillatorQ;
      let q = rawI * this.oscillatorQ + rawQ * this.oscillatorI;
      const nextI = this.oscillatorI * rotationI - this.oscillatorQ * rotationQ;
      this.oscillatorQ = this.oscillatorI * rotationQ + this.oscillatorQ * rotationI;
      this.oscillatorI = nextI;
      if ((index & 1023) === 1023) {
        const norm = Math.hypot(this.oscillatorI, this.oscillatorQ) || 1;
        this.oscillatorI /= norm; this.oscillatorQ /= norm;
      }
      // Three inexpensive low-pass sections isolate the selected 25 kHz AIS
      // channel before FM discrimination; the other AIS channel is 50 kHz away.
      for (let stage = 0; stage < this.filterI.length; stage += 1) {
        const filteredI = this.filterI[stage]! + filterAlpha * (i - this.filterI[stage]!);
        const filteredQ = this.filterQ[stage]! + filterAlpha * (q - this.filterQ[stage]!);
        this.filterI[stage] = filteredI; this.filterQ[stage] = filteredQ;
        i = filteredI; q = filteredQ;
      }
      const discriminator = this.previousI * q - this.previousQ * i;
      this.previousI = i; this.previousQ = q;
      const instantLevel = discriminator >= 0 ? 1 : 0;
      if (this.instantLevel !== undefined && instantLevel !== this.instantLevel) {
        // Training transitions and later NRZI zeroes occur on symbol edges.
        // Finish a substantially accumulated symbol, then re-anchor the clock.
        if (this.clock >= samplesPerSymbol * 0.5) this.emitSymbol();
        this.clock = 0; this.accumulator = 0;
      }
      this.instantLevel = instantLevel;
      this.accumulator += discriminator; this.clock += 1;
      if (this.clock >= samplesPerSymbol) {
        this.emitSymbol();
        this.clock -= samplesPerSymbol; this.accumulator = 0;
      }
    }
  }
  private emitSymbol(): void {
    const level = this.accumulator >= 0 ? 1 : 0;
    const bit = level === this.previousLevel ? 1 : 0;
    this.onBit?.(bit); this.hdlc.push(bit);
    this.previousLevel = level;
  }
}

/** Dual-channel AIS 1/AIS 2 GMSK receiver and message decoder. */
export class AisReceiver implements SampleReceiver {
  private sampleRateHz = 1_024_000;
  private centerOffsetHz = 0;
  private frames = 0;
  private validFrames = 0;
  private rejectedFrames = 0;
  private channel1Frames = 0;
  private channel2Frames = 0;
  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private readonly targets = new Map<number, MutableTarget>();
  private readonly channel1 = new AisChannelDemodulator(-25_000, (bytes) => this.frame(bytes, "AIS 1"));
  private readonly channel2 = new AisChannelDemodulator(25_000, (bytes) => this.frame(bytes, "AIS 2"));
  constructor(private readonly onUpdate: (snapshot: AisSnapshot) => void, private readonly now = () => performance.now()) {}
  setSampleRate(sampleRateHz: number): void { if (sampleRateHz < 192_000) throw new Error("Dual-channel AIS requires at least 192 ksample/s."); this.sampleRateHz = sampleRateHz; this.reset(); }
  setFrequencyOffset(offsetHz: number): void { this.centerOffsetHz = offsetHz; this.reset(); }
  reset(): void {
    this.frames = 0; this.validFrames = 0; this.rejectedFrames = 0; this.channel1Frames = 0; this.channel2Frames = 0;
    this.lastPublishMs = Number.NEGATIVE_INFINITY;
    this.targets.clear(); this.channel1.reset(); this.channel2.reset(); this.publish();
  }
  receiveSamples(block: SampleBlock): void {
    this.channel1.receive(block, this.sampleRateHz, this.centerOffsetHz);
    this.channel2.receive(block, this.sampleRateHz, this.centerOffsetHz);
  }
  /** Public for deterministic fixtures and external framed transports. */
  receiveFrame(bytes: Uint8Array, channel: "AIS 1" | "AIS 2" = "AIS 1"): void { this.frame(bytes, channel); }
  private frame(bytesWithFcs: Uint8Array, channel: "AIS 1" | "AIS 2"): void {
    this.frames += 1;
    if (bytesWithFcs.length < 3 || crc16X25(bytesWithFcs) !== 0xf0b8) { this.rejectedFrames += 1; this.publishThrottled(); return; }
    this.validFrames += 1; if (channel === "AIS 1") this.channel1Frames += 1; else this.channel2Frames += 1;
    const bytes = bytesWithFcs.subarray(0, -2);
    const type = readUnsigned(bytes, 0, 6), mmsi = readUnsigned(bytes, 8, 30);
    if (!mmsi) { this.publishThrottled(); return; }
    const target = this.targets.get(mmsi) ?? { mmsi, name: null, callSign: null, shipType: null, latitude: null, longitude: null,
      speedKnots: null, courseDegrees: null, headingDegrees: null, navigationStatus: null, channel, messages: 0, lastSeenMs: 0 };
    target.channel = channel; target.messages += 1; target.lastSeenMs = this.now();
    if (type >= 1 && type <= 3) {
      target.navigationStatus = readUnsigned(bytes, 38, 4);
      target.speedKnots = nullableScale(readUnsigned(bytes, 50, 10), 1023, 10);
      target.longitude = coordinate(readSigned(bytes, 61, 28), 108_600_000);
      target.latitude = coordinate(readSigned(bytes, 89, 27), 54_600_000);
      target.courseDegrees = nullableScale(readUnsigned(bytes, 116, 12), 3600, 10);
      const heading = readUnsigned(bytes, 128, 9); target.headingDegrees = heading < 360 ? heading : null;
    } else if (type === 18) {
      target.speedKnots = nullableScale(readUnsigned(bytes, 46, 10), 1023, 10);
      target.longitude = coordinate(readSigned(bytes, 57, 28), 108_600_000);
      target.latitude = coordinate(readSigned(bytes, 85, 27), 54_600_000);
      target.courseDegrees = nullableScale(readUnsigned(bytes, 112, 12), 3600, 10);
      const heading = readUnsigned(bytes, 124, 9); target.headingDegrees = heading < 360 ? heading : null;
    } else if (type === 5) {
      target.callSign = readText(bytes, 70, 42); target.name = readText(bytes, 112, 120); target.shipType = readUnsigned(bytes, 232, 8);
    } else if (type === 24) {
      const part = readUnsigned(bytes, 38, 2);
      if (part === 0) target.name = readText(bytes, 40, 120);
      else { target.shipType = readUnsigned(bytes, 40, 8); target.callSign = readText(bytes, 90, 42); }
    }
    this.targets.set(mmsi, target); this.publishThrottled();
  }
  private publishThrottled(): void { if (this.validFrames === 1 || this.now() - this.lastPublishMs >= 250) { this.lastPublishMs = this.now(); this.publish(); } }
  private publish(): void {
    const cutoff = this.now() - 10 * 60_000;
    for (const [mmsi, target] of this.targets) if (target.lastSeenMs < cutoff) this.targets.delete(mmsi);
    const targets = [...this.targets.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    this.onUpdate({ frames: this.frames, validFrames: this.validFrames, rejectedFrames: this.rejectedFrames,
      channel1Frames: this.channel1Frames, channel2Frames: this.channel2Frames, targets,
      message: this.validFrames ? `Tracking ${targets.length} AIS target${targets.length === 1 ? "" : "s"}.` : "Waiting for valid AIS frames on both channels…" });
  }
}

export function crc16X25(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  return crc & 0xffff;
}

function readUnsigned(bytes: Uint8Array, start: number, length: number): number {
  let value = 0; for (let bit = 0; bit < length; bit += 1) value = value * 2 + ((bytes[(start + bit) >> 3]! >> (7 - ((start + bit) & 7))) & 1); return value;
}
function readSigned(bytes: Uint8Array, start: number, length: number): number { const value = readUnsigned(bytes, start, length); return value & 2 ** (length - 1) ? value - 2 ** length : value; }
function readText(bytes: Uint8Array, start: number, length: number): string { let text = ""; for (let bit = 0; bit < length; bit += 6) text += AIS_CHARS[readUnsigned(bytes, start + bit, 6)] ?? " "; return text.replace(/@+$/g, "").trim(); }
function nullableScale(value: number, unavailable: number, divisor: number): number | null { return value >= unavailable ? null : value / divisor; }
function coordinate(value: number, unavailableMagnitude: number): number | null { return Math.abs(value) >= unavailableMagnitude ? null : value / 600_000; }
