import { boundedRs41Snapshot } from "../radio/packetSnapshots";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";
import {
  BoundedDigitalWorkerAdapter,
  type DigitalDiscontinuity,
  type DigitalWorkerAdapterDiagnostics,
  type DigitalWorkerPort,
} from "../digital";
import { Rs41Receiver } from "./rs41Receiver";
import { validateRs41Configuration, type Rs41Configuration } from "./settings";
import type { Rs41Event, Rs41Snapshot } from "./types";

export interface Rs41DigitalUpdate {
  snapshot: Rs41Snapshot;
  diagnostics: DigitalWorkerAdapterDiagnostics;
}

type WorkerFactory = () => DigitalWorkerPort<Rs41Snapshot, Rs41Event>;

/** Bridges the established SampleReceiver fan-out to the bounded foundation
 * contract. Browser input is copied into explicitly owned transferable buffers;
 * non-browser tests use the same core synchronously. */
export class Rs41DigitalReceiver implements DigitalSampleReceiver {
  private adapter?: BoundedDigitalWorkerAdapter<
    Rs41Configuration,
    Rs41Snapshot,
    Rs41Event
  >;
  private inline?: Rs41Receiver;
  private configuration?: Rs41Configuration;
  private firstSampleIndex = 0;
  private disposed = false;
  private latest?: Rs41Snapshot;

  constructor(
    private readonly onUpdate: (update: Rs41DigitalUpdate) => void,
    private readonly onError: (error: Error) => void,
    private readonly workerFactory:
      WorkerFactory | undefined = typeof Worker === "undefined"
      ? undefined
      : () =>
          new Worker(new URL("../workers/rs41.worker.ts", import.meta.url), {
            type: "module",
          }) as DigitalWorkerPort<Rs41Snapshot, Rs41Event>,
  ) {}

  configureSession(configuration: Rs41Configuration): void {
    if (this.disposed) throw new Error("RS41 receiver is disposed.");
    validateRs41Configuration(configuration);
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
      this.inline ??= new Rs41Receiver();
      this.inline.configure(configuration);
      this.latest = boundedRs41Snapshot(this.inline.snapshot().value);
      this.publish();
    }
  }

  async prepare(): Promise<void> {
    if (this.adapter) await this.adapter.whenReady();
  }

  configure(sampleRateHz: number, frequencyOffsetHz: number): void {
    const configured = this.configuration;
    if (!configured)
      throw new Error(
        "Prepare RS41 settings before attaching its sample route.",
      );
    if (
      configured.actualInputSampleRateHz !== sampleRateHz ||
      configured.selectedChannelOffsetHz !== frequencyOffsetHz
    )
      throw new Error(
        "RS41 route rate or channel offset changed before attachment.",
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
      this.latest = boundedRs41Snapshot(this.inline.snapshot().value);
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
      this.latest = boundedRs41Snapshot(this.inline.snapshot().value);
      this.publish();
    }
  }

  async flush(): Promise<void> {
    if (this.adapter) await this.adapter.flush();
    else if (this.inline) {
      this.inline.flush();
      this.latest = boundedRs41Snapshot(this.inline.snapshot().value);
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
