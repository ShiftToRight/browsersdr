export interface UsrpB205WorkerSampleBatch {
  readonly generation: number;
  readonly frequency: number;
  readonly packets: ArrayBuffer[];
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
    this.blocks.push(batch);
    if (dropped.length === 0) return null;
    return {
      blocks: dropped.length,
      samples: dropped.reduce(
        (total, block) => total + block.packets.reduce(
          (blockTotal, packet) => blockTotal + packetSamples(packet),
          0,
        ),
        0,
      ),
    };
  }
}
