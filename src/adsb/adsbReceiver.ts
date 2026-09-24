import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";

export const ADSB_FREQUENCY_HZ = 1_090_000_000;
export const ADSB_MIN_SAMPLE_RATE_HZ = 2_000_000;
export const ADSB_BANDWIDTH_HZ = 2_000_000;

export interface AdsbTarget {
  icao: string;
  callsign: string | null;
  altitudeFt: number | null;
  latitude: number | null;
  longitude: number | null;
  groundSpeedKt: number | null;
  trackDegrees: number | null;
  verticalRateFpm: number | null;
  emergency: string | null;
  messages: number;
  lastSeenMs: number;
}

export interface AdsbSnapshot {
  frames: number;
  validFrames: number;
  rejectedFrames: number;
  targets: AdsbTarget[];
  message: string;
}

interface CprFrame { lat: number; lon: number; time: number }
interface MutableTarget extends AdsbTarget { even?: CprFrame; odd?: CprFrame }

const CALLSIGN_CHARS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######";
/** Dependency-free Mode S / 1090ES pulse receiver. */
export class AdsbReceiver implements DigitalSampleReceiver {
  private sampleRateHz = 2_400_000;
  private resampleAccumulator = 0;
  private resampleWeight = 0;
  private samples: number[] = [];
  private scanAt = 0;
  private frames = 0;
  private validFrames = 0;
  private rejectedFrames = 0;
  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private readonly targets = new Map<string, MutableTarget>();

  constructor(private readonly onUpdate: (snapshot: AdsbSnapshot) => void, private readonly now = () => performance.now()) {}

  setSampleRate(sampleRateHz: number): void {
    validateAdsbSampleRate(sampleRateHz);
    this.sampleRateHz = sampleRateHz;
    this.reset();
  }

  configure(sampleRateHz: number, frequencyOffsetHz: number): void {
    validateAdsbSampleRate(sampleRateHz);
    if (!Number.isFinite(frequencyOffsetHz)) throw new Error("ADS-B frequency offset must be finite.");
    // Pulse decoding uses complex magnitude and is invariant to channel rotation.
    this.sampleRateHz = sampleRateHz;
    this.reset();
  }

  reset(): void {
    this.resampleAccumulator = 0; this.resampleWeight = 0; this.samples = []; this.scanAt = 0;
    this.frames = 0; this.validFrames = 0; this.rejectedFrames = 0; this.targets.clear();
    this.lastPublishMs = Number.NEGATIVE_INFINITY;
    this.publish();
  }

