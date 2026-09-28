import { describe, expect, it, vi } from "vitest";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import { encodeUsrpB205RxData } from "../testing/usrpB205RxFixture";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import { decodeUsrpB205RxPacket } from "./usrpB205RxVrt";
import { UsrpB205SampleAdapter } from "./usrpB205Source";
import type { UsrpB205NativeBlock } from "./usrpB205RxTransport";

function native(packetBytes: Uint8Array, generation = 3): UsrpB205NativeBlock {
  const packet = decodeUsrpB205RxPacket(packetBytes);
  if (packet.kind !== "data") throw new Error("fixture expected data");
  return {
    nativePacketBytes: packet.packetBytes, bytes: packet.payloadBytes,
    encoding: "chdr-vrt-sc16-le", sampleWordOrder: "i16-msw-q16-lsw", bytesPerComplexSample: 4,
    complexSampleCount: packet.complexSampleCount, nativeSampleRateHz: 4_800_000,
    generation, sequence: packet.sequence, timestampTicks: packet.timestampTicks,
    firstSampleIndex: 0, receivedAtMonotonicMs: 1, endOfBurst: packet.endOfBurst, discontinuityBefore: null,
  };
}

describe("USRP B205-mini planar sample adapter", () => {
  it("preserves positive complex-tone I/Q orientation and negative rotation", () => {
    const received: Array<{ I: number[]; Q: number[]; frequency: number }> = [];
    const receiver = {
      setSampleRate: vi.fn(),
      receiveSamples: (value: { I: Float32Array; Q: Float32Array; frequency: number }) => {
        received.push({ I: [...value.I], Q: [...value.Q], frequency: value.frequency });
      },
    } as unknown as SampleReceiver;
    const adapter = new UsrpB205SampleAdapter(receiver);
    adapter.ready({ generation: 3, details: usrpB205SessionDetails(4_300_000_001) });
    adapter.receive({ ...native(encodeUsrpB205RxData(0, 0n, [[32767, 0], [0, 32767], [-32768, 0], [0, -32768]])), endOfBurst: true });
    expect(received[0]!.frequency).toBe(4_300_000_001);
    expect(received[0]!.I).toEqual([expect.closeTo(0.99999976, 6), 0, expect.closeTo(-1.0000303, 6), 0]);
    expect(received[0]!.Q).toEqual([0, expect.closeTo(0.99999976, 6), 0, expect.closeTo(-1.0000303, 6)]);

    adapter.receive({ ...native(encodeUsrpB205RxData(1, 64n, [[32767, 0], [0, -32768], [-32768, 0], [0, 32767]])), endOfBurst: true });
    expect(received[1]!.Q[1]).toBeLessThan(0);
    expect(received[1]!.Q[3]).toBeGreaterThan(0);
  });

  it("offers the owned native packet once, reports discontinuity, and rejects stale generations", () => {
    const nativePackets: Uint8Array[] = [];
    const gaps: unknown[] = [];
    const receiver = { setSampleRate: vi.fn(), receiveSamples: vi.fn() } as unknown as SampleReceiver;
    const adapter = new UsrpB205SampleAdapter(receiver, (block) => nativePackets.push(Uint8Array.from(block.nativePacketBytes)), (gap) => gaps.push(gap));
    adapter.ready({ generation: 3, details: usrpB205SessionDetails() });
    const packet = native(encodeUsrpB205RxData(5, 0n, [[1, 2]]));
    adapter.receive({ ...packet, endOfBurst: true, discontinuityBefore: { generation: 3, missingSamples: 2040, reason: "gap" } });
    adapter.receive({ ...packet, generation: 2 });
    expect(nativePackets).toEqual([packet.nativePacketBytes]);
    expect(gaps).toHaveLength(1);
    expect(receiver.receiveSamples).toHaveBeenCalledOnce();
  });

  it("rejects asynchronous consumers and forged native ownership", () => {
    const asyncReceiver = { setSampleRate() {}, receiveSamples: () => Promise.resolve() } as unknown as SampleReceiver;
    const adapter = new UsrpB205SampleAdapter(asyncReceiver);
    adapter.ready({ generation: 3, details: usrpB205SessionDetails() });
    expect(() => adapter.receive({ ...native(encodeUsrpB205RxData(0, 0n, [[1, 2]])), endOfBurst: true })).toThrow(/synchronously/);
    const valid = native(encodeUsrpB205RxData(0, 0n, [[1, 2]]));
    const copiedPayload = Uint8Array.from(valid.bytes);
    expect(() => adapter.receive({ ...valid, bytes: copiedPayload })).toThrow(/Invalid/);
  });

  it("coalesces full VRT payloads into bounded worker-sized deliveries", () => {
    const lengths: number[] = [];
    const receiver = {
      setSampleRate: vi.fn(),
      receiveSamples: (value: { I: Float32Array }) => lengths.push(value.I.length),
    } as unknown as SampleReceiver;
    const adapter = new UsrpB205SampleAdapter(receiver);
    adapter.ready({ generation: 3, details: usrpB205SessionDetails() });
    const samples = Array.from({ length: 4086 }, () => [1, -1] as [number, number]);
    for (let sequence = 0; sequence < 9; sequence++)
      adapter.receive(native(encodeUsrpB205RxData(sequence, BigInt(sequence * 32688), samples)));
    expect(lengths).toEqual([32_688]);
    adapter.receive({ ...native(encodeUsrpB205RxData(9, 294192n, [[2, -2]])), endOfBurst: true });
    expect(lengths).toEqual([32_688, 4_087]);
  });
});
