export interface UsrpB205WorkerSampleBatch {
  readonly generation: number;
  readonly frequency: number;
  readonly packets: ArrayBuffer[];
  readonly gapsBefore?: readonly { missingSamples: number | null; reason: string }[];
}

export interface UsrpB205WorkerQueueDrop {
  readonly blocks: number;
  readonly samples: number;
}

function packetSamples(packet: ArrayBuffer): number {
  if (packet.byteLength < 16 || (packet.byteLength - 16) % 4 !== 0)
    throw new Error("USRP B205-mini worker queue received a malformed native packet.");
  return (packet.byteLength - 16) / 4;
}

/** Bounded latency queue between the USB worker and main thread. On pressure,
 * stale work is discarded as one measurable gap so reception can catch up. */
export class UsrpB205WorkerSampleQueue {
  private readonly blocks: UsrpB205WorkerSampleBatch[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("USRP B205-mini worker queue capacity must be positive.");
  }

  get length(): number { return this.blocks.length; }

  clear(): void { this.blocks.splice(0); }

  shift(): UsrpB205WorkerSampleBatch | undefined { return this.blocks.shift(); }

  pushLatest(batch: UsrpB205WorkerSampleBatch): UsrpB205WorkerQueueDrop | null {
    let dropped: UsrpB205WorkerSampleBatch[] = [];
    if (this.blocks.length >= this.capacity) dropped = this.blocks.splice(0);
    if (dropped.length === 0) { this.blocks.push(batch); return null; }
    const result = {
      blocks: dropped.length,
      samples: dropped.reduce(
        (total, block) => total + block.packets.reduce(
          (blockTotal, packet) => blockTotal + packetSamples(packet),
          0,
        ),
        0,
      ),
    };
    const inherited = dropped.flatMap((block) => block.gapsBefore ?? []);
    const knownMissing = inherited.reduce((sum, gap) => sum + (gap.missingSamples ?? 0), 0);
    const unknown = inherited.some((gap) => gap.missingSamples === null);
    this.blocks.push({
      ...batch,
      gapsBefore: [
        {
          missingSamples: unknown ? null : result.samples + knownMissing,
          reason: `Main thread stalled; discarded ${result.blocks} stale USRP SC16 batches to catch up${inherited.length ? "; includes an earlier receive discontinuity" : ""}`,
        },
        ...(batch.gapsBefore ?? []),
      ],
    });
    return result;
  }
}
