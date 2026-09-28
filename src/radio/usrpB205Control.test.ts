import { describe, expect, it, vi } from "vitest";
import { FakeUsrpB205ControlIo, encodeUsrpB205ControlAck } from "../testing/usrpB205ControlFixture";
import { USRP_B205_CONTROL_ALLOWLIST, UsrpB205ControlLink } from "./usrpB205Control";
import { encodeUsrpB205ControlRequest } from "./usrpB205Vrt";

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("USRP B205-mini serialized control link", () => {
  it("translates byte addresses, selects peek halves and wraps independent SID sequences", async () => {
    const io = new FakeUsrpB205ControlIo();
    io.responseFor = (request) => {
      const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
      return encodeUsrpB205ControlAck(request, { readback: 0x1122334455667788n,
        timestamp: view.getUint32(4, true) === 0x10 ? 7n : 0n });
    };
    const control = new UsrpB205ControlLink(io); control.start();
    expect(await control.peek64(0x40, 0)).toBe(0x1122334455667788n);
    expect(await control.peek32(0x40, 8)).toBe(0x55667788);
    await control.poke32(0x10, 136 * 4, 0);
    const words = io.writes.map((bytes) => { const view = new DataView(bytes.buffer); return [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)]; });
    expect(words).toEqual([
      [0x80000010, 0x40, 32, 0],
      [0x80010010, 0x40, 32, 1],
      [0x80000010, 0x10, 136, 0],
    ]);
    await control.close();
  });

  it("keeps one receive pending and reassembles a split response", async () => {
    const io = new FakeUsrpB205ControlIo(); io.autoRespond = false;
    const control = new UsrpB205ControlLink(io); control.start();
    expect(control.hasPendingReceive).toBe(true);
    const pending = control.peek64(0x40, 0); await tick();
    const ack = encodeUsrpB205ControlAck(io.writes[0]!, { readback: 0xace0ba5e00070000n });
    io.push(ack.slice(0, 5)); await tick();
    io.push(ack.slice(5));
    await expect(pending).resolves.toBe(0xace0ba5e00070000n);
    expect(control.hasPendingReceive).toBe(true);
    await control.close();
  });

  it("wraps the transmitted per-SID sequence modulo 4096", async () => {
    const io = new FakeUsrpB205ControlIo();
    const control = new UsrpB205ControlLink(io); control.start();
    for (let index = 0; index < 4097; index += 1) await control.poke32(0x10, 136 * 4, 0);
    const sequenceAt = (index: number) => (new DataView(io.writes[index]!.buffer).getUint32(0, true) >>> 16) & 0xfff;
    expect([sequenceAt(0), sequenceAt(4095), sequenceAt(4096)]).toEqual([0, 4095, 0]);
    await control.close();
  });

  it("discards unrelated responses, but surfaces a same-SID sequence mismatch as fatal", async () => {
    const io = new FakeUsrpB205ControlIo(); io.autoRespond = false;
    const diagnostics: string[] = [];
    const fatal = vi.fn();
    const control = new UsrpB205ControlLink(io, { onDiagnostic: (value) => diagnostics.push(value.kind), onFatal: fatal });
    control.start();
    const first = control.peek64(0x40, 0); await tick();
    io.push(encodeUsrpB205ControlAck(encodeUsrpB205ControlRequest(0x10, 0, 136, 0)));
    await tick();
    io.push(encodeUsrpB205ControlAck(io.writes[0]!, { readback: 3n }));
    await expect(first).resolves.toBe(3n);
    expect(diagnostics).toEqual(["unrelated-response"]);

    const second = control.peek64(0x40, 0); await tick();
    io.push(encodeUsrpB205ControlAck(io.writes[1]!, { sequence: 9 }));
    await expect(second).rejects.toThrow(/sequence mismatch/);
    await tick();
    expect(fatal).toHaveBeenCalledOnce();
  });

  it("enforces one outstanding plus sixteen waiting and rejects newest overflow", async () => {
    const io = new FakeUsrpB205ControlIo(); io.autoRespond = false;
    const control = new UsrpB205ControlLink(io); control.start();
    const work = [control.peek64(0x40, 0)]; await tick();
    for (let index = 0; index < 16; index += 1) work.push(control.peek64(0x40, 0));
    expect(control.outstandingCommands).toBe(1);
    expect(control.queuedCommands).toBe(16);
    await expect(control.peek64(0x40, 0)).rejects.toMatchObject({ name: "QuotaExceededError" });
    await control.close();
    await Promise.allSettled(work);
  });

  it("cancels ordinary queued work and prioritizes a validated stop sequence", async () => {
    const io = new FakeUsrpB205ControlIo(); io.autoRespond = false;
    const control = new UsrpB205ControlLink(io); control.start();
    const current = control.peek64(0x40, 0); await tick();
    const ordinary = control.poke32(0x10, 136 * 4, 0);
    const ordinaryRejected = expect(ordinary).rejects.toMatchObject({ name: "AbortError" });
    const stop = control.safetyPokes([
      { sid: 0x10, byteAddress: 96 * 4, value: 0x90000000 },
      { sid: 0x10, byteAddress: 97 * 4, value: 0 },
      { sid: 0x10, byteAddress: 98 * 4, value: 0 },
    ]);
    await ordinaryRejected;
    io.push(encodeUsrpB205ControlAck(io.writes[0]!)); await current; await tick();
    for (let index = 1; index <= 3; index += 1) {
      io.push(encodeUsrpB205ControlAck(io.writes[index]!)); await tick();
    }
    await stop;
    const settings = io.writes.slice(1).map((bytes) => new DataView(bytes.buffer).getUint32(8, true));
    expect(settings).toEqual([96, 97, 98]);
    await control.close();
  });

  it("times out, rejects queued work and invokes fatal close ownership", async () => {
    vi.useFakeTimers();
    const io = new FakeUsrpB205ControlIo(); io.autoRespond = false;
    const fatal = vi.fn(async () => undefined);
    const control = new UsrpB205ControlLink(io, { acknowledgementTimeoutMs: 20, onFatal: fatal }); control.start();
    const one = control.peek64(0x40, 0);
    const two = control.peek64(0x40, 0);
    const oneRejected = expect(one).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringMatching(/after endpoint 4 accepted/),
    });
    const twoRejected = expect(two).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(21);
    await oneRejected; await twoRejected;
    expect(fatal).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("rejects malformed transfer results and every operation outside the RX allowlist", async () => {
    expect(USRP_B205_CONTROL_ALLOWLIST).toMatchObject({ endpointOut: 4, endpointIn: 8, forbiddenEndpointOut: 2 });
    const io = new FakeUsrpB205ControlIo();
    const control = new UsrpB205ControlLink(io); control.start();
    expect(() => control.poke32(0x10, 138 * 4, 0)).toThrow(/Forbidden/);
    expect(() => control.poke32(0x10, 184 * 4, 0)).toThrow(/Forbidden/);
    expect(() => control.poke32(0x10, 12 * 4, 0x80)).toThrow(/TX_ENABLE1/);
    expect(() => control.peek64(0x10, 0)).toThrow(/Forbidden/);
    expect(() => control.peek64(0x40, 4)).toThrow(/unaligned/);
    expect(io.writes).toHaveLength(0);
    await control.close();

    const bad = new FakeUsrpB205ControlIo(); bad.autoRespond = false;
    const broken = new UsrpB205ControlLink(bad); broken.start();
    const request = broken.peek64(0x40, 0); await tick();
    bad.push(Uint8Array.of(20, 0, 0, 0));
    await expect(request).rejects.toThrow(/length 20/);
  });
});
