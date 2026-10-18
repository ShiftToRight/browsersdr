import { IngressTimings, type IngressDiagnostics } from "./ingressTimings";

/** Delivered RF input accounting, not an estimate of exact hardware loss.
 * Reset for each RX/rate segment. Polling cannot grow storage or alter totals. */
export class RtlIngress {
  private readonly timings = new IngressTimings(["RTL read wait", "RTL delivery"]);
  private startedAt = 0;
  private stoppedAt?: number;
  private rate = 0;
  private samples = 0;
  private blocks = 0;
  private lastBlockSamples = 0;
  constructor(private readonly now = () => performance.now()) {}
  begin(rate: number): void {
    this.rate = rate;
    this.startedAt = this.now();
    this.stoppedAt = undefined;
    this.samples = this.blocks = this.lastBlockSamples = 0;
    this.timings.reset();
  }
  end(): void { this.stoppedAt ??= this.now(); }
  accept(samples: number, readWaitMs: number): void {
    this.samples += samples;
    this.blocks++;
    this.lastBlockSamples = samples;
    this.timings.record("RTL read wait", readWaitMs);
  }
  delivered(elapsedMs: number): void { this.timings.record("RTL delivery", elapsedMs); }
  snapshot(): IngressDiagnostics {
    const elapsedSeconds = this.rate ? Math.max(0, (this.stoppedAt ?? this.now()) - this.startedAt) / 1000 : 0;
    return {
      stages: this.timings.snapshot(), debtMs: 0, budgetMs: 0,
      rtl: {
        sampleRateHz: this.rate, deliveredSamples: this.samples, deliveredBytes: this.samples * 2,
        deliveredBlocks: this.blocks, lastBlockSamples: this.lastBlockSamples,
        sampleSeconds: this.rate ? this.samples / this.rate : 0,
        elapsedSeconds, averageBytesPerSecond: elapsedSeconds ? this.samples * 2 / elapsedSeconds : 0,
      },
    };
  }
}
