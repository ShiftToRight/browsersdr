import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";
import {
  BoundedDigitalWorkerAdapter,
  type DigitalDiscontinuity,
  type DigitalWorkerAdapterDiagnostics,
  type DigitalWorkerPort,
} from "../digital";
import type { TextModemCore } from "./receiver";
import {
  validateTextModemConfiguration,
  type TextModemConfiguration,
} from "./settings";
import type { TextModemSnapshot } from "./types";
import type { ImageScanEvent, ReceivedImage } from "./imageTypes";

export interface TextDigitalUpdate {
  snapshot: TextModemSnapshot;
  diagnostics: DigitalWorkerAdapterDiagnostics;
  image?: ReceivedImage;
}

type WorkerFactory = () => DigitalWorkerPort<TextModemSnapshot, ImageScanEvent>;

/** Bridges the established SampleReceiver fan-out to the bounded foundation
 * contract. Browser input is copied into explicitly owned transferable buffers;
 * non-browser tests use the same core synchronously. */
export class TextDigitalReceiver implements DigitalSampleReceiver {
  private adapter?: BoundedDigitalWorkerAdapter<
    TextModemConfiguration,
    TextModemSnapshot,
    ImageScanEvent
  >;
  private inline?: TextModemCore;
  private inlineTask?: Promise<void>;
  private configuration?: TextModemConfiguration;
  private firstSampleIndex = 0;
  private disposed = false;
  private latest?: TextModemSnapshot;
  private image?: ReceivedImage;

  constructor(
    private readonly onUpdate: (update: TextDigitalUpdate) => void,
    private readonly onError: (error: Error) => void,
    private readonly workerFactory:
      WorkerFactory | undefined = typeof Worker === "undefined"
      ? undefined
      : () =>
          new Worker(
            new URL("../workers/textModem.worker.ts", import.meta.url),
            {
              type: "module",
            },
          ) as DigitalWorkerPort<TextModemSnapshot, ImageScanEvent>,
  ) {}

  configureSession(configuration: TextModemConfiguration): void {
    if (this.disposed) throw new Error("Text modem receiver is disposed.");
    validateTextModemConfiguration(configuration);
    if (JSON.stringify(this.configuration) === JSON.stringify(configuration))
      return;
    this.latest = undefined;
    this.image = undefined;
    this.configuration = structuredClone(configuration);
    this.firstSampleIndex = 0;
    if (this.workerFactory) {
      this.adapter ??= new BoundedDigitalWorkerAdapter(this.workerFactory(), {
        snapshot: (publication) => {
          this.latest = publication.value;
          this.publish();
        },
        dropped: () => this.publish(),
        event: publication => this.imageEvent(publication.value),
        error: this.onError,
      });
      this.adapter.configure(configuration);
    } else {
      if (this.inline) {
        this.inline.configure(configuration);
        this.latest = this.inline.snapshot().value;
        this.publish();
      } else {
        this.inlineTask ??= import("./receiver").then(({ TextModemCore }) => {
          if (this.disposed || !this.configuration) return;
          this.inline = new TextModemCore();
          this.inline.configure(this.configuration);
          this.latest = this.inline.snapshot().value;
          this.publish();
        });
      }
    }
  }

  async prepare(): Promise<void> {
    if (this.adapter) await this.adapter.whenReady();
    else await this.inlineTask;
  }

  configure(sampleRateHz: number, frequencyOffsetHz: number): void {
    const configured = this.configuration;
    if (!configured)
      throw new Error(
        "Prepare Text modem settings before attaching its sample route.",
      );
    if (
      configured.actualInputSampleRateHz !== sampleRateHz ||
      configured.selectedChannelOffsetHz !== frequencyOffsetHz
    )
      throw new Error(
        "Text modem route rate or channel offset changed before attachment.",
      );
  }

  setSampleRate(_sampleRateHz: number): void {}

  receiveSamples(block: SampleBlock): void {
    const configuration = this.configuration;
    if (!configuration || this.disposed) return;
    const { I, Q } = block;
    const input = {
      I,
      Q,
      generation: configuration.generation,
      firstSampleIndex: this.firstSampleIndex,
    };
    this.firstSampleIndex += I.length;
    if (this.adapter) this.adapter.submitBorrowed(input);
    else if (this.inline) {
      this.inline.receive(input);
      for (const event of this.inline.drainEvents()) this.imageEvent(event.value);
      this.latest = this.inline.snapshot().value;
      this.publish();
    }
  }

  reset(
    discontinuity: DigitalDiscontinuity = {
      reason: "reset",
      missingInputSamples: null,
    },
  ): void {
    if (!this.configuration || this.disposed) return;
    if (discontinuity.missingInputSamples !== null)
      this.firstSampleIndex += discontinuity.missingInputSamples;
    this.adapter?.reset(discontinuity);
    if (this.inline) {
      this.inline.reset(discontinuity);
      for (const event of this.inline.drainEvents()) this.imageEvent(event.value);
      this.latest = this.inline.snapshot().value;
      this.publish();
    }
  }

  async flush(): Promise<void> {
    if (this.adapter) await this.adapter.flush();
    else if (this.inline) {
      this.inline.flush();
      for (const event of this.inline.drainEvents()) this.imageEvent(event.value);
      this.latest = this.inline.snapshot().value;
      this.publish();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.adapter?.dispose();
    this.inline?.dispose();
    this.configuration = undefined;
    this.image = undefined;
  }

  get diagnostics(): DigitalWorkerAdapterDiagnostics {
    return (
      this.adapter?.diagnostics ?? {
        generation: this.configuration?.generation ?? -1,
        queuedBlocks: 0,
        queueCapacityBlocks: 0,
        peakQueuedBlocks: 0,
        droppedInputBlocks: 0,
        droppedInputSamples: 0,
        staleResults: 0,
      }
    );
  }

  private publish(): void {
    if (this.image && this.latest?.image?.id === this.image.id) Object.assign(this.image, this.latest.image);
    if (this.latest)
      this.onUpdate({ snapshot: this.latest, diagnostics: this.diagnostics, image: this.image });
  }
  private imageEvent(event: ImageScanEvent): void {
    if (event.type === "start") {
      const { width, height, channels } = event.image;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 1809 || height < 1 || height > 2048 || ![1, 3].includes(channels) || width * height * channels > 4 * 1024 * 1024) { this.onError(new Error("Image raster exceeds bounded dimensions.")); return; }
      this.image = { ...structuredClone(event.image), pixels: new Uint8Array(width * height * channels).fill(127) };
    } else if (this.image?.id === event.id) {
      if (event.type === "row") {
        if (!Number.isInteger(event.row) || event.row < 0 || event.row >= this.image.height || event.pixels.length !== this.image.width * this.image.channels) { this.onError(new Error("Invalid image scan row.")); return; }
        this.image.pixels.set(event.pixels, event.row * event.pixels.length);
        this.image.rows = Math.max(this.image.rows, event.row + 1);
      } else { this.image.complete = event.complete; this.image.reason = event.reason; }
    }
  }
}
