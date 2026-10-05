import { RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";
import { decodeCu8Into } from "./cu8";
import { CaptureRdsEvidence } from "./receptionEvidence";
import type { RdsSnapshot } from "./types";

/** Independent decoder consumes only bytes actually accepted by this capture.
 * Live receiver queues, earlier PS segments and capacity overflow cannot enter it. */
export class SavedCaptureRds {
  private readonly evidence = new CaptureRdsEvidence();
  private sampleCount = 0;
  private I = new Float32Array(0);
  private Q = new Float32Array(0);
  private readonly receiver: Pick<RdsMultiplexReceiver, "receiveOwnedSamples">;
  constructor(
    private readonly centerHz: number,
    rateHz: number,
    channelHz: number,
    factory = (update: (value: RdsSnapshot) => void) =>
      new RdsMultiplexReceiver(update),
  ) {
    const receiver = factory((state) =>
      this.evidence.observe(state, this.sampleCount),
    );
    receiver.setSampleRate(rateHz);
    receiver.setFrequencyOffset(channelHz - centerHz);
    this.receiver = receiver;
  }
  accept(bytes: Uint8Array): void {
    // Bound DSP allocations and calls even if a backend returns an unusually large USB block.
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const part = bytes.subarray(
        offset,
        Math.min(bytes.length, offset + 32768),
      );
      const count = part.length / 2;
      if (this.I.length !== count) {
        this.I = new Float32Array(count);
        this.Q = new Float32Array(count);
      }
      decodeCu8Into(part, this.I, this.Q);
      this.sampleCount += count;
      this.receiver.receiveOwnedSamples({
        I: this.I,
        Q: this.Q,
        frequency: this.centerHz,
      });
    }
  }
  finish(savedSamples: number) {
    return this.evidence.finish(savedSamples);
  }
}
