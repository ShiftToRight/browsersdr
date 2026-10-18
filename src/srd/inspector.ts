import type { DigitalProvenance, ReducedDigitalBlock } from "../digital";
import type { SrdConfiguration } from "./settings";
import {
  SRD_MAX_PULSES_PER_BURST,
  type SrdBitSlice,
  type SrdBurst,
  type SrdPulse,
  type SrdTimingCandidate,
  type SrdTracePoint,
} from "./types";

interface ActiveBurst {
  inputStep: number;
  id: number;
  firstInputSampleIndex: number;
  lastInputSampleIndex: number;
  outputSamples: number;
  inactiveSamples: number;
  pulses: SrdPulse[];
  pulseOverflow: number;
  level: 0 | 1;
  runFirstInputSampleIndex: number;
}

export class SrdPulseInspector {
  private readonly trace: SrdTracePoint[] = [];
  private traceCounter = 0;
  private tracePointsDropped = 0;
  private noiseFloor = 0;
  private noiseReady = false;
  private carrier = false;
  private fskLevel: 0 | 1 = 0;
  private fskLow?: number;
  private fskHigh?: number;
  private active?: ActiveBurst;
  private nextBurstId = 1;

  constructor(private readonly configuration: SrdConfiguration) {}

  get isActive(): boolean {
    return this.active !== undefined;
  }

  get droppedTracePoints(): number {
    return this.tracePointsDropped;
  }

  traceSnapshot(): readonly SrdTracePoint[] {
    return this.trace.slice();
  }

  process(block: ReducedDigitalBlock): readonly SrdBurst[] {
    const completed: SrdBurst[] = [];
    const inputStep = block.inputSamplesPerOutput;
    for (let index = 0; index < block.envelope.length; index++) {
      const inputSampleIndex =
        block.firstOutputInputSampleIndex + index * inputStep;
      const envelope = block.envelope[index]!;
      const discriminatorHz = block.fmHz[index]!;
      this.updateCarrier(envelope);
      const level =
        this.configuration.modulation === "ook"
          ? this.carrier
            ? 1
            : 0
          : this.updateFskLevel(discriminatorHz);
      this.pushTrace(inputSampleIndex, envelope, discriminatorHz, level);

      if (!this.active) {
        if (this.carrier)
          this.active = {
            inputStep,
            id: this.nextBurstId++,
            firstInputSampleIndex: inputSampleIndex,
            lastInputSampleIndex: inputSampleIndex,
            outputSamples: 1,
            inactiveSamples: 0,
            pulses: [],
            pulseOverflow: 0,
            level,
            runFirstInputSampleIndex: inputSampleIndex,
          };
        continue;
      }

      const active = this.active;
      active.outputSamples++;
      active.lastInputSampleIndex = inputSampleIndex;
      active.inactiveSamples = this.carrier ? 0 : active.inactiveSamples + 1;
      if (level !== active.level) {
        this.closeRun(active, inputSampleIndex - inputStep);
        active.level = level;
        active.runFirstInputSampleIndex = inputSampleIndex;
      }

      const durationUs =
        (active.outputSamples / block.outputSampleRateHz) * 1_000_000;
      if (durationUs >= this.configuration.burst.maximumDurationUs) {
        completed.push(
          this.finish(block.provenance, inputStep, true, "maximum-duration"),
        );
        continue;
      }
      const inactiveUs =
        (active.inactiveSamples / block.outputSampleRateHz) * 1_000_000;
      if (inactiveUs >= this.configuration.burst.endGapUs) {
        const burst = this.finish(block.provenance, inputStep, false);
        const totalUs =
          ((burst.provenance.lastInputSampleIndex -
            burst.provenance.firstInputSampleIndex +
            1) /
            burst.provenance.actualInputSampleRateHz) *
          1_000_000;
        if (totalUs >= this.configuration.burst.minimumDurationUs)
          completed.push(burst);
      }
    }
    return completed;
  }

  truncate(
    provenance: DigitalProvenance,
    reason: "discontinuity" | "reset",
  ): SrdBurst | undefined {
    if (!this.active) {
      this.resetSignalState();
      return undefined;
    }
    const burst = this.finish(provenance, this.active.inputStep, true, reason);
    this.resetSignalState();
    return burst;
  }

  resetSignalState(): void {
    this.active = undefined;
    this.carrier = false;
    this.fskLevel = 0;
    this.fskLow = undefined;
    this.fskHigh = undefined;
    this.noiseFloor = 0;
    this.noiseReady = false;
  }

  private updateCarrier(envelope: number): void {
    if (!this.noiseReady) {
      this.noiseFloor = envelope;
      this.noiseReady = true;
    } else if (!this.carrier) {
      this.noiseFloor += 0.002 * (envelope - this.noiseFloor);
    }
    const settings = this.configuration.threshold;
    const center =
      settings.mode === "manual"
        ? settings.carrierLevel
        : Math.max(
            this.noiseFloor * settings.carrierNoiseRatio,
            this.noiseFloor + settings.minimumCarrierMargin,
          );
    const halfHysteresis = settings.carrierHysteresis / 2;
    if (this.carrier) {
      if (envelope < center - halfHysteresis) this.carrier = false;
    } else if (envelope > center + halfHysteresis) this.carrier = true;
  }

