import {
  DigitalChannelReducer,
  type DigitalDiscontinuity,
  type DigitalInputBlock,
  type DigitalProvenance,
  type DigitalPublication,
} from "../digital";
import {
  validateTextModemConfiguration,
  type TextModemConfiguration,
} from "./settings";
import {
  AcarsFramer,
  RttyFramer,
  SitorFramer,
  VaricodeFramer,
  type FramedOutput,
  type ModemCallbacks,
} from "./framing";
import {
  Bpsk31Demodulator,
  SynchronousBitClock,
  TwoToneDetector,
} from "./demodulators";
import { AcarsMskDemodulator } from "./msk";
import { ImageModem } from "./imageModem";
import { CwTextDemodulator } from "./cw";
import type { ImageScanEvent } from "./imageTypes";
import type { TextMessage, TextModemSnapshot } from "./types";

/** Bounded shared raw-I/Q text route. Modem state never spans a source gap.
 * Text without protocol checks remains explicitly unverified. */
export class TextModemCore {
  private channel = new DigitalChannelReducer();
  private configuration?: TextModemConfiguration;
  private modem?: TwoToneDetector | Bpsk31Demodulator | AcarsMskDemodulator | ImageModem | CwTextDemodulator;
  private imageSequence = 0;
  private imageEvents: DigitalPublication<ImageScanEvent>[] = [];
  private snapshotValue?: TextModemSnapshot;
  private provenance?: DigitalProvenance;
  private frameStart = 0;
  private sequence = 0;
  private messageSequence = 0;
  private expected?: number;
  private nextSnapshot = 0;
  private lastCharacter = -Infinity;
  private phase = 0;
  private dc = 0;
  private pending = "";
  private disposed = false;
  configure(value: TextModemConfiguration): void {
    if (this.disposed) throw new Error("Text modem is disposed.");
    validateTextModemConfiguration(value);
    this.channel.configure(value);
    this.configuration = structuredClone(value);
    this.snapshotValue = {
      mode: value.mode,
      settings: structuredClone(value.settings),
      text: "",
      messages: [],
      status: "searching",
      signalLevel: 0,
      confidence: 0,
      frequencyErrorHz: 0,
      markHz:
        value.mode === "RTTY"
          ? value.settings.tuningOffsetHz + value.settings.shiftHz / 2
          : value.mode === "NAVTEX"
            ? value.settings.tuningOffsetHz + 85
            : null,
      spaceHz:
        value.mode === "RTTY"
          ? value.settings.tuningOffsetHz - value.settings.shiftHz / 2
          : value.mode === "NAVTEX"
            ? value.settings.tuningOffsetHz - 85
            : null,
      counters: {
        characters: 0,
        accepted: 0,
        rejected: 0,
        framingErrors: 0,
        corrected: 0,
        discontinuities: 0,
      },
    };
    this.provenance = {
      generation: value.generation,
      actualInputSampleRateHz: value.actualInputSampleRateHz,
      selectedChannelOffsetHz: value.selectedChannelOffsetHz,
      firstInputSampleIndex: 0,
      lastInputSampleIndex: 0,
    };
    this.expected = undefined;
    this.nextSnapshot = 0;
    this.messageSequence = 0;
    this.pending = "";
    this.imageSequence = 0;
    this.imageEvents = [];
    this.frameStart = 0;
    this.createModem();
    this.sequence++;
  }
  private createModem(): void {
    const value = this.configuration!;
    this.phase = this.dc = 0;
    this.lastCharacter = -Infinity;
    const callbacks: ModemCallbacks = {
      character: (text) => this.character(text),
      message: (message) => this.message(message),
      error: () => {
        this.snapshotValue!.counters.framingErrors++;
        if (value.mode === "ACARS") this.snapshotValue!.counters.rejected++;
      },
      corrected: () => {
        this.snapshotValue!.counters.corrected++;
      },
    };
    if (value.mode === "WEFAX" || value.mode === "SSTV") {
      this.modem = new ImageModem(value.mode, value.outputSampleRateHz, value.settings.image, {
        start: (mode, width, height, channels) => {
          const image = { id: ++this.imageSequence, mode, width, height, channels, rows: 0, complete: false, reason: "Receiving · no image checksum", provenance: { ...this.provenance! } };
          this.snapshotValue!.image = image;
          this.imageEvent({ type: "start", image: structuredClone(image) });
        },
        row: (row, pixels) => {
          const image = this.snapshotValue!.image!;
          image.rows = row + 1; image.provenance.lastInputSampleIndex = this.provenance!.lastInputSampleIndex;
          this.lastCharacter = this.provenance!.lastInputSampleIndex;
          this.imageEvent({ type: "row", id: image.id, row, pixels });
        },
        end: (complete, reason) => {
          const image = this.snapshotValue!.image!;
          image.complete = complete; image.reason = reason;
          this.imageEvent({ type: "end", id: image.id, complete, reason });
          this.message({ text: `${image.mode} · ${image.width} × ${image.rows} received rows · ${reason}`, header: `${image.mode} image ${image.id}`, complete, integrity: "Image synchronization only · no checksum" });
        },
        error: callbacks.error,
      });
      this.snapshotValue!.decoderStage = this.modem.stage;
    } else if (value.mode === "CW-TEXT") {
      this.modem = new CwTextDemodulator(value.outputSampleRateHz, value.settings.cw, callbacks.character, callbacks.error);
    } else if (value.mode === "RTTY") {
      const framer = new RttyFramer(value.settings, callbacks);
      this.modem = new TwoToneDetector(
        value.outputSampleRateHz,
        value.settings.shiftHz,
        value.settings.baud,
        value.settings.inverted,
        (mark) => framer.push(mark),
      );
    } else if (value.mode === "NAVTEX") {
      const framer = new SitorFramer(callbacks);
      const clock = new SynchronousBitClock((bit) => framer.push(bit));
      this.modem = new TwoToneDetector(
        value.outputSampleRateHz,
        170,
        100,
        value.settings.inverted,
        (mark) => clock.push(mark),
      );
    } else if (value.mode === "PSK31") {
      const framer = new VaricodeFramer(callbacks);
      this.modem = new Bpsk31Demodulator(value.outputSampleRateHz, (bit) =>
        framer.push(bit),
      );
    } else {
      const framers = Array.from(
        { length: 10 },
        () => new AcarsFramer(callbacks),
      );
      this.modem = new AcarsMskDemodulator(
        value.outputSampleRateHz,
        (bit, phase) => {
          framers[phase * 2]!.push(bit);
          framers[phase * 2 + 1]!.push(1 - bit);
        },
      );
    }
  }
  receive(block: DigitalInputBlock): void {
    if (!this.configuration || this.disposed)
      throw new Error("Configure the text modem before receiving.");
    // Reducer validates the block before protocol state is changed.
    const narrow = this.channel.process(block);
    if (
      narrow.discontinuityBefore ||
      (this.expected !== undefined && block.firstSampleIndex !== this.expected)
    )
      this.resetPartial(block.firstSampleIndex);
    this.expected = block.firstSampleIndex + block.I.length;
    if (!this.provenance || this.provenance.lastInputSampleIndex === 0)
      this.frameStart = block.firstSampleIndex;
    const rate = this.configuration.outputSampleRateHz;
    const rotation =
      (2 * Math.PI * this.configuration.settings.tuningOffsetHz) / rate;
    for (let n = 0; n < narrow.I.length; n++) {
      const inputIndex =
        narrow.firstOutputInputSampleIndex + n * narrow.inputSamplesPerOutput;
      this.provenance = {
        ...narrow.provenance,
        firstInputSampleIndex: this.frameStart,
        lastInputSampleIndex: inputIndex,
      };
      if (this.modem instanceof ImageModem) {
        this.modem.push(narrow.fmHz[n]! - this.configuration.settings.tuningOffsetHz, narrow.envelope[n]!);
      } else if (this.modem instanceof AcarsMskDemodulator) {
        const amplitude = narrow.envelope[n]!;
        this.dc +=
          (1 - Math.exp((-2 * Math.PI * 20) / rate)) * (amplitude - this.dc);
        this.modem.push(amplitude - this.dc);
      } else {
        const i = narrow.I[n]!,
          q = narrow.Q[n]!;
        this.modem!.push(
          i * Math.cos(this.phase) + q * Math.sin(this.phase),
          q * Math.cos(this.phase) - i * Math.sin(this.phase),
        );
        this.phase = (this.phase + rotation) % (2 * Math.PI);
      }
    }
    const state = this.snapshotValue!;
    state.signalLevel = this.modem!.level;
    state.confidence =
      this.modem instanceof AcarsMskDemodulator ? 0 : this.modem!.confidence;
    state.frequencyErrorHz =
      this.modem instanceof Bpsk31Demodulator ? this.modem.frequencyErrorHz : 0;
    if (this.modem instanceof ImageModem) state.decoderStage = this.modem.stage;
    if (this.modem instanceof CwTextDemodulator) state.cwWpm = this.modem.estimatedWpm;
    state.status =
      state.signalLevel < 0.001
        ? "searching"
        : block.firstSampleIndex - this.lastCharacter <
            this.configuration.actualInputSampleRateHz * 2
          ? "decoding"
          : "signal";
    if (block.firstSampleIndex >= this.nextSnapshot) {
      this.sequence++;
      this.nextSnapshot =
        block.firstSampleIndex +
        this.configuration.actualInputSampleRateHz / 10;
    }
  }
  private character(text: string): void {
    if (!text) return;
    const state = this.snapshotValue!;
    state.text = (state.text + text).slice(-8192);
    state.counters.characters += text.length;
    this.lastCharacter = this.provenance!.lastInputSampleIndex;
    if (["RTTY", "PSK31", "CW-TEXT"].includes(this.configuration!.mode)) {
      this.pending += text;
      if (text.includes("\n") || this.pending.length >= 128) this.flushText();
    }
  }
  private flushText(): void {
    if (!this.pending) return;
    this.message({
      text: this.pending,
      complete: false,
      integrity:
        this.configuration!.mode === "RTTY"
          ? "ITA2 framing checked · no checksum"
          : this.configuration!.mode === "CW-TEXT" ? "Tentative Morse transcription · no checksum" : "BPSK31 Varicode · no checksum",
    });
    this.pending = "";
  }
  private message(value: FramedOutput): void {
    const state = this.snapshotValue!;
    const prior = state.messages.at(-1);
    if (
      state.mode === "ACARS" &&
      prior?.text === value.text &&
      prior.address === value.address &&
      prior.header === value.header &&
      this.provenance!.lastInputSampleIndex -
        prior.provenance.lastInputSampleIndex <
        this.configuration!.actualInputSampleRateHz / 100
    )
      return;
    const message: TextMessage = {
      ...value,
      text: value.text.slice(0, 4096),
      sequence: ++this.messageSequence,
      provenance: {
        ...this.provenance!,
        firstInputSampleIndex: this.frameStart,
      },
    };
    state.messages = [...state.messages.slice(-15), message];
    state.counters.accepted++;
    if (state.mode === "ACARS") {
      state.text = (state.text + message.text + "\n").slice(-8192);
      state.counters.characters += message.text.length;
    }
    this.lastCharacter = this.provenance!.lastInputSampleIndex;
    this.frameStart = this.provenance!.lastInputSampleIndex + 1;
    this.sequence++;
  }
  private resetPartial(nextInputSampleIndex = this.expected ?? 0): void {
    if (this.modem instanceof ImageModem) this.modem.flush("Input discontinuity · partial image");
    this.flushText();
    this.pending = "";
    this.createModem();
    this.frameStart = nextInputSampleIndex;
    this.snapshotValue!.counters.discontinuities++;
    this.snapshotValue!.status = "searching";
    this.sequence++;
  }
  reset(_discontinuity?: DigitalDiscontinuity): void {
    if (!this.configuration || this.disposed) return;
    this.channel.reset();
    this.resetPartial();
    this.expected = undefined;
  }
  flush(): void {
    if (this.modem instanceof ImageModem || this.modem instanceof CwTextDemodulator) this.modem.flush();
    if (this.modem instanceof ImageModem) this.snapshotValue!.decoderStage = this.modem.stage;
    this.flushText();
    this.sequence++;
  }
  snapshot(): DigitalPublication<TextModemSnapshot> {
    if (!this.snapshotValue || !this.provenance)
      throw new Error("Text modem is not configured.");
    return {
      sequence: this.sequence,
      provenance: { ...this.provenance },
      value: structuredClone(this.snapshotValue),
    };
  }
  private imageEvent(value: ImageScanEvent): void {
    if (this.imageEvents.length >= 256) throw new Error("Image row event capacity exceeded; drain between bounded input blocks.");
    this.imageEvents.push({ sequence: ++this.sequence, provenance: { ...this.provenance! }, value });
  }
  drainEvents(): readonly DigitalPublication<ImageScanEvent>[] {
    const events = this.imageEvents; this.imageEvents = []; return events;
  }
  dispose(): void {
    this.disposed = true;
    this.channel.dispose();
    this.modem = undefined;
    this.snapshotValue = undefined;
    this.imageEvents = [];
  }
}
