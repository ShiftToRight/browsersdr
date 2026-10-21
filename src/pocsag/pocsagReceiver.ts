import {
  DigitalChannelReducer,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  type DigitalPublication,
  type StreamingDigitalDecoder,
} from "../digital";
import { PocsagDemodulator } from "./demodulator";
import {
  type PocsagConfiguration,
  validatePocsagConfiguration,
} from "./settings";
import { type FramedMessage } from "./framing";
import {
  POCSAG_MAX_HISTORY,
  POCSAG_PUBLISHED_MESSAGES,
  type PocsagEvent,
  type PocsagMessage,
  type PocsagSnapshot,
} from "./types";
export class PocsagReceiver implements StreamingDigitalDecoder<
  PocsagSnapshot,
  PocsagEvent
> {
  private channel = new DigitalChannelReducer();
  private configuration?: PocsagConfiguration;
  private modem?: PocsagDemodulator;
  private messages: PocsagMessage[] = [];
  private cached?: DigitalPublication<PocsagSnapshot>;
  private provenance?: DigitalProvenance;
  private sequence = 0;
  private messageSequence = 0;
  private lastPublished = -Infinity;
  private ended = false;
  private counters: PocsagSnapshot["counters"] = {
    complete: 0,
    partial: 0,
    correctedMessages: 0,
    correctedBits: 0,
    rejectedWords: 0,
    gaps: 0,
    evicted: 0,
  };
  configure(c: PocsagConfiguration): void {
    validatePocsagConfiguration(c);
    this.channel.configure(c);
    this.configuration = structuredClone(c);
    this.messages = [];
    this.ended = false;
    this.counters = {
      complete: 0,
      partial: 0,
      correctedMessages: 0,
      correctedBits: 0,
      rejectedWords: 0,
      gaps: 0,
      evicted: 0,
    };
    this.provenance = {
      generation: c.generation,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: 0,
      actualInputSampleRateHz: c.actualInputSampleRateHz,
      selectedChannelOffsetHz: c.selectedChannelOffsetHz,
    };
    this.modem = new PocsagDemodulator(
      c.outputSampleRateHz,
      c.pocsag,
      c.actualInputSampleRateHz,
      (m) => this.accept(m),
    );
    this.lastPublished = -Infinity;
    this.publish();
  }
  receive(block: DigitalInputBlock): void {
    const c = this.require();
    const reduced = this.channel.process(block);
    if (reduced.discontinuityBefore) {
      this.modem!.reset(
        reduced.discontinuityBefore.reason === "queue-overflow"
          ? "queue-overflow"
          : "source-gap",
      );
      this.counters.gaps++;
    }
    this.provenance = reduced.provenance;
    this.modem!.process(
      reduced.fmHz,
      reduced.firstOutputInputSampleIndex,
      reduced.inputSamplesPerOutput,
    );
    if (
      reduced.provenance.lastInputSampleIndex - this.lastPublished >=
      c.snapshotIntervalInputSamples
    )
      this.publish();
  }
  reset(
    d: DigitalDiscontinuity = { reason: "reset", missingInputSamples: null },
  ): void {
    this.require();
    this.modem!.reset(
      d.reason === "queue-overflow"
        ? "queue-overflow"
        : d.reason === "source-gap"
          ? "source-gap"
          : "reconfigure",
    );
    this.channel.reset();
    this.counters.gaps++;
    this.publish();
  }
  flush(): void {
    this.require();
    this.modem!.flush();
    this.ended = true;
    this.publish();
  }
  snapshot(): DigitalPublication<PocsagSnapshot> {
    this.require();
    return this.cached!;
  }
  drainEvents(): readonly DigitalPublication<PocsagEvent>[] {
    return [];
  }
  dispose(): void {
    this.channel.dispose();
    this.configuration = undefined;
    this.modem = undefined;
    this.messages = [];
    this.cached = undefined;
  }
  private accept(m: FramedMessage): void {
    const message = this.message(m);
    message.sequence = ++this.messageSequence;
    this.messages.push(message);
    if (this.messages.length > POCSAG_MAX_HISTORY) {
      this.messages.shift();
      this.counters.evicted++;
    }
    if (message.complete) this.counters.complete++;
    else this.counters.partial++;
    if (message.correctedBits) this.counters.correctedMessages++;
    this.counters.correctedBits += message.correctedBits;
  }
  private message(m: FramedMessage): PocsagMessage {
    const { firstSample, lastSample, words, ...body } = m;
    return {
      ...body,
      wordEvidence: {
        received: Uint32Array.from(words, (w) => w.received),
        correctionMasks: Uint32Array.from(words, (w) => w.correctionMask),
        flags: Uint8Array.from(
          words,
          (w) =>
            (w.corrected === null ? 128 : w.correctedBits) |
            (w.payload ? 4 : 0),
        ),
      },
      sequence: 0,
      provenance: {
        ...this.provenance!,
        firstInputSampleIndex: firstSample,
        lastInputSampleIndex: lastSample,
      },
    };
  }
  private publish(): void {
    const active = this.modem?.active;
    const current = active?.current;
    this.lastPublished = this.provenance!.lastInputSampleIndex;
    this.cached = {
      sequence: this.sequence++,
      provenance: this.provenance!,
      value: {
        configured: true,
        state: this.ended
          ? "ended"
          : current?.erasures.length
            ? "degraded"
            : current
              ? "receiving"
              : active
                ? "synchronized"
                : this.modem?.acquiring
                  ? "acquiring"
                  : "searching",
        detectedRate: active?.rate ?? null,
        polarity: active?.polarity ?? null,
        messages: this.messages.slice(-POCSAG_PUBLISHED_MESSAGES),
        ...(current ? { inProgress: this.message(current) } : {}),
        counters: {
          ...this.counters,
          rejectedWords: this.modem?.rejected ?? 0,
        },
      },
    };
    // A raw/long control-character message can be much larger than ordinary text.
    // Keep at most 16 recent messages and a conservative bounded wire envelope.
    while (
      this.cached.value.messages.length > 0 &&
      JSON.stringify(this.cached.value, (_key, value: unknown) =>
        value instanceof Uint32Array || value instanceof Uint8Array
          ? Array.from(value)
          : value,
      ).length *
        2 >
        120 * 1024
    )
      this.cached.value.messages.shift();
  }
  private require(): PocsagConfiguration {
    if (!this.configuration)
      throw new Error("POCSAG receiver is not configured.");
    return this.configuration;
  }
}