  private updateFskLevel(discriminatorHz: number): 0 | 1 {
    const settings = this.configuration.threshold;
    let center = settings.discriminatorHz;
    if (settings.mode === "adaptive" && this.carrier) {
      if (discriminatorHz < center)
        this.fskLow =
          this.fskLow === undefined
            ? discriminatorHz
            : this.fskLow + 0.02 * (discriminatorHz - this.fskLow);
      else
        this.fskHigh =
          this.fskHigh === undefined
            ? discriminatorHz
            : this.fskHigh + 0.02 * (discriminatorHz - this.fskHigh);
      if (this.fskLow !== undefined && this.fskHigh !== undefined)
        center = (this.fskLow + this.fskHigh) / 2;
    }
    const halfHysteresis = settings.discriminatorHysteresisHz / 2;
    if (this.fskLevel) {
      if (discriminatorHz < center - halfHysteresis) this.fskLevel = 0;
    } else if (discriminatorHz > center + halfHysteresis) this.fskLevel = 1;
    return this.fskLevel;
  }

  private pushTrace(
    inputSampleIndex: number,
    envelope: number,
    discriminatorHz: number,
    level: 0 | 1,
  ): void {
    if (this.traceCounter++ % this.configuration.trace.decimation !== 0) return;
    if (this.trace.length === this.configuration.trace.maximumPoints) {
      this.trace.shift();
      this.tracePointsDropped++;
    }
    this.trace.push({
      inputSampleIndex,
      envelope,
      discriminatorHz,
      carrier: this.carrier,
      level,
    });
  }

  private closeRun(active: ActiveBurst, lastInputSampleIndex: number): void {
    if (lastInputSampleIndex < active.runFirstInputSampleIndex) return;
    if (active.pulses.length >= SRD_MAX_PULSES_PER_BURST) {
      active.pulseOverflow++;
      return;
    }
    // Each reduced sample covers a complete input-clock interval. Counting
    // only its first input sample undercounts every run by decimation - 1.
    const end = lastInputSampleIndex + active.inputStep - 1;
    active.pulses.push({
      level: active.level,
      durationUs:
        ((end - active.runFirstInputSampleIndex + 1) /
          this.configuration.actualInputSampleRateHz) *
        1_000_000,
      firstInputSampleIndex: active.runFirstInputSampleIndex,
      lastInputSampleIndex: end,
    });
  }

  private finish(
    blockProvenance: DigitalProvenance,
    inputStep: number,
    truncated: boolean,
    truncationReason?: "discontinuity" | "maximum-duration" | "reset",
  ): SrdBurst {
    const active = this.active!;
    this.closeRun(active, active.lastInputSampleIndex);
    const provenance: DigitalProvenance = {
      ...blockProvenance,
      firstInputSampleIndex: active.firstInputSampleIndex,
      lastInputSampleIndex:
        active.lastInputSampleIndex + Math.max(0, inputStep - 1),
    };
    const timingCandidates = estimateTiming(active.pulses);
    const bitSlice = this.configuration.bitSlice.enabled
      ? sliceBits(active.pulses, this.configuration)
      : undefined;
    const burst: SrdBurst = {
      id: active.id,
      modulation: this.configuration.modulation,
      pulses: active.pulses,
      pulseOverflow: active.pulseOverflow,
      truncated: truncated || active.pulseOverflow > 0,
      ...(truncationReason ? { truncationReason } : {}),
      timingCandidates,
      ...(bitSlice ? { bitSlice } : {}),
      provenance,
    };
    this.active = undefined;
    return burst;
  }
}

export function estimateTiming(
  pulses: readonly Pick<SrdPulse, "durationUs">[],
): readonly SrdTimingCandidate[] {
  const clusters: { mean: number; count: number }[] = [];
  for (const pulse of pulses) {
    if (pulse.durationUs <= 0 || pulse.durationUs > 20_000) continue;
    const cluster = clusters.find(
      (candidate) =>
        Math.abs(candidate.mean - pulse.durationUs) <= candidate.mean * 0.18,
    );
    if (cluster) {
      cluster.mean =
        (cluster.mean * cluster.count + pulse.durationUs) / (cluster.count + 1);
      cluster.count++;
    } else clusters.push({ mean: pulse.durationUs, count: 1 });
  }
  return clusters
    .sort((left, right) => right.count - left.count || left.mean - right.mean)
    .slice(0, 3)
    .map((cluster) => ({
      symbolUs: Math.round(cluster.mean * 10) / 10,
      support: cluster.count,
      basis: "pulse-duration-cluster" as const,
    }));
}

function sliceBits(
  pulses: readonly SrdPulse[],
  configuration: SrdConfiguration,
): SrdBitSlice {
  const settings = configuration.bitSlice;
  let bits = "";
  if (settings.encoding === "nrz") {
    for (const pulse of pulses) {
      const count = Math.max(
        1,
        Math.round(pulse.durationUs / settings.symbolUs),
      );
      bits += (pulse.level ? "1" : "0").repeat(Math.min(256, count));
      if (bits.length >= 8_192) break;
    }
  } else {
    const highs = pulses.filter((pulse) => pulse.level === 1);
    for (const pulse of highs)
      bits += pulse.durationUs < settings.symbolUs * 1.5 ? "0" : "1";
  }
  if (settings.polarity === "inverted")
    bits = bits.replace(/[01]/g, (bit) => (bit === "0" ? "1" : "0"));
  return {
    bits: bits.slice(0, 8_192),
    symbolUs: settings.symbolUs,
    encoding: settings.encoding,
    polarity: settings.polarity,
    truncated: bits.length > 8_192,
  };
}
