import {
  DigitalChannelReducer,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  type DigitalPublication,
  type StreamingDigitalDecoder,
} from "../digital";
import { decodeRs41Frame } from "./frame";
import { Rs41GfskReceiver } from "./gfsk";
import { type Rs41Configuration, validateRs41Configuration } from "./settings";
import {
  RS41_MAX_EVENTS,
  RS41_MAX_RECENT_FRAMES,
  RS41_MAX_SONDES,
  RS41_MAX_TRACK_POINTS,
  type Rs41DecodedFrame,
  type Rs41Event,
  type Rs41Snapshot,
  type Rs41SondeState,
} from "./types";
import { xorRs41Whitening } from "./whitening";

type Counters = Rs41Snapshot["counters"];

export class Rs41Receiver implements StreamingDigitalDecoder<
  Rs41Snapshot,
  Rs41Event
> {
  private readonly channel = new DigitalChannelReducer();
  private configuration?: Rs41Configuration;
  private modem?: Rs41GfskReceiver;
  private readonly sondes = new Map<string, Rs41SondeState>();
  private readonly recentFrames: Rs41DecodedFrame[] = [];
  private readonly events: DigitalPublication<Rs41Event>[] = [];
  private readonly duplicates = new Map<string, number>();
  private counters: Counters = this.emptyCounters();
  private lastProvenance?: DigitalProvenance;
  private cached?: DigitalPublication<Rs41Snapshot>;
  private snapshotSequence = 0;
  private eventSequence = 0;
  private lastPublished = Number.NEGATIVE_INFINITY;
  private disposed = false;

  configure(configuration: Rs41Configuration): void {
    validateRs41Configuration(configuration);
    this.channel.configure(configuration);
    this.configuration = structuredClone(configuration);
    this.modem = new Rs41GfskReceiver(
      configuration.outputSampleRateHz,
      configuration.syncBitErrors,
    );
    this.clear();
    this.disposed = false;
    this.lastProvenance = this.emptyProvenance(configuration);
    this.publish();
  }

  receive(block: DigitalInputBlock): void {
    const configuration = this.requireConfigured();
    const reduced = this.channel.process(block);
    if (reduced.discontinuityBefore) this.modem!.reset();
    for (const raw of this.modem!.process(
      reduced.fmHz,
      reduced.firstOutputInputSampleIndex,
      reduced.inputSamplesPerOutput,
    )) {
      this.counters.synchronizedFrames++;
      const provenance: DigitalProvenance = {
        ...reduced.provenance,
        firstInputSampleIndex: raw.firstInputSampleIndex,
        lastInputSampleIndex: raw.lastInputSampleIndex,
      };
      const frame = decodeRs41Frame(
        xorRs41Whitening(raw.onAirBytes),
        provenance,
        raw.invertedPolarity,
      );
      this.recordFrame(frame);
    }
    this.lastProvenance = reduced.provenance;
    this.expire(reduced.provenance.lastInputSampleIndex);
    if (
      reduced.provenance.lastInputSampleIndex - this.lastPublished >=
      configuration.snapshotIntervalInputSamples
    )
      this.publish();
  }

  reset(
    _discontinuity: DigitalDiscontinuity = {
      reason: "reset",
      missingInputSamples: null,
    },
  ): void {
    this.requireConfigured();
    this.channel.reset();
    this.modem!.reset();
    this.publish();
  }
  /** Publish the final state at an explicit end-of-input barrier. */
  flush(): void { this.requireConfigured(); this.publish(); }

  snapshot(): DigitalPublication<Rs41Snapshot> {
    this.requireConfigured();
    return this.cached!;
  }
  drainEvents(): readonly DigitalPublication<Rs41Event>[] {
    this.requireConfigured();
    return this.events.splice(0);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.dispose();
    this.configuration = undefined;
    this.modem = undefined;
    this.clear();
    this.cached = undefined;
  }

  private recordFrame(frame: Rs41DecodedFrame): void {
    if (frame.sondeId && frame.frameCounter !== undefined) {
      const key = `${frame.sondeId}:${frame.frameCounter}`;
      const previous = this.duplicates.get(key);
      if (
        previous !== undefined &&
        frame.provenance.lastInputSampleIndex - previous <
          this.configuration!.actualInputSampleRateHz
      )
        return;
      this.duplicates.set(key, frame.provenance.lastInputSampleIndex);
      while (this.duplicates.size > RS41_MAX_RECENT_FRAMES)
        this.duplicates.delete(this.duplicates.keys().next().value!);
    }
    if (frame.fecStatus === "uncorrected") this.counters.uncorrectedFrames++;
    else if (frame.fecStatus === "corrected") {
      this.counters.correctedFrames++;
      this.counters.correctedSymbols += frame.correctedErrors;
    } else this.counters.rejectedFrames++;
    if (frame.variant === "unsupported") this.counters.unsupportedVariants++;
    if (!frame.subblockIntegrity.status) this.counters.badStatusSubblocks++;
    if (!frame.subblockIntegrity.gpsInfo) this.counters.badGpsInfoSubblocks++;
    if (!frame.subblockIntegrity.gpsPosition)
      this.counters.badGpsPositionSubblocks++;
    this.pushBounded(this.recentFrames, frame, RS41_MAX_RECENT_FRAMES);
    this.pushBounded(
      this.events,
      {
        sequence: this.eventSequence++,
        provenance: frame.provenance,
        value: { type: "frame", frame },
      },
      RS41_MAX_EVENTS,
    );
    if (
      frame.fecStatus === "rejected" ||
      frame.variant === "unsupported" ||
      !frame.sondeId ||
      frame.frameCounter === undefined
    )
      return;
    const existing = this.sondes.get(frame.sondeId);
    const sessionReset =
      existing !== undefined &&
      frame.frameCounter + 1000 < existing.lastFrameCounter;
    if (
      existing &&
      !sessionReset &&
      frame.frameCounter < existing.lastFrameCounter
    )
      return;
    const previous = sessionReset ? undefined : existing;
    if (!previous && this.sondes.size >= RS41_MAX_SONDES) {
      let oldest: Rs41SondeState | undefined;
      for (const sonde of this.sondes.values())
        if (
          !oldest ||
          sonde.lastHeard.lastInputSampleIndex <
            oldest.lastHeard.lastInputSampleIndex
        )
          oldest = sonde;
      if (oldest) this.sondes.delete(oldest.sondeId);
    }
    const track = previous?.track.slice() ?? [];
    if (frame.position) {
      track.push({
        frameCounter: frame.frameCounter,
        position: frame.position,
        ...(frame.gpsTime ? { gpsTime: frame.gpsTime } : {}),
        provenance: frame.provenance,
        fecStatus: frame.fecStatus,
        correctedErrors: frame.correctedErrors,
      });
      if (track.length > RS41_MAX_TRACK_POINTS)
        track.splice(0, track.length - RS41_MAX_TRACK_POINTS);
    }
    this.sondes.set(frame.sondeId, {
      sondeId: frame.sondeId,
      lastFrameCounter: frame.frameCounter,
      lastHeard: frame.provenance,
      ...(frame.batteryVolts !== undefined
        ? { batteryVolts: frame.batteryVolts }
        : previous?.batteryVolts !== undefined
          ? { batteryVolts: previous.batteryVolts }
          : {}),
      ...(frame.gpsTime
        ? { gpsTime: frame.gpsTime }
        : previous?.gpsTime
          ? { gpsTime: previous.gpsTime }
          : {}),
      ...(frame.position
        ? { position: frame.position }
        : previous?.position
          ? { position: previous.position }
          : {}),
      track,
    });
  }

  private expire(now: number): void {
    const cutoff = now - this.configuration!.sondeExpiryInputSamples;
    for (const [id, sonde] of this.sondes)
      if (sonde.lastHeard.lastInputSampleIndex < cutoff) this.sondes.delete(id);
  }
  private publish(): void {
    const configuration = this.requireConfigured();
    const provenance =
      this.lastProvenance ?? this.emptyProvenance(configuration);
    this.lastPublished = provenance.lastInputSampleIndex;
    this.cached = {
      sequence: this.snapshotSequence++,
      provenance,
      value: {
        configured: true,
        sondes: [...this.sondes.values()].sort(
          (a, b) =>
            b.lastHeard.lastInputSampleIndex - a.lastHeard.lastInputSampleIndex,
        ),
        recentFrames: this.recentFrames.slice(),
        counters: { ...this.counters },
      },
    };
  }
  private pushBounded<T>(items: T[], value: T, cap: number): void {
    items.push(value);
    if (items.length > cap) items.splice(0, items.length - cap);
  }
  private requireConfigured(): Rs41Configuration {
    if (this.disposed || !this.configuration)
      throw new Error("RS41 receiver is not configured.");
    return this.configuration;
  }
  private clear(): void {
    this.sondes.clear();
    this.recentFrames.length = 0;
    this.events.length = 0;
    this.duplicates.clear();
    this.counters = this.emptyCounters();
    this.lastProvenance = undefined;
    this.lastPublished = Number.NEGATIVE_INFINITY;
  }
  private emptyCounters(): Counters {
    return {
      synchronizedFrames: 0,
      uncorrectedFrames: 0,
      correctedFrames: 0,
      rejectedFrames: 0,
      correctedSymbols: 0,
      unsupportedVariants: 0,
      badStatusSubblocks: 0,
      badGpsInfoSubblocks: 0,
      badGpsPositionSubblocks: 0,
    };
  }
  private emptyProvenance(configuration: Rs41Configuration): DigitalProvenance {
    return {
      generation: configuration.generation,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: 0,
      actualInputSampleRateHz: configuration.actualInputSampleRateHz,
      selectedChannelOffsetHz: configuration.selectedChannelOffsetHz,
    };
  }
}