  receiveSamples(block: SampleBlock): void {
    // Integrate magnitude into exact 0.5 us chips. This is stable at the RTL's
    // non-integer 2.4-to-2.0 MS/s ratio and acts as a pulse-matched box filter.
    const step = this.sampleRateHz / ADSB_MIN_SAMPLE_RATE_HZ;
    for (let index = 0; index < block.I.length; index += 1) {
      const magnitude = (block.I[index] ?? 0) ** 2 + (block.Q[index] ?? 0) ** 2;
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, step - this.resampleWeight);
        this.resampleAccumulator += magnitude * take; this.resampleWeight += take; remaining -= take;
        if (this.resampleWeight >= step - 1e-9) {
          this.samples.push(this.resampleAccumulator / step);
          this.resampleAccumulator = 0; this.resampleWeight = 0;
        }
      }
    }
    this.scan();
  }

  private scan(): void {
    while (this.scanAt + 240 <= this.samples.length) {
      if (!this.isPreamble(this.scanAt)) { this.scanAt += 1; continue; }
      const bytes = new Uint8Array(14);
      let ambiguous = false;
      for (let bit = 0; bit < 112; bit += 1) {
        const first = this.samples[this.scanAt + 16 + bit * 2] ?? 0;
        const second = this.samples[this.scanAt + 17 + bit * 2] ?? 0;
        if (Math.abs(first - second) < Math.max(first, second) * 0.08) ambiguous = true;
        if (first > second) bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (1 << (7 - (bit & 7)));
      }
      this.frames += 1;
      const df = bytes[0]! >> 3;
      const length = df === 0 || df === 4 || df === 5 || df === 11 ? 7 : 14;
      if (!ambiguous && modeSCrc(bytes.subarray(0, length)) === 0 && (df === 17 || df === 18)) {
        this.validFrames += 1;
        this.decodeExtendedSquitter(bytes);
      } else {
        this.rejectedFrames += 1;
      }
      this.scanAt += length === 14 ? 240 : 128;
    }
    if (this.scanAt > 8192) {
      this.samples.splice(0, this.scanAt);
      this.scanAt = 0;
    }
    if (this.frames > 0 && (this.validFrames === 1 || this.now() - this.lastPublishMs >= 250)) { this.lastPublishMs = this.now(); this.publish(); }
  }

  private isPreamble(at: number): boolean {
    const peak = Math.min(this.samples[at] ?? 0, this.samples[at + 2] ?? 0, this.samples[at + 7] ?? 0, this.samples[at + 9] ?? 0);
    let floor = 0;
    for (const offset of [1, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15]) floor += this.samples[at + offset] ?? 0;
    floor /= 12;
    if (peak <= Math.max(1e-7, floor * 3.5)) return false;
    for (const offset of [1, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15]) if ((this.samples[at + offset] ?? 0) >= peak * 0.72) return false;
    return true;
  }

  private decodeExtendedSquitter(bytes: Uint8Array): void {
    const icao = [...bytes.subarray(1, 4)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
    const target = this.targets.get(icao) ?? {
      icao, callsign: null, altitudeFt: null, latitude: null, longitude: null,
      groundSpeedKt: null, trackDegrees: null, verticalRateFpm: null, emergency: null,
      messages: 0, lastSeenMs: 0,
    };
    target.messages += 1; target.lastSeenMs = this.now();
    const typeCode = bytes[4]! >> 3;
    if (typeCode >= 1 && typeCode <= 4) {
      let callsign = "";
      for (let bit = 40; bit < 88; bit += 6) callsign += CALLSIGN_CHARS[readBits(bytes, bit, 6)] ?? " ";
      target.callsign = callsign.replace(/[_#]/g, " ").trim() || null;
    } else if (typeCode >= 9 && typeCode <= 18) {
      const altitudeCode = readBits(bytes, 40, 12);
      if (altitudeCode & 0x10) target.altitudeFt = (((altitudeCode & 0xfe0) >> 1) | (altitudeCode & 0x0f)) * 25 - 1_000;
      const odd = Boolean(readBits(bytes, 53, 1));
      const frame = { lat: readBits(bytes, 54, 17), lon: readBits(bytes, 71, 17), time: target.lastSeenMs };
      if (odd) target.odd = frame; else target.even = frame;
      const position = decodeGlobalCpr(target.even, target.odd);
      if (position) { target.latitude = position.latitude; target.longitude = position.longitude; }
    } else if (typeCode === 19) {
      const subtype = readBits(bytes, 37, 3);
      if (subtype === 1 || subtype === 2) {
        const ew = readBits(bytes, 46, 10) - 1, ns = readBits(bytes, 57, 10) - 1;
        const vx = readBits(bytes, 45, 1) ? -ew : ew, vy = readBits(bytes, 56, 1) ? -ns : ns;
        target.groundSpeedKt = Math.hypot(vx, vy) * (subtype === 2 ? 4 : 1);
        target.trackDegrees = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
        const vertical = readBits(bytes, 69, 9) - 1;
        if (vertical >= 0) target.verticalRateFpm = (readBits(bytes, 68, 1) ? -vertical : vertical) * 64;
      }
    } else if (typeCode === 28 && readBits(bytes, 37, 3) === 1) {
      target.emergency = ["none", "general", "lifeguard", "minimum fuel", "no communications", "unlawful interference", "downed aircraft", "reserved"][readBits(bytes, 40, 3)] ?? null;
    }
    this.targets.set(icao, target);
  }

  private publish(): void {
    const cutoff = this.now() - 120_000;
    for (const [icao, target] of this.targets) if (target.lastSeenMs < cutoff) this.targets.delete(icao);
    const targets = [...this.targets.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs).map(({ even: _e, odd: _o, ...target }) => target);
    this.onUpdate({ frames: this.frames, validFrames: this.validFrames, rejectedFrames: this.rejectedFrames, targets,
      message: this.validFrames ? `Tracking ${targets.length} ADS-B target${targets.length === 1 ? "" : "s"}.` : "Waiting for valid 1090ES frames…" });
  }
}

export function validateAdsbSampleRate(sampleRateHz: number): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < ADSB_MIN_SAMPLE_RATE_HZ) throw new Error("ADS-B requires at least 2.0 MS/s; select 2.4 MS/s.");
}

export function modeSCrc(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit -= 1) {
    const feedback = ((remainder >> 23) & 1) ^ ((byte >> bit) & 1);
    remainder = (remainder << 1) & 0xffffff;
    if (feedback) remainder ^= 0xfff409;
  }
  return remainder;
}

function readBits(bytes: Uint8Array, start: number, length: number): number {
  let value = 0;
  for (let bit = 0; bit < length; bit += 1) value = value * 2 + ((bytes[(start + bit) >> 3]! >> (7 - ((start + bit) & 7))) & 1);
  return value;
}

function positiveModulo(value: number, modulus: number): number { return ((value % modulus) + modulus) % modulus; }

function cprNl(latitude: number): number {
  if (Math.abs(latitude) >= 87) return Math.abs(latitude) > 87 ? 1 : 2;
  const nz = 15;
  return Math.floor(2 * Math.PI / Math.acos(1 - (1 - Math.cos(Math.PI / (2 * nz))) / Math.cos(Math.PI / 180 * latitude) ** 2));
}

function decodeGlobalCpr(even?: CprFrame, odd?: CprFrame): { latitude: number; longitude: number } | undefined {
  if (!even || !odd || Math.abs(even.time - odd.time) > 10_000) return undefined;
  const j = Math.floor(59 * even.lat / 131072 - 60 * odd.lat / 131072 + 0.5);
  let latEven = 6 * (positiveModulo(j, 60) + even.lat / 131072);
  let latOdd = 360 / 59 * (positiveModulo(j, 59) + odd.lat / 131072);
  if (latEven >= 270) latEven -= 360; if (latOdd >= 270) latOdd -= 360;
  if (cprNl(latEven) !== cprNl(latOdd)) return undefined;
  const useOdd = odd.time > even.time, latitude = useOdd ? latOdd : latEven;
  const nl = Math.max(1, cprNl(latitude) - (useOdd ? 1 : 0));
  const m = Math.floor(even.lon * (cprNl(latitude) - 1) / 131072 - odd.lon * cprNl(latitude) / 131072 + 0.5);
  let longitude = 360 / nl * (positiveModulo(m, nl) + (useOdd ? odd.lon : even.lon) / 131072);
  if (longitude > 180) longitude -= 360;
  return { latitude, longitude };
}
