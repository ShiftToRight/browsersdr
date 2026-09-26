import {
  DigitalChannelReducer,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  type DigitalPublication,
  type StreamingDigitalDecoder,
} from "../digital";
import { Bell202Receiver } from "./afsk1200";
import { formatAx25Address, hasValidAx25Fcs, parseAx25UiFrame } from "./ax25";
import { parseAprsPayload } from "./payload";
import { type AprsConfiguration, validateAprsConfiguration } from "./settings";
import {
  APRS_MAX_EVENTS,
  APRS_MAX_PACKET_LOG,
  APRS_MAX_STATIONS,
  type AprsEvent,
  type AprsPacketRecord,
  type AprsSnapshot,
  type AprsStationState,
} from "./types";

type Counters = AprsSnapshot["counters"];

export class AprsReceiver implements StreamingDigitalDecoder<
  AprsSnapshot,
  AprsEvent
> {
  private readonly channel = new DigitalChannelReducer();
  private configuration?: AprsConfiguration;
  private modem?: Bell202Receiver;
  private readonly stations = new Map<string, AprsStationState>();
  private readonly packets: AprsPacketRecord[] = [];
  private readonly events: DigitalPublication<AprsEvent>[] = [];
  private readonly duplicates = new Map<string, number>();
  private counters: Counters = this.emptyCounters();
  private lastProvenance?: DigitalProvenance;
  private cached?: DigitalPublication<AprsSnapshot>;
  private snapshotSequence = 0;
  private packetSequence = 0;
  private eventSequence = 0;
  private lastPublished = Number.NEGATIVE_INFINITY;
  private disposed = false;

  configure(configuration: AprsConfiguration): void {
    validateAprsConfiguration(configuration);
    this.channel.configure(configuration);
    this.configuration = structuredClone(configuration);
    this.modem = new Bell202Receiver(configuration.outputSampleRateHz);
    this.clear();
    this.disposed = false;
    this.lastProvenance = this.emptyProvenance(configuration);
    this.publish();
  }

  receive(block: DigitalInputBlock): void {
    const configuration = this.requireConfigured();
    const reduced = this.channel.process(block);
    if (reduced.discontinuityBefore) this.modem!.reset();
    for (const candidate of this.modem!.process(
      reduced.fmHz,
      reduced.firstOutputInputSampleIndex,
      reduced.inputSamplesPerOutput,
    )) {
      this.counters.hdlcCandidates++;
      const provenance: DigitalProvenance = {
        ...reduced.provenance,
        firstInputSampleIndex: candidate.firstSampleIndex,
        lastInputSampleIndex: candidate.lastSampleIndex,
      };
      if (!hasValidAx25Fcs(candidate.bytes)) {
        this.counters.invalidFcsFrames++;
        this.pushEvent({ type: "invalid-frame", reason: "fcs" }, provenance);
        continue;
      }
      const frame = parseAx25UiFrame(candidate.bytes);
      if (!frame) {
        this.counters.malformedAx25Frames++;
        this.pushEvent(
          { type: "invalid-frame", reason: "malformed" },
          provenance,
        );
        continue;
      }
      this.counters.validAx25Frames++;
      const signature = [...candidate.bytes]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const previous = this.duplicates.get(signature);
      if (
        previous !== undefined &&
        provenance.lastInputSampleIndex - previous <=
          configuration.duplicateWindowInputSamples
      ) {
        this.counters.duplicatePackets++;
        continue;
      }
      this.duplicates.set(signature, provenance.lastInputSampleIndex);
      while (this.duplicates.size > APRS_MAX_PACKET_LOG)
        this.duplicates.delete(this.duplicates.keys().next().value!);
      const payload = parseAprsPayload(frame);
      if (payload.kind === "unsupported")
        this.counters.unsupportedAprsPackets++;
      else this.counters.decodedAprsPackets++;
      const packet: AprsPacketRecord = {
        sequence: this.packetSequence++,
        frame,
        payload,
        provenance,
      };
      this.pushBounded(this.packets, packet, APRS_MAX_PACKET_LOG);
      this.updateStation(packet);
      this.pushEvent({ type: "packet", packet }, provenance);
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

  snapshot(): DigitalPublication<AprsSnapshot> {
    this.requireConfigured();
    return this.cached!;
  }
  drainEvents(): readonly DigitalPublication<AprsEvent>[] {
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

  private updateStation(packet: AprsPacketRecord): void {
    const key = formatAx25Address(packet.frame.source);
    const previous = this.stations.get(key);
    if (!previous && this.stations.size >= APRS_MAX_STATIONS) {
      let oldest: AprsStationState | undefined;
      for (const station of this.stations.values())
        if (
          !oldest ||
          station.lastHeard.lastInputSampleIndex <
            oldest.lastHeard.lastInputSampleIndex
        )
          oldest = station;
      if (oldest) this.stations.delete(oldest.key);
    }
    const payload = packet.payload;
    const located =
      payload.kind === "position" || payload.kind === "mic-e"
        ? payload
        : undefined;
    this.stations.set(key, {
      key,
      source: packet.frame.source,
      destination: packet.frame.destination,
      path: packet.frame.path,
      packets: (previous?.packets ?? 0) + 1,
      lastHeard: packet.provenance,
      ...(located?.position
        ? { position: located.position }
        : previous?.position
          ? { position: previous.position }
          : {}),
      ...(located?.altitudeMeters !== undefined
        ? { altitudeMeters: located.altitudeMeters }
        : previous?.altitudeMeters !== undefined
          ? { altitudeMeters: previous.altitudeMeters }
          : {}),
      ...(located?.weather
        ? { weather: located.weather }
        : payload.kind === "weather"
          ? { weather: payload.weather }
          : previous?.weather
            ? { weather: previous.weather }
            : {}),
      ...(payload.kind === "status"
        ? { statusText: payload.text }
        : previous?.statusText
          ? { statusText: previous.statusText }
          : {}),
    });
  }

  private expire(now: number): void {
    const cutoff = now - this.configuration!.stationExpiryInputSamples;
    for (const [key, station] of this.stations)
      if (station.lastHeard.lastInputSampleIndex < cutoff)
        this.stations.delete(key);
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
        stations: [...this.stations.values()].sort(
          (a, b) =>
            b.lastHeard.lastInputSampleIndex - a.lastHeard.lastInputSampleIndex,
        ),
        recentPackets: this.packets.slice(),
        counters: { ...this.counters },
      },
    };
  }

  private pushEvent(value: AprsEvent, provenance: DigitalProvenance): void {
    this.pushBounded(
      this.events,
      { sequence: this.eventSequence++, provenance, value },
      APRS_MAX_EVENTS,
    );
  }
  private pushBounded<T>(items: T[], value: T, cap: number): void {
    items.push(value);
    if (items.length > cap) items.splice(0, items.length - cap);
  }
  private requireConfigured(): AprsConfiguration {
    if (this.disposed || !this.configuration)
      throw new Error("APRS receiver is not configured.");
    return this.configuration;
  }
  private clear(): void {
    this.stations.clear();
    this.packets.length = 0;
    this.events.length = 0;
    this.duplicates.clear();
    this.counters = this.emptyCounters();
    this.lastProvenance = undefined;
    this.lastPublished = Number.NEGATIVE_INFINITY;
  }
  private emptyCounters(): Counters {
    return {
      hdlcCandidates: 0,
      validAx25Frames: 0,
      invalidFcsFrames: 0,
      malformedAx25Frames: 0,
      decodedAprsPackets: 0,
      unsupportedAprsPackets: 0,
      duplicatePackets: 0,
    };
  }
  private emptyProvenance(configuration: AprsConfiguration): DigitalProvenance {
    return {
      generation: configuration.generation,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: 0,
      actualInputSampleRateHz: configuration.actualInputSampleRateHz,
      selectedChannelOffsetHz: configuration.selectedChannelOffsetHz,
    };
  }
}
