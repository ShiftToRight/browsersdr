import { describe, expect, it, vi } from "vitest";
import {
  FakeUsrpB205RxCommands,
  FakeUsrpB205RxIo,
  encodeUsrpB205RxData,
  encodeUsrpB205RxInline,
} from "../testing/usrpB205RxFixture";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import {
  USRP_B205_RX_QUEUE_BYTES,
  USRP_B205_HIGH_RATE_RX_READ_SLOTS,
  USRP_B205_RX_READ_SLOTS,
  USRP_B205_RX_TRANSFER_BYTES,
  UsrpB205RxTransport,
  type UsrpB205NativeBlock,
} from "./usrpB205RxTransport";

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const samples = (count: number, i = 1, q = -1): Array<readonly [number, number]> =>
  Array.from({ length: count }, () => [i, q] as const);

function fixture(overrides: { stopTimeoutMs?: number; watchdogMs?: number; closeOwner?: () => Promise<void>; now?: () => number; sampleRateHz?: 4_800_000 | 9_600_000 | 19_200_000 } = {}) {
  const io = new FakeUsrpB205RxIo();
  const commands = new FakeUsrpB205RxCommands();
  const closeOwner = vi.fn(overrides.closeOwner ?? (async () => undefined));
  const errors: unknown[] = [];
  const gaps: unknown[] = [];
  const generations: Array<[number, string]> = [];
  const transport = new UsrpB205RxTransport(io, commands, usrpB205SessionDetails(100_000_000, overrides.sampleRateHz), {
    error: (error) => errors.push(error), discontinuity: (gap) => gaps.push(gap),
    generationChanged: (generation, reason) => generations.push([generation, reason]),
  }, { closeOwner, stopTimeoutMs: overrides.stopTimeoutMs, watchdogMs: overrides.watchdogMs, now: overrides.now });
  return { io, commands, closeOwner, errors, gaps, generations, transport };
}

async function stopSettled(value: ReturnType<typeof fixture>): Promise<void> {
  const stopping = value.transport.stop();
  value.io.settlePending();
  await stopping;
}

