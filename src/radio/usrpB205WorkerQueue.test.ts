import { describe, expect, it } from "vitest";
import { UsrpB205WorkerSampleQueue } from "./usrpB205WorkerQueue";

const packet = (samples: number) => new ArrayBuffer(16 + samples * 4);
const batch = (generation: number, ...samples: number[]) => ({
  generation,
  frequency: 100_000_000,
  packets: samples.map(packet),
});

describe("USRP B205-mini worker-to-main sample queue", () => {
  it("keeps its bound and replaces stale backlog with the latest batch", () => {
    const queue = new UsrpB205WorkerSampleQueue(2);
    expect(queue.pushLatest(batch(4, 10, 20))).toBeNull();
    expect(queue.pushLatest(batch(4, 30))).toBeNull();

    expect(queue.pushLatest(batch(4, 40))).toEqual({ blocks: 2, samples: 60 });
    expect(queue.length).toBe(1);
    expect(queue.shift()).toEqual(batch(4, 40));
  });

  it("clears generation state and rejects malformed packet accounting", () => {
    const queue = new UsrpB205WorkerSampleQueue(1);
    queue.pushLatest(batch(1, 1));
    queue.clear();
    expect(queue.length).toBe(0);
    queue.pushLatest({ generation: 2, frequency: 1, packets: [new ArrayBuffer(17)] });
    expect(() => queue.pushLatest(batch(2, 1))).toThrow("malformed native packet");
  });
});
