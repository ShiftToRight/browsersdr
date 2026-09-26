import {
  DigitalChannelReducer,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  type DigitalPublication,
  type StreamingDigitalDecoder,
} from "../digital";
import { SrdPulseInspector } from "./inspector";
import {
  decodeAcurite592Burst,
  decodeFineOffsetWh51Burst,
  type SrdProtocolDecodeResult,
} from "./protocols";
import { type SrdConfiguration, validateSrdConfiguration } from "./settings";
import {
  SRD_MAX_BURST_HISTORY,
  SRD_MAX_DEVICES,
  SRD_MAX_EVENTS,
  SRD_MAX_READING_HISTORY,
  type SrdBurst,
  type SrdDeviceState,
  type SrdEvent,
  type SrdSensorReading,
  type SrdSnapshot,
} from "./types";

interface Counters {
  bursts: number;
  truncatedBursts: number;
  validatedReadings: number;
  rejectedProtocolFrames: number;
  duplicateReadings: number;
  tracePointsDropped: number;
}

export class SrdReceiver implements StreamingDigitalDecoder<
  SrdSnapshot,
  SrdEvent
> {
  private readonly channel = new DigitalChannelReducer();
  private configuration?: SrdConfiguration;
  private inspector?: SrdPulseInspector;
  private readonly bursts: SrdBurst[] = [];
  private readonly readings: SrdSensorReading[] = [];
  private readonly devices = new Map<string, SrdDeviceState>();
  private readonly events: DigitalPublication<SrdEvent>[] = [];
  private readonly duplicates = new Map<string, number>();
  private counters: Counters = this.emptyCounters();
  private lastProvenance?: DigitalProvenance;
  private snapshotSequence = 0;
  private eventSequence = 0;
  private lastPublishedInputSampleIndex = Number.NEGATIVE_INFINITY;
  private cached?: DigitalPublication<SrdSnapshot>;
  private disposed = false;

  configure(configuration: SrdConfiguration): void {
    validateSrdConfiguration(configuration);
    this.channel.configure(configuration);
    this.configuration = structuredClone(configuration);
    this.inspector = new SrdPulseInspector(this.configuration);
    this.disposed = false;
    this.clearState();
    this.lastProvenance = this.emptyProvenance(configuration);
    this.refreshSnapshot();
  }

  receive(block: DigitalInputBlock): void {
    const configuration = this.requireConfigured();
    const reduced = this.channel.process(block);
    if (reduced.discontinuityBefore && this.lastProvenance) {
      const truncated = this.inspector!.truncate(
        this.lastProvenance,
        "discontinuity",
      );
      if (truncated) this.recordBurst(truncated);
    }
    for (const burst of this.inspector!.process(reduced))
      this.recordBurst(burst);
    this.lastProvenance = reduced.provenance;
    this.counters.tracePointsDropped = this.inspector!.droppedTracePoints;
    if (
      reduced.provenance.lastInputSampleIndex -
        this.lastPublishedInputSampleIndex >=
      configuration.trace.publicationIntervalInputSamples
    )
      this.refreshSnapshot();
  }

  reset(
    _discontinuity: DigitalDiscontinuity = {
      reason: "reset",
      missingInputSamples: null,
    },
  ): void {
    this.requireConfigured();
    if (this.lastProvenance) {
      const truncated = this.inspector!.truncate(this.lastProvenance, "reset");
      if (truncated) this.recordBurst(truncated);
    }
    this.channel.reset();
    this.refreshSnapshot();
  }

  snapshot(): DigitalPublication<SrdSnapshot> {
    this.requireConfigured();
    return this.cached!;
  }

  drainEvents(): readonly DigitalPublication<SrdEvent>[] {
    this.requireConfigured();
    return this.events.splice(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.dispose();
    this.configuration = undefined;
    this.inspector = undefined;
    this.clearState();
    this.cached = undefined;
  }

  private recordBurst(burst: SrdBurst): void {
    this.counters.bursts++;
    if (burst.truncated) this.counters.truncatedBursts++;
    this.pushBounded(this.bursts, burst, SRD_MAX_BURST_HISTORY);
    this.pushEvent({ type: "burst", burst }, burst.provenance);
    if (burst.truncated || this.configuration!.protocol === "none") return;
    const result = this.decode(burst);
    this.counters.rejectedProtocolFrames += result.rejectedFrames;
    if (!result.reading || !result.rawSignature) return;
    const signature = `${result.reading.protocol}:${result.rawSignature}`;
    const previous = this.duplicates.get(signature);
    const window = this.configuration!.actualInputSampleRateHz * 2;
    if (
      previous !== undefined &&
      burst.provenance.lastInputSampleIndex - previous <= window
    ) {
      this.counters.duplicateReadings++;
      return;
    }
    this.duplicates.set(signature, burst.provenance.lastInputSampleIndex);
    while (this.duplicates.size > SRD_MAX_READING_HISTORY) {
      const oldest = this.duplicates.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.duplicates.delete(oldest);
    }
    this.recordReading(result.reading);
  }

  private decode(burst: SrdBurst): SrdProtocolDecodeResult {
    return this.configuration!.protocol === "acurite-592txr"
      ? decodeAcurite592Burst(burst)
      : decodeFineOffsetWh51Burst(burst);
  }

  private recordReading(reading: SrdSensorReading): void {
    this.counters.validatedReadings++;
    this.pushBounded(this.readings, reading, SRD_MAX_READING_HISTORY);
    const key = `${reading.protocol}:${reading.deviceId}`;
    const previous = this.devices.get(key);
    if (!previous && this.devices.size >= SRD_MAX_DEVICES) {
      let oldestKey: string | undefined;
      let oldestIndex = Number.POSITIVE_INFINITY;
      for (const [candidateKey, device] of this.devices)
        if (device.lastInputSampleIndex < oldestIndex) {
          oldestKey = candidateKey;
          oldestIndex = device.lastInputSampleIndex;
        }
      if (oldestKey) this.devices.delete(oldestKey);
    }
    this.devices.set(key, {
      key,
      reading,
      readings: (previous?.readings ?? 0) + 1,
      lastInputSampleIndex: reading.provenance.lastInputSampleIndex,
    });
    this.pushEvent({ type: "reading", reading }, reading.provenance);
  }

  private pushEvent(event: SrdEvent, provenance: DigitalProvenance): void {
    this.pushBounded(
      this.events,
      { sequence: this.eventSequence++, provenance, value: event },
      SRD_MAX_EVENTS,
    );
  }

  private refreshSnapshot(): void {
    const configuration = this.requireConfigured();
    const provenance =
      this.lastProvenance ?? this.emptyProvenance(configuration);
    this.lastPublishedInputSampleIndex = provenance.lastInputSampleIndex;
    this.cached = {
      sequence: this.snapshotSequence++,
      provenance,
      value: {
        modulation: configuration.modulation,
        protocol: configuration.protocol,
        configured: true,
        activeBurst: this.inspector!.isActive,
        trace: this.inspector!.traceSnapshot(),
        bursts: this.bursts.slice(),
        devices: [...this.devices.values()].sort(
          (left, right) =>
            right.lastInputSampleIndex - left.lastInputSampleIndex,
        ),
        recentReadings: this.readings.slice(),
        counters: { ...this.counters },
      },
    };
  }

  private clearState(): void {
    this.bursts.length = 0;
    this.readings.length = 0;
    this.devices.clear();
    this.events.length = 0;
    this.duplicates.clear();
    this.counters = this.emptyCounters();
    this.lastProvenance = undefined;
    this.lastPublishedInputSampleIndex = Number.NEGATIVE_INFINITY;
  }

  private emptyCounters(): Counters {
    return {
      bursts: 0,
      truncatedBursts: 0,
      validatedReadings: 0,
      rejectedProtocolFrames: 0,
      duplicateReadings: 0,
      tracePointsDropped: 0,
    };
  }

  private emptyProvenance(configuration: SrdConfiguration): DigitalProvenance {
    return {
      generation: configuration.generation,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: 0,
      actualInputSampleRateHz: configuration.actualInputSampleRateHz,
      selectedChannelOffsetHz: configuration.selectedChannelOffsetHz,
    };
  }

  private pushBounded<T>(values: T[], value: T, maximum: number): void {
    if (values.length === maximum) values.shift();
    values.push(value);
  }

  private requireConfigured(): SrdConfiguration {
    if (this.disposed || !this.configuration || !this.inspector)
      throw new Error("SRD receiver is not configured.");
    return this.configuration;
  }
}
