import { RS41_EXTENDED_FRAME_BYTES, RS41_STANDARD_FRAME_BYTES } from "./types";
import { RS41_ON_AIR_SYNC, RS41_WHITENING_MASK } from "./whitening";

export interface Rs41RawFrame {
  onAirBytes: Uint8Array;
  firstInputSampleIndex: number;
  lastInputSampleIndex: number;
  invertedPolarity: boolean;
}

class FrameSynchronizer {
  private shift = 0n;
  private bitsSeen = 0;
  private readonly sampleHistory: number[] = [];
  private capture?: {
    bytes: number[];
    bitOffset: number;
    current: number;
    firstSample: number;
    inverted: boolean;
    target: number;
  };
  private readonly sync: bigint;
  private readonly syncInverse: bigint;

  constructor(private readonly tolerance: number) {
    let sync = 0n;
    let bitIndex = 0n;
    for (const byte of RS41_ON_AIR_SYNC)
      for (let bit = 0; bit < 8; bit++, bitIndex++)
        if (((byte >>> bit) & 1) !== 0) sync |= 1n << bitIndex;
    this.sync = sync;
    this.syncInverse = ~sync & ((1n << 64n) - 1n);
  }

  reset(): void {
    this.shift = 0n;
    this.bitsSeen = 0;
    this.sampleHistory.length = 0;
    this.capture = undefined;
  }

  push(bit: number, sampleIndex: number): Rs41RawFrame | undefined {
    if (this.capture) return this.captureBit(bit, sampleIndex);
    this.shift =
      ((this.shift >> 1n) | (BigInt(bit & 1) << 63n)) & ((1n << 64n) - 1n);
    this.sampleHistory.push(sampleIndex);
    if (this.sampleHistory.length > 64) this.sampleHistory.shift();
    this.bitsSeen++;
    if (this.bitsSeen < 64) return undefined;
    const normalDistance = popcount(this.shift ^ this.sync);
    const invertedDistance = popcount(this.shift ^ this.syncInverse);
    if (Math.min(normalDistance, invertedDistance) > this.tolerance)
      return undefined;
    const inverted = invertedDistance < normalDistance;
    this.capture = {
      bytes: [...RS41_ON_AIR_SYNC],
      bitOffset: 0,
      current: 0,
      firstSample: this.sampleHistory[0]!,
      inverted,
      target: RS41_STANDARD_FRAME_BYTES,
    };
    return undefined;
  }

  private captureBit(
    rawBit: number,
    sampleIndex: number,
  ): Rs41RawFrame | undefined {
    const capture = this.capture!;
    const bit = capture.inverted ? rawBit ^ 1 : rawBit;
    capture.current |= bit << capture.bitOffset++;
    if (capture.bitOffset < 8) return undefined;
    capture.bytes.push(capture.current);
    capture.current = 0;
    capture.bitOffset = 0;
    if (capture.bytes.length === 57) {
      const frameType = capture.bytes[56]! ^ RS41_WHITENING_MASK[56]!;
      if (frameType === 0xf0) capture.target = RS41_EXTENDED_FRAME_BYTES;
    }
    if (capture.bytes.length < capture.target) return undefined;
    const result = {
      onAirBytes: Uint8Array.from(capture.bytes),
      firstInputSampleIndex: capture.firstSample,
      lastInputSampleIndex: sampleIndex,
      invertedPolarity: capture.inverted,
    };
    this.reset();
    return result;
  }
}

interface TimingBank {
  decisionRateHz: number;
  accumulator: number;
  decisionIndex: number;
  synchronizers: FrameSynchronizer[];
}

/** Streaming NRZ-GFSK slicer with bounded baud/phase hypotheses. */
export class Rs41GfskReceiver {
  private readonly banks: TimingBank[];
  private centerHz = 0;
  private centerReady = false;

  constructor(
    private readonly sampleRateHz: number,
    syncBitErrors: number,
  ) {
    this.banks = [4776, 4790.4, 4800, 4809.6, 4824].map((baud) => ({
      decisionRateHz: baud * 8,
      accumulator: 0,
      decisionIndex: 0,
      synchronizers: Array.from(
        { length: 8 },
        () => new FrameSynchronizer(syncBitErrors),
      ),
    }));
  }

  reset(): void {
    this.centerHz = 0;
    this.centerReady = false;
    for (const bank of this.banks) {
      bank.accumulator = 0;
      bank.decisionIndex = 0;
      for (const synchronizer of bank.synchronizers) synchronizer.reset();
    }
  }

  process(
    samples: Float32Array,
    firstInputSampleIndex: number,
    inputSamplesPerOutput: number,
  ): Rs41RawFrame[] {
    const frames: Rs41RawFrame[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      if (!this.centerReady) {
        this.centerHz = sample;
        this.centerReady = true;
      }
      this.centerHz += 0.0005 * (sample - this.centerHz);
      const hardBit = sample >= this.centerHz ? 1 : 0;
      for (const bank of this.banks) {
        bank.accumulator += bank.decisionRateHz;
        if (bank.accumulator < this.sampleRateHz) continue;
        bank.accumulator -= this.sampleRateHz;
        const phase = bank.decisionIndex++ & 7;
        const sampleIndex =
          firstInputSampleIndex + index * inputSamplesPerOutput;
        const frame = bank.synchronizers[phase]!.push(hardBit, sampleIndex);
        if (frame) frames.push(frame);
      }
    }
    return frames;
  }
}

function popcount(value: bigint): number {
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count++;
  }
  return count;
}
