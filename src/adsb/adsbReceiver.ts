import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import {
  appendTargetFix,
  boundTargets,
  type TargetTrackPoint,
} from "../digital/targetTrack";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";

import {
  classifyAdsbAddress,
  decodeAdsbQuality,
  decodeGlobalCpr,
  readBits,
  surfaceMovement,
  type AdsbQuality,
  type AdsbAddress,
  type CprFrame,
} from "./adsbFields";

export const ADSB_FREQUENCY_HZ = 1_090_000_000;
export const ADSB_MIN_SAMPLE_RATE_HZ = 2_000_000;
export const ADSB_BANDWIDTH_HZ = 2_000_000;

export interface AdsbTarget extends Partial<Omit<AdsbAddress, "icao">> {
  icao: string | null;
  onGround?: boolean;
  geometricAltitudeFt?: number | null;
  positionTimeMs?: number;
  positionStatus?: string;
  surfaceSpeedRangeKt?: readonly [number, number | null] | null;
  quality?: AdsbQuality;

  callsign: string | null;
  /** Reported emitter category (A0–D7); absent in older snapshots. */
  category?: string | null;
  track?: readonly TargetTrackPoint[];
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
  /** Coarse Mode S preamble candidates. Kept as `frames` for snapshot compatibility. */
  frames: number;
  preamblesDetected: number;
  /** CRC-valid DF17/DF18 frames decoded by BrowserSDR. */
  validFrames: number;
  /** All frames with an unoverlaid, zero-remainder Mode S CRC. */
  crcValidFrames: number;
  /** CRC-valid frames whose downlink/control format is not currently decoded. */
  unsupportedFrames: number;
  crcFailures: number;
  ambiguousFrames: number;
  /** All preambles that did not produce a supported DF17/DF18 frame. */
  rejectedFrames: number;
  targets: AdsbTarget[];
  message: string;
}

interface MutableTarget extends AdsbTarget {
  even?: CprFrame;
  odd?: CprFrame;
  cprKind?: "surface" | "barometric" | "geometric";
  cprReference?: TargetTrackPoint;
}

const CALLSIGN_CHARS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######";
const PREAMBLE_PULSES = new Set([0, 2, 7, 9]);
const PREAMBLE_GAPS = [1, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15] as const;
const ALTERNATE_COARSE_PHASE = 1 / 3;
const TIMING_PHASES = [
  -1, -5 / 6, -2 / 3, -0.5, -1 / 3, -1 / 6, 0,
  1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6, 1,
] as const;
/** Dependency-free Mode S / 1090ES pulse receiver. */
export class AdsbReceiver implements DigitalSampleReceiver {
  private inputSamples = 0;
  private sampleRateHz = 2_400_000;
  private resampleAccumulator = 0;
  private resampleWeight = 0;
  private samples: number[] = [];
  private alternateSamples: number[] = [];
  /** 3.2 MS/s has a different native/chip phase lattice from the 2.4 profile. */
  private thirdPhaseSamples: number[] = [];
  private scanAt = 0;
  private chipBaseIndex = 0;
  private nativeSamples: number[] = [];
  private nativeBaseIndex = 0;
  private readonly candidateBytes = new Uint8Array(14);
  private readonly timingBytes = new Uint8Array(14);
  private readonly timingStarts = new Float64Array(TIMING_PHASES.length);
  private readonly timingScores = new Float64Array(TIMING_PHASES.length);
  private frames = 0;
  private validFrames = 0;
  private crcValidFrames = 0;
  private unsupportedFrames = 0;
  private crcFailures = 0;
  private ambiguousFrames = 0;
  private rejectedFrames = 0;
  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private readonly targets = new Map<string, MutableTarget>();

