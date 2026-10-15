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

export interface TextDigitalUpdate {
  snapshot: TextModemSnapshot;
  diagnostics: DigitalWorkerAdapterDiagnostics;
}

type WorkerFactory = () => DigitalWorkerPort<TextModemSnapshot, never>;

/** Bridges the established SampleReceiver fan-out to the bounded foundation
 * contract. Browser input is copied into explicitly owned transferable buffers;
 * non-browser tests use the same core synchronously. */
export class TextDigitalReceiver implements DigitalSampleReceiver {
  private adapter?: BoundedDigitalWorkerAdapter<
    TextModemConfiguration,
    TextModemSnapshot,
    never
  >;
  private inline?: TextModemCore;
  private inlineTask?: Promise<void>;
  private configuration?: TextModemConfiguration;
  private firstSampleIndex = 0;
  private disposed = false;
  private latest?: TextModemSnapshot;

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
          ) as DigitalWorkerPort<TextModemSnapshot, never>,
  ) {}

  configureSession(configuration: TextModemConfiguration): void {
    if (this.disposed) throw new Error("Text modem receiver is disposed.");
    validateTextModemConfiguration(configuration);
    if (JSON.stringify(this.configuration) === JSON.stringify(configuration))
      return;
    this.latest = undefined;
    this.configuration = structuredClone(configuration);
    this.firstSampleIndex = 0;
    if (this.workerFactory) {
      this.adapter ??= new BoundedDigitalWorkerAdapter(this.workerFactory(), {
        snapshot: (publication) => {
          this.latest = publication.value;
          this.publish();
        },
        dropped: () => this.publish(),
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
      this.latest = this.inline.snapshot().value;
      this.publish();
    }
  }

  async flush(): Promise<void> {
    if (this.adapter) await this.adapter.flush();
    else if (this.inline) {
      this.inline.flush();
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
    if (this.latest)
      this.onUpdate({ snapshot: this.latest, diagnostics: this.diagnostics });
  }
}
