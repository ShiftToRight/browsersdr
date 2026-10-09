import { boundedAprsSnapshot } from "../radio/packetSnapshots";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { DigitalSampleReceiver } from "../rds/rdsMultiplexReceiver";
import {
  BoundedDigitalWorkerAdapter,
  type DigitalDiscontinuity,
  type DigitalWorkerAdapterDiagnostics,
  type DigitalWorkerPort,
} from "../digital";
import { AprsReceiver } from "./aprsReceiver";
import { validateAprsConfiguration, type AprsConfiguration } from "./settings";
import type { AprsEvent, AprsSnapshot } from "./types";

export interface AprsDigitalUpdate {
  snapshot: AprsSnapshot;
  diagnostics: DigitalWorkerAdapterDiagnostics;
}

type WorkerFactory = () => DigitalWorkerPort<AprsSnapshot, AprsEvent>;

/** Bridges the established SampleReceiver fan-out to the bounded foundation
 * contract. Browser input is copied into explicitly owned transferable buffers;
 * non-browser tests use the same core synchronously. */
export class AprsDigitalReceiver implements DigitalSampleReceiver {
  private adapter?: BoundedDigitalWorkerAdapter<
    AprsConfiguration,
    AprsSnapshot,
    AprsEvent
  >;
  private inline?: AprsReceiver;
  private configuration?: AprsConfiguration;
  private firstSampleIndex = 0;
  private disposed = false;
  private latest?: AprsSnapshot;

  constructor(
    private readonly onUpdate: (update: AprsDigitalUpdate) => void,
    private readonly onError: (error: Error) => void,
    private readonly workerFactory:
      WorkerFactory | undefined = typeof Worker === "undefined"
      ? undefined
      : () =>
          new Worker(new URL("../workers/aprs.worker.ts", import.meta.url), {
            type: "module",
          }) as DigitalWorkerPort<AprsSnapshot, AprsEvent>,
  ) {}

  configureSession(configuration: AprsConfiguration): void {
    if (this.disposed) throw new Error("APRS receiver is disposed.");
    validateAprsConfiguration(configuration);
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
      this.inline ??= new AprsReceiver();
      this.inline.configure(configuration);
      this.latest = boundedAprsSnapshot(this.inline.snapshot().value);
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
        "Prepare APRS settings before attaching its sample route.",
      );
    if (
      configured.actualInputSampleRateHz !== sampleRateHz ||
      configured.selectedChannelOffsetHz !== frequencyOffsetHz
    )
      throw new Error(
        "APRS route rate or channel offset changed before attachment.",
      );
  }

  setSampleRate(_sampleRateHz: number): void {}

  receiveSamples(block: SampleBlock): void {
    const configuration = this.configuration;
    if (!configuration || this.disposed) return;
    const I = new Float32Array(block.I);
    const Q = new Float32Array(block.Q);
    const input = {
      I,
      Q,
      generation: configuration.generation,
      firstSampleIndex: this.firstSampleIndex,
    };
    this.firstSampleIndex += I.length;
    if (this.adapter) this.adapter.submitOwned(input);
    else if (this.inline) {
      this.inline.receive(input);
      this.latest = boundedAprsSnapshot(this.inline.snapshot().value);
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
      this.latest = boundedAprsSnapshot(this.inline.snapshot().value);
      this.publish();
    }
  }

  async flush(): Promise<void> {
    if (this.adapter) await this.adapter.flush();
    else if (this.inline) {
      this.inline.flush();
      this.latest = boundedAprsSnapshot(this.inline.snapshot().value);
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