describe("USRP B205-mini RX bulk transport", () => {
  it("submits the bounded endpoint-6 browser read window before RX start and never emits data OUT", async () => {
    const value = fixture();
    value.commands.startHook = () => {
      expect(value.io.reads).toHaveLength(USRP_B205_RX_READ_SLOTS);
      expect(value.io.reads.every((read) => read.requestedLength === USRP_B205_RX_TRANSFER_BYTES)).toBe(true);
    };
    const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(4, (block) => blocks.push(block));
    value.io.resolve(0, encodeUsrpB205RxData(9, 1_000n, [[100, -200]]), "ok", 7);
    await tick();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ generation: 4, sequence: 9, timestampTicks: 1_000n,
      complexSampleCount: 1, firstSampleIndex: 0 });
    expect(blocks[0]!.bytes.buffer).toBe(blocks[0]!.nativePacketBytes.buffer);
    expect(value.transport.diagnostics).toMatchObject({ state: "running", pendingReadsHighWater: USRP_B205_RX_READ_SLOTS,
      rawTransferBudgetBytes: USRP_B205_RX_READ_SLOTS * USRP_B205_RX_TRANSFER_BYTES,
      packetQueueBudgetBytes: USRP_B205_RX_QUEUE_BYTES });
    expect(value.io.controlOutCount).toBe(0);
    await stopSettled(value);
  });

  it("doubles the bounded read window and validates four timestamp ticks per sample at 9.6 MS/s", async () => {
    const value = fixture({ sampleRateHz: 9_600_000 });
    const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(1, (block) => blocks.push(block));
    expect(value.io.reads).toHaveLength(USRP_B205_HIGH_RATE_RX_READ_SLOTS);
    expect(value.transport.diagnostics).toMatchObject({
      pendingReadsHighWater: USRP_B205_HIGH_RATE_RX_READ_SLOTS,
      rawTransferBudgetBytes: USRP_B205_HIGH_RATE_RX_READ_SLOTS * USRP_B205_RX_TRANSFER_BYTES,
      steadyStateBudgetBytes: 64 * 1024 * 1024,
    });
    value.io.resolve(0, encodeUsrpB205RxData(0, 100n, samples(4086)));
    value.io.resolve(1, encodeUsrpB205RxData(1, 100n + 4086n * 4n, samples(4086)));
    await tick();
    expect(blocks.map((block) => block.nativeSampleRateHz)).toEqual([9_600_000, 9_600_000]);
    expect(value.transport.diagnostics.timestampRateValidation).toBe("observed");
    await stopSettled(value);
  });

  it("uses the bounded high-rate window and validates two timestamp ticks per sample at 19.2 MS/s", async () => {
    const value = fixture({ sampleRateHz: 19_200_000 });
    const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(1, (block) => blocks.push(block));
    expect(value.io.reads).toHaveLength(USRP_B205_HIGH_RATE_RX_READ_SLOTS);
    expect(value.transport.diagnostics).toMatchObject({
      pendingReadsHighWater: USRP_B205_HIGH_RATE_RX_READ_SLOTS,
      rawTransferBudgetBytes:
        USRP_B205_HIGH_RATE_RX_READ_SLOTS * USRP_B205_RX_TRANSFER_BYTES,
    });
    value.io.resolve(0, encodeUsrpB205RxData(0, 100n, samples(4086)));
    value.io.resolve(1, encodeUsrpB205RxData(1, 100n + 4086n * 2n, samples(4086)));
    await tick();
    expect(blocks.map((block) => block.nativeSampleRateHz)).toEqual([19_200_000, 19_200_000]);
    expect(value.transport.diagnostics.timestampRateValidation).toBe("observed");
    await stopSettled(value);
  });

  it("processes reordered Promise completions in submission order", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(1, (block) => blocks.push(block));
    value.io.resolve(1, encodeUsrpB205RxData(11, 8n, [[2, 2]])); await tick();
    expect(blocks).toEqual([]);
    value.io.resolve(0, encodeUsrpB205RxData(10, 0n, [[1, 1]])); await tick();
    expect(blocks.map((block) => block.sequence)).toEqual([10, 11]);
    expect(value.transport.diagnostics.completedReadBacklog).toBe(0);
    await stopSettled(value);
  });

  it("drops stopped-generation endpoint bytes that arrive before start acknowledgement", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    let releaseStart!: () => void;
    value.commands.startHook = () => new Promise<void>((resolve) => { releaseStart = resolve; });
    const starting = value.transport.start(1, (block) => blocks.push(block));
    value.io.resolve(0, encodeUsrpB205RxInline(0, 0n, 0x8));
    value.io.resolve(1, encodeUsrpB205RxData(1, 0n, [[1, 2]]));
    await tick();
    releaseStart();
    await starting;
    await tick();
    expect(blocks).toEqual([]);
    expect(value.transport.diagnostics.overflowRestarts).toBe(0);
    value.io.resolve(2, encodeUsrpB205RxData(2, 8n, [[3, 4]]));
    await tick();
    expect(blocks.map((block) => block.sequence)).toEqual([2]);
    await stopSettled(value);
  });

  it("joins only in-generation fragments and splits coalesced packets", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(1, (block) => blocks.push(block));
    const one = encodeUsrpB205RxData(3, 100n, [[1, 2], [3, 4]]);
    value.io.resolve(0, one.slice(0, 9));
    value.io.resolve(1, one.slice(9));
    const two = encodeUsrpB205RxData(4, 116n, [[5, 6]]);
    const three = encodeUsrpB205RxData(5, 124n, [[7, 8]]);
    const joined = new Uint8Array(two.byteLength + three.byteLength); joined.set(two); joined.set(three, two.byteLength);
    value.io.resolve(2, joined);
    await tick();
    expect(blocks.map((block) => [block.sequence, block.complexSampleCount])).toEqual([[3, 2], [4, 1], [5, 1]]);
    await stopSettled(value);
  });

  it("handles sequence wrap and uses timestamps to prove known versus unknown loss", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(8, (block) => blocks.push(block));
    value.io.resolve(0, encodeUsrpB205RxData(0xfff, 100n, samples(4086)));
    value.io.resolve(1, encodeUsrpB205RxData(0, 32_788n, samples(4086)));
    value.io.resolve(2, encodeUsrpB205RxData(2, 98_164n, samples(4086)));
    value.io.resolve(3, encodeUsrpB205RxData(2, 98_020n, samples(1)));
    await tick();
    expect(blocks.map((block) => block.sequence)).toEqual([0xfff, 0, 2, 2]);
    expect(blocks[2]!.discontinuityBefore).toMatchObject({ missingSamples: 4086, expectedSequence: 1, actualSequence: 2 });
    expect(blocks[2]!.firstSampleIndex).toBe(12_258);
    expect(blocks[3]!.discontinuityBefore).toMatchObject({ missingSamples: null, expectedSequence: 3, actualSequence: 2 });
    expect(value.transport.diagnostics.timestampRateValidation).toBe("observed");
    expect(value.transport.observedSessionDetails.observations.timestampRateValidation).toBe("observed");
    await stopSettled(value);
  });

  it("treats EOB as a boundary and fatal inline codes as session errors", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(1, (block) => blocks.push(block));
    value.io.resolve(0, encodeUsrpB205RxData(0, 0n, [[1, 2]], true));
    value.io.resolve(1, encodeUsrpB205RxData(7, 500n, [[3, 4]]));
    await tick();
    expect(blocks[1]!.discontinuityBefore).toMatchObject({ missingSamples: 0, reason: expect.stringContaining("end-of-burst") });
    value.io.resolve(2, encodeUsrpB205RxInline(8, 516n, 0x4));
    await tick();
    expect(value.errors[0]).toBeInstanceOf(Error);
    expect(value.closeOwner).toHaveBeenCalledOnce();
    expect(value.transport.diagnostics.state).toBe("closed");
  });

  it("clears endpoint-6 halt once and restarts in a fresh generation", async () => {
    const value = fixture();
    await value.transport.start(10, () => undefined);
    value.io.resolve(0, new Uint8Array(), "stall");
    await tick();
    value.io.settlePending();
    for (let index = 0; index < 5; index += 1) await tick();
    expect(value.commands.stops).toBe(1);
    expect(value.commands.starts).toBe(2);
    expect(value.io.clearRxHaltCount).toBe(1);
    expect(value.generations).toEqual([[11, "RX endpoint stalled"]]);
    expect(value.transport.diagnostics.state).toBe("running");
    await stopSettled(value);
  });

  it("reports FPGA overflow and performs one bounded fresh-generation restart", async () => {
    const value = fixture();
    await value.transport.start(30, () => undefined);
    value.io.resolve(0, encodeUsrpB205RxInline(0, 0n, 0x8));
    await tick();
    for (let index = 0; index < 6; index += 1) await tick();
    expect(value.gaps.some((gap) => (gap as { reason: string }).reason.includes("FPGA RX overflow"))).toBe(true);
    expect(value.transport.diagnostics).toMatchObject({ state: "running", generation: 31, overflowRestarts: 1 });
    expect(value.commands).toMatchObject({ starts: 2, stops: 0 });
    expect(value.transport.diagnostics.pendingReads).toBe(USRP_B205_RX_READ_SLOTS);
    await stopSettled(value);
  });

  it("resets the automatic-overflow guard at an explicit stop/start boundary", async () => {
    const value = fixture({ now: () => 1_000 });
    await value.transport.start(1, () => undefined);
    value.io.resolve(0, encodeUsrpB205RxInline(0, 0n, 0x8));
    await tick();
    const stopping = value.transport.stopAndDrain();
    value.io.settlePending();
    await stopping;
    await value.transport.start(3, () => undefined);
    const restartedAt = value.io.reads.length - USRP_B205_RX_READ_SLOTS;
    value.io.resolve(restartedAt, encodeUsrpB205RxInline(0, 0n, 0x8));
    await tick();
    expect(value.errors).toEqual([]);
    expect(value.commands.starts).toBe(4);
    await stopSettled(value);
  });

  it.each([[0x4, "broken chain"], [0x2, "late command"], [0xd, "zero-length"], [0x99, "unknown"]])("treats inline code 0x%s (%s) as fatal", async (code) => {
    const value = fixture(); await value.transport.start(1, () => undefined);
    value.io.resolve(0, encodeUsrpB205RxInline(0, 0n, code)); await tick();
    expect(value.errors).toHaveLength(1);
    expect(value.closeOwner).toHaveBeenCalledOnce();
  });

  it("bounds packet backpressure and recovers rather than overwriting", async () => {
    const value = fixture({ stopTimeoutMs: 5 });
    await value.transport.start(1, () => undefined);
    const eob = encodeUsrpB205RxData(0, 0n, [], true);
    const packed = new Uint8Array(Math.floor(USRP_B205_RX_TRANSFER_BYTES / eob.byteLength) * eob.byteLength);
    for (let offset = 0; offset < packed.byteLength; offset += eob.byteLength) packed.set(eob, offset);
    for (let index = 0; index < 8; index += 1) value.io.resolve(index, packed);
    await tick();
    expect(value.transport.diagnostics.packetQueueHighWater).toBeLessThanOrEqual(USRP_B205_RX_QUEUE_BYTES);
    expect(value.gaps.some((gap) => (gap as { reason: string }).reason.includes("queue overrun"))).toBe(true);
    value.io.settlePending();
    for (let index = 0; index < 5; index += 1) await tick();
    expect(value.transport.diagnostics).toMatchObject({ state: "running", generation: 2 });
    expect(value.commands.starts).toBe(2);
    const closing = value.transport.close();
    value.io.settlePending();
    await closing;
  });

  it("invalidates delivery before stop, ignores late completions, and isolates restart generations", async () => {
    const value = fixture(); const blocks: UsrpB205NativeBlock[] = [];
    await value.transport.start(20, (block) => blocks.push(block));
    const stopping = value.transport.stopAndDrain();
    const oldReadCount = value.io.reads.length;
    for (let index = 0; index < oldReadCount; index += 1) {
      if (!value.io.reads[index]!.settled) value.io.resolve(index, encodeUsrpB205RxData(0, 0n, [[1, 2]]));
    }
    await stopping;
    expect(blocks).toEqual([]);
    value.transport.incrementGenerationAndDiscardOldPackets();
    value.transport.acceptSession(usrpB205SessionDetails(200_000_000));
    value.transport.resetExpectedRxSequence();
    await value.transport.restart();
    const firstNew = oldReadCount;
    value.io.resolve(firstNew, encodeUsrpB205RxData(99, 0n, [[7, 8]])); await tick();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.generation).toBe(21);
    await stopSettled(value);
  });

  it("handles zero/babble transfers, unplug, watchdog and retryable cleanup", async () => {
    for (const complete of [
      (io: FakeUsrpB205RxIo) => io.resolve(0, new Uint8Array()),
      (io: FakeUsrpB205RxIo) => io.resolve(0, Uint8Array.of(1), "babble"),
      (io: FakeUsrpB205RxIo) => io.reject(0, new DOMException("unplug", "NetworkError")),
    ]) {
      const value = fixture(); await value.transport.start(1, () => undefined); complete(value.io); await tick();
      expect(value.errors).toHaveLength(1); expect(value.closeOwner).toHaveBeenCalledOnce();
    }

    vi.useFakeTimers();
    const stalled = fixture({ watchdogMs: 20 }); await stalled.transport.start(1, () => undefined);
    await vi.advanceTimersByTimeAsync(21);
    expect(stalled.errors).toHaveLength(0);
    expect(stalled.transport.diagnostics).toMatchObject({ state: "running", generation: 2, watchdogRestarts: 1 });
    expect(stalled.generations).toContainEqual([2, "endpoint no-progress receive restart"]);
    await vi.advanceTimersByTimeAsync(21);
    expect(stalled.transport.diagnostics).toMatchObject({ state: "running", generation: 3, watchdogRestarts: 2 });
    await vi.advanceTimersByTimeAsync(21);
    expect(stalled.errors).toHaveLength(1); expect(stalled.closeOwner).toHaveBeenCalledOnce();
    vi.useRealTimers();

    let attempts = 0;
    const cleanup = fixture({ closeOwner: async () => { if (attempts++ === 0) throw new Error("close failed"); } });
    await expect(cleanup.transport.close()).rejects.toThrow(/close failed/);
    expect(cleanup.transport.diagnostics.state).toBe("cleanup-required");
    await cleanup.transport.close();
    expect(cleanup.transport.diagnostics.state).toBe("closed");
  });

  it("closes on start/stop command failure and on the bounded pending-read stop timeout", async () => {
    const startFailure = fixture();
    startFailure.commands.startHook = () => { throw new Error("start failed"); };
    await expect(startFailure.transport.start(1, () => undefined)).rejects.toThrow(/start failed/);
    expect(startFailure.closeOwner).toHaveBeenCalledOnce();

    const stopFailure = fixture();
    await stopFailure.transport.start(1, () => undefined);
    stopFailure.commands.stopHook = () => { throw new Error("stop failed"); };
    await expect(stopFailure.transport.stop()).rejects.toThrow(/stop failed/);
    expect(stopFailure.closeOwner).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    const timeout = fixture({ stopTimeoutMs: 20 }); await timeout.transport.start(1, () => undefined);
    const stopping = timeout.transport.stop();
    const rejected = expect(stopping).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(timeout.closeOwner).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