  constructor(private readonly onUpdate: (snapshot: AdsbSnapshot) => void, private readonly now = () => this.inputSamples / this.sampleRateHz * 1000) {}

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
    this.inputSamples = 0;
    this.resampleAccumulator = 0; this.resampleWeight = 0; this.samples = []; this.scanAt = 0;
    this.alternateSamples = [];
    this.thirdPhaseSamples = [];
    this.chipBaseIndex = 0; this.nativeSamples = []; this.nativeBaseIndex = 0;
    this.frames = 0; this.validFrames = 0; this.crcValidFrames = 0; this.unsupportedFrames = 0;
    this.crcFailures = 0; this.ambiguousFrames = 0; this.rejectedFrames = 0; this.targets.clear();
    this.lastPublishMs = Number.NEGATIVE_INFINITY;
    this.publish();
  }

  receiveSamples(block: SampleBlock): void {
    // Block-end input time remains deterministic during replay and browser stalls.
    this.inputSamples += block.I.length;
    // Integrate magnitude into exact 0.5 us chips. This is stable at the RTL's
    // non-integer 2.4-to-2.0 MS/s ratio and acts as a pulse-matched box filter.
    const step = this.sampleRateHz / ADSB_MIN_SAMPLE_RATE_HZ;
    for (let index = 0; index < block.I.length; index += 1) {
      const magnitude = (block.I[index] ?? 0) ** 2 + (block.Q[index] ?? 0) ** 2;
      this.nativeSamples.push(magnitude);
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
    this.populateAlternateSamples();
    this.scan();
  }

  private scan(): void {
    while (this.scanAt + 240 <= this.samples.length) {
      const primaryPreamble = this.isPreamble(this.samples, this.scanAt);
      const alternatePreamble = this.isPreamble(this.alternateSamples, this.scanAt);
      const thirdPreamble = this.sampleRateHz === 3_200_000 && this.isPreamble(this.thirdPhaseSamples, this.scanAt);
      if (!primaryPreamble && !alternatePreamble && !thirdPreamble) { this.scanAt += 1; continue; }
      const bytes = this.candidateBytes;
      const coarsePhase = primaryPreamble ? 0 : alternatePreamble ? ALTERNATE_COARSE_PHASE : 2 / 3;
      const bestTiming = this.scoreTimings(this.scanAt, coarsePhase);
      let selectedCode = -1;
      let selectedScore = Number.NEGATIVE_INFINITY;
      for (let timingIndex = 0; timingIndex < TIMING_PHASES.length; timingIndex += 1) {
        const score = this.timingScores[timingIndex]!;
        if (!Number.isFinite(score)) continue;
        const code = this.decodeAt(this.timingStarts[timingIndex]!, this.timingBytes);
        const ambiguous = Boolean(code & 0x20);
        const length = code & 0x40 ? 14 : 7;
        if (!ambiguous && modeSCrc(this.timingBytes.subarray(0, length)) === 0 && score > selectedScore) {
          selectedCode = code;
          selectedScore = score;
          bytes.set(this.timingBytes);
        }
      }
      const code = selectedCode >= 0 ? selectedCode : this.decodeAt(this.timingStarts[bestTiming]!, bytes);
      const ambiguous = Boolean(code & 0x20);
      const df = code & 0x1f;
      const length = code & 0x40 ? 14 : 7;
      let accepted = false;
      this.frames += 1;
      if (ambiguous) {
        this.ambiguousFrames += 1;
        this.rejectedFrames += 1;
      } else if (modeSCrc(bytes.subarray(0, length)) !== 0) {
        this.crcFailures += 1;
        this.rejectedFrames += 1;
      } else if ((df === 17 || df === 18) && classifyAdsbAddress(bytes)) {
        this.crcValidFrames += 1;
        this.validFrames += 1;
        accepted = true;
        this.decodeExtendedSquitter(bytes);
      } else {
        this.crcValidFrames += 1;
        this.unsupportedFrames += 1;
        this.rejectedFrames += 1;
        accepted = true;
      }
      // A failed coarse trigger proves only that a preamble-like pattern was
      // present. Do not let it hide a real frame later in the presumed payload.
      this.scanAt += accepted ? (length === 14 ? 240 : 128) : 16;
    }
    if (this.scanAt > 8192) {
      const removedChips = this.scanAt;
      this.samples.splice(0, removedChips);
      this.alternateSamples.splice(0, removedChips);
      this.thirdPhaseSamples.splice(0, removedChips);
      this.chipBaseIndex += removedChips;
      this.scanAt = 0;
      const retainNativeAt = Math.max(0, Math.floor(this.chipBaseIndex * this.resampleStep()) - 4);
      const removeNative = Math.min(this.nativeSamples.length, Math.max(0, retainNativeAt - this.nativeBaseIndex));
      if (removeNative > 0) {
        this.nativeSamples.splice(0, removeNative);
        this.nativeBaseIndex += removeNative;
      }
    }
    if (this.frames > 0 && (this.validFrames === 1 || this.now() - this.lastPublishMs >= 250)) { this.lastPublishMs = this.now(); this.publish(); }
  }

  private isPreamble(samples: number[], at: number): boolean {
    if (at + 15 >= samples.length) return false;
    const peak = Math.min(samples[at] ?? 0, samples[at + 2] ?? 0, samples[at + 7] ?? 0, samples[at + 9] ?? 0);
    let floor = 0;
    for (const offset of PREAMBLE_GAPS) floor += samples[at + offset] ?? 0;
    floor /= 12;
    if (peak <= Math.max(1e-7, floor * 3)) return false;
    for (const offset of PREAMBLE_GAPS) if ((samples[at + offset] ?? 0) >= peak * 0.85) return false;
    return true;
  }

  private resampleStep(): number { return this.sampleRateHz / ADSB_MIN_SAMPLE_RATE_HZ; }

  private populateAlternateSamples(): void {
    const step = this.resampleStep();
    const targetLength = this.samples.length;
    this.populatePhaseSamples(this.alternateSamples, ALTERNATE_COARSE_PHASE, step, targetLength);
    if (this.sampleRateHz === 3_200_000)
      this.populatePhaseSamples(this.thirdPhaseSamples, 2 / 3, step, targetLength);
  }

  private populatePhaseSamples(samples: number[], phase: number, step: number, targetLength: number): void {
    while (samples.length < targetLength) {
      const globalChip = this.chipBaseIndex + samples.length;
      const energy = this.integratedNativeOrUndefined((globalChip + phase) * step, step);
      if (energy === undefined) break;
      samples.push(energy);
    }
  }

  private scoreTimings(at: number, coarsePhase: number): number {
    const step = this.resampleStep();
    const coarse = (this.chipBaseIndex + at + coarsePhase) * step;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let timingIndex = 0; timingIndex < TIMING_PHASES.length; timingIndex += 1) {
      const phase = TIMING_PHASES[timingIndex]!;
      const start = coarse + phase * step;
      this.timingStarts[timingIndex] = start;
      this.timingScores[timingIndex] = Number.NEGATIVE_INFINITY;
      let pulseMinimum = Number.POSITIVE_INFINITY;
      let floorSum = 0;
      let floorMaximum = 0;
      let available = true;
      for (let chip = 0; chip < 16; chip += 1) {
        const energy = this.integratedNativeOrUndefined(start + chip * step, step);
        if (energy === undefined) { available = false; break; }
        if (PREAMBLE_PULSES.has(chip)) pulseMinimum = Math.min(pulseMinimum, energy);
        else { floorSum += energy; floorMaximum = Math.max(floorMaximum, energy); }
      }
      if (!available) continue;
      const floor = floorSum / 12;
      if (pulseMinimum <= Math.max(1e-7, floor * 3.5) || floorMaximum >= pulseMinimum * 0.72) continue;
      const score = (pulseMinimum - Math.max(floor, floorMaximum)) / (pulseMinimum + floor + 1e-12);
      this.timingScores[timingIndex] = score;
      if (score > bestScore) { bestScore = score; bestIndex = timingIndex; }
    }
    // The coarse phase passed isPreamble, so its zero-offset native window is
    // always a valid fallback except at the first fractional sample of a run.
    if (!Number.isFinite(bestScore)) {
      bestIndex = 6;
      this.timingStarts[bestIndex] = coarse;
      this.timingScores[bestIndex] = 0;
    }
    return bestIndex;
  }

  /** Returns DF in bits 0..4, ambiguity in bit 5 and long-frame length in bit 6. */
  private decodeAt(timing: number, bytes: Uint8Array): number {
    bytes.fill(0);
    let ambiguous = false;
    let bitLength = 112;
    const step = this.resampleStep();
    for (let bit = 0; bit < bitLength; bit += 1) {
      const first = this.integratedNative(timing + (16 + bit * 2) * step, step);
      const second = this.integratedNative(timing + (17 + bit * 2) * step, step);
      if (Math.abs(first - second) < Math.max(first, second) * 0.08) ambiguous = true;
      if (first > second) bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (1 << (7 - (bit & 7)));
      if (bit === 7) {
        const df = bytes[0]! >> 3;
        bitLength = df === 0 || df === 4 || df === 5 || df === 11 ? 56 : 112;
      }
    }
    const df = bytes[0]! >> 3;
    return df | (ambiguous ? 0x20 : 0) | (bitLength === 112 ? 0x40 : 0);
  }

  private integratedNative(start: number, width: number): number {
    return this.integratedNativeOrUndefined(start, width) ?? 0;
  }

  private integratedNativeOrUndefined(start: number, width = this.resampleStep()): number | undefined {
    const end = start + width;
    const availableEnd = this.nativeBaseIndex + this.nativeSamples.length;
    if (start < this.nativeBaseIndex || end > availableEnd) return undefined;
    let sum = 0;
    let cursor = start;
    while (cursor < end - 1e-9) {
      const absoluteIndex = Math.floor(cursor);
      const next = Math.min(end, absoluteIndex + 1);
      sum += (this.nativeSamples[absoluteIndex - this.nativeBaseIndex] ?? 0) * (next - cursor);
      cursor = next;
    }
    return sum / width;
  }

  private decodeExtendedSquitter(bytes: Uint8Array): void {
    const address = classifyAdsbAddress(bytes)!;
    const previous = this.targets.get(address.id);
    const target: MutableTarget = (previous &&
    previous.lastSeenMs >= this.now() - 120_000
      ? previous
      : undefined) ?? {
      ...address,
      callsign: null,
      category: null,
      track: [],
      altitudeFt: null,
      latitude: null,
      longitude: null,
      groundSpeedKt: null,
      trackDegrees: null,
      verticalRateFpm: null,
      emergency: null,
      messages: 0,
      lastSeenMs: 0,
    };
    target.messages += 1;
    target.lastSeenMs = this.now();
    const typeCode = bytes[4]! >> 3;
    if (typeCode >= 1 && typeCode <= 4) {
      target.category = `${"DCBA"[typeCode - 1]}${bytes[4]! & 7}`;
      let callsign = "";
      for (let bit = 40; bit < 88; bit += 6)
        callsign += CALLSIGN_CHARS[readBits(bytes, bit, 6)] ?? " ";
      target.callsign = callsign.replace(/[_#]/g, " ").trim() || null;
    } else if (
      (typeCode >= 5 && typeCode <= 18) ||
      (typeCode >= 20 && typeCode <= 22)
    ) {
      const surface = typeCode <= 8;
      const kind = surface
        ? "surface"
        : typeCode >= 20
          ? "geometric"
          : "barometric";
      if (target.cprKind !== kind) {
        target.even = undefined;
        target.odd = undefined;
      }
      target.cprKind = kind;
      target.onGround = surface;
      if (surface) {
        target.altitudeFt = null;
        target.geometricAltitudeFt = null;
        target.verticalRateFpm = null;
        target.surfaceSpeedRangeKt = surfaceMovement(readBits(bytes, 37, 7),
          target.quality && target.lastSeenMs - target.quality.reportedAtMs <= 30_000
            ? target.quality.version : undefined);
        target.groundSpeedKt = null;
        target.trackDegrees = readBits(bytes, 44, 1)
          ? (readBits(bytes, 45, 7) * 360) / 128
          : null;
      } else {
        target.surfaceSpeedRangeKt = null;
        const code = readBits(bytes, 40, 12);
        // Q=0 Gillham decoding remains unsupported; never retain an old value
        // in place of an unavailable or unsupported altitude report.
        const altitude =
          code & 0x10
            ? (((code & 0xfe0) >> 1) | (code & 0x0f)) * 25 - 1_000
            : null;
        if (kind === "geometric") target.geometricAltitudeFt = altitude;
        else target.altitudeFt = altitude;
      }
      const odd = Boolean(readBits(bytes, 53, 1));
      const frame = {
        lat: readBits(bytes, 54, 17),
        lon: readBits(bytes, 71, 17),
        time: target.lastSeenMs,
      };
      if (odd) target.odd = frame;
      else target.even = frame;
      const reference =
        target.cprReference &&
        target.lastSeenMs - target.cprReference.timeMs <= 60_000
          ? target.cprReference
          : undefined;
      const position =
        surface && !reference
          ? undefined
          : decodeGlobalCpr(
              target.even,
              target.odd,
              surface ? reference : undefined,
            );
      if (position) {
        target.latitude = position.latitude;
        target.longitude = position.longitude;
        target.positionTimeMs = target.lastSeenMs;
        target.positionStatus = surface
          ? "Surface CPR pair · recent target fix within 45 NM"
          : "Airborne global CPR pair";
        target.track = appendTargetFix(
          target.track ?? [],
          position.latitude,
          position.longitude,
          target.lastSeenMs,
        );
        target.cprReference = { ...position, timeMs: target.lastSeenMs };
      } else if (surface) {
        target.latitude = null;
        target.longitude = null;
        target.positionStatus = reference
          ? "Waiting for a compatible surface CPR pair within 45 NM"
          : "Surface position needs a recent airborne fix for this target";
      }
    } else if (typeCode === 19) {
      const subtype = readBits(bytes, 37, 3);
      if (subtype >= 1 && subtype <= 4) {
        target.onGround = false;
        target.surfaceSpeedRangeKt = null;
        if (subtype === 1 || subtype === 2) {
          const ew = readBits(bytes, 46, 10),
            ns = readBits(bytes, 57, 10);
          const vx = (readBits(bytes, 45, 1) ? -1 : 1) * (ew - 1),
            vy = (readBits(bytes, 56, 1) ? -1 : 1) * (ns - 1);
          target.groundSpeedKt =
            ew && ns ? Math.hypot(vx, vy) * (subtype === 2 ? 4 : 1) : null;
          target.trackDegrees = target.groundSpeedKt
            ? ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360
            : null;
        } else {
          // Airspeed/heading subtypes are not ground velocity.
          target.groundSpeedKt = null;
          target.trackDegrees = null;
        }
        const vertical = readBits(bytes, 69, 9);
        target.verticalRateFpm = vertical
          ? (vertical - 1) * (readBits(bytes, 68, 1) ? -64 : 64)
          : null;
      }
    } else if (typeCode === 28 && readBits(bytes, 37, 3) === 1) {
      target.emergency =
        [
          "none",
          "general",
          "lifeguard",
          "minimum fuel",
          "no communications",
          "unlawful interference",
          "downed aircraft",
          "reserved",
        ][readBits(bytes, 40, 3)] ?? null;
    }
    if (typeCode === 31) {
      // A new unsupported version/subtype invalidates earlier quality.
      target.quality = decodeAdsbQuality(bytes, target.lastSeenMs);
    }
    this.targets.set(address.id, target);
    boundTargets(this.targets);
  }

  private publish(): void {
    const cutoff = this.now() - 120_000;
    for (const [icao, target] of this.targets)
      if (target.lastSeenMs < cutoff) this.targets.delete(icao);
    for (const target of this.targets.values()) {
      if (
        target.positionTimeMs !== undefined &&
        this.now() - target.positionTimeMs > 30_000
      ) {
        target.latitude = null;
        target.longitude = null;
        target.positionStatus = "Position expired";
      }
      if (target.quality && this.now() - target.quality.reportedAtMs > 30_000)
        target.quality = undefined;
    }
    const targets = [...this.targets.values()]
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .map(
        ({
          even: _e,
          odd: _o,
          cprKind: _c,
          cprReference: _r,
          ...target
        }) => target,
      );
    this.onUpdate({
      frames: this.frames,
      preamblesDetected: this.frames,
      validFrames: this.validFrames,
      crcValidFrames: this.crcValidFrames,
      unsupportedFrames: this.unsupportedFrames,
      crcFailures: this.crcFailures,
      ambiguousFrames: this.ambiguousFrames,
      rejectedFrames: this.rejectedFrames,
      targets,
      message: this.validFrames
        ? `Tracking ${targets.length} ADS-B target${targets.length === 1 ? "" : "s"}.`
        : "Waiting for valid 1090ES frames…",
    });
  }
}

export function validateAdsbSampleRate(sampleRateHz: number): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < ADSB_MIN_SAMPLE_RATE_HZ)
    throw new Error("ADS-B requires at least 2.0 MS/s; select 2.4 MS/s.");
}

export function modeSCrc(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes)
    for (let bit = 7; bit >= 0; bit -= 1) {
      const feedback = ((remainder >> 23) & 1) ^ ((byte >> bit) & 1);
      remainder = (remainder << 1) & 0xffffff;
      if (feedback) remainder ^= 0xfff409;
    }
  return remainder;
}
