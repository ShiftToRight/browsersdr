import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HackrfTransport,
  HACKRF_READ_BYTES,
  HACKRF_WIDEBAND_READ_SLOTS,
  type NativeIqBlock,
} from "./hackrfTransport";
import {
  decodeHackrfFixed,
  hackrfFrequencyPayload,
  hackrfRatePayload,
  hackrfRegisterPayload,
  type HackrfConfiguration,
} from "./hackrfProtocol";
import { DEFAULT_HACKRF_RX_SETTINGS } from "./sourceCapabilities";
import {
  deferredUsb,
  FakeHackrfUsb,
  usbView,
} from "../testing/hackrfUsbFixture";

const config = (generation = 1): HackrfConfiguration => ({
  generation,
  centerFrequencyHz: 4_300_000_001,
  sampleRateHz: 1_024_000,
  settings: { ...DEFAULT_HACKRF_RX_SETTINGS },
});
const flush = async () => {
  for (let n = 0; n < 160; n++) await Promise.resolve();
};
const hex = (value: Uint8Array) =>
  [...value].map((v) => v.toString(16).padStart(2, "0")).join(" ");
async function setup() {
  const usb = new FakeHackrfUsb();
  let now = 0;
  const error = vi.fn();
  const warning = vi.fn();
  const transport = new HackrfTransport(
    { error, cleanupWarning: warning },
    () => now,
  );
  await transport.open(usb);
  const session = await transport.configure(config());
  return {
    usb,
    transport,
    session,
    error,
    warning,
    time: (value: number) => {
      now = value;
    },
  };
}
async function running(
  fixture: Awaited<ReturnType<typeof setup>>,
  blocks: NativeIqBlock[] = [],
) {
  const task = fixture.transport.startRx((block) =>
    blocks.push({ ...block, bytes: block.bytes.slice() }),
  );
  await flush();
  fixture.time(150);
  for (let n = 0; n < 6; n++) {
    fixture.usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
    await flush();
  }
  await task;
  return blocks;
}
afterEach(() => vi.useRealTimers());

describe("HackRF protocol vectors", () => {
  it("matches independently calculated pinned host vectors, without uint32 frequency truncation", () => {
    expect(hex(hackrfFrequencyPayload(4_300_000_001))).toBe(
      "cc 10 00 00 01 00 00 00",
    );
    expect(hex(hackrfFrequencyPayload(6_000_000_000))).toBe(
      "70 17 00 00 00 00 00 00",
    );
    expect(hex(hackrfRatePayload(1_024_000))).toBe("00 a0 0f 00 01 00 00 00");
    expect(hex(hackrfRatePayload(2_400_000))).toBe("00 9f 24 00 01 00 00 00");
    expect(hex(hackrfRegisterPayload(23, 2n ** 63n))).toBe(
      "17 00 00 00 00 00 00 00 80",
    );
    expect(hex(hackrfRegisterPayload(5, 0xffffffffffffffffn))).toBe(
      "05 ff ff ff ff ff ff ff ff",
    );
    expect(decodeHackrfFixed(4_300_000_001n * 2n ** 24n + 2n ** 23n, 24)).toBe(
      4_300_000_001.5,
    );
    expect(() => hackrfRegisterPayload(24, 0n)).toThrow();
    expect(() => decodeHackrfFixed(0xffffffffffffffffn, 36)).toThrow();
  });
  it("applies standard-image/cache setup with correct setup tuples and no TX/flash requests", async () => {
    const f = await setup();
    expect(f.session.hardwareCenterFrequencyHz).toBe(4_300_000_001);
    expect(f.session.details.capabilities.identity.serialWords[0]).toBe(
      0x01020304,
    );
    expect(f.session.details.capabilities.hardwareValidation).toBe("pending");
    expect(f.usb.lifecycle).toEqual(["open", "configuration:1", "claim:0"]);
    const calls = f.usb.calls;
    expect(
      calls.every(
        ({ setup }) =>
          setup.requestType === "vendor" && setup.recipient === "device",
      ),
    ).toBe(true);
    expect(
      calls.filter((c) => c.setup.request === 59 && c.setup.index === 2),
    ).toHaveLength(24);
    expect(
      calls.filter((c) => c.setup.request === 59 && c.setup.index === 3),
    ).toHaveLength(24);
    expect(
      calls
        .filter((c) => c.setup.request === 59)
        .every(
          (c) =>
            [1, 2, 3].includes(c.setup.index) &&
            c.bytes[0]! > 0 &&
            c.bytes[0]! < 24,
        ),
    ).toBe(true);
    expect(calls.find((c) => c.setup.request === 19)).toMatchObject({
      direction: "in",
      length: 1,
      setup: { value: 0, index: 16 },
    });
    expect(calls.find((c) => c.setup.request === 20)).toMatchObject({
      direction: "in",
      length: 1,
      setup: { value: 0, index: 12 },
    });
    expect(
      calls
        .filter((c) => c.setup.request === 60)
        .every((c) => c.length === 8 && c.setup.index === 0),
    ).toBe(true);
    expect(f.usb.fpga.get(2)).toBe(5); // repaired after image initialization to zero
    await running(f);
    await f.transport.close();
    expect(
      calls.filter((c) => c.setup.request === 1).map((c) => c.setup.value),
    ).toEqual([0, 1, 0]);
    expect(
      calls
        .filter((c) => [17, 23, 29, 54].includes(c.setup.request))
        .every((c) => c.setup.value === 0),
    ).toBe(true);
    expect(
      calls.every((c) =>
        [
          1, 6, 14, 15, 16, 17, 18, 19, 20, 23, 29, 45, 46, 49, 50, 54, 59, 60,
        ].includes(c.setup.request),
      ),
    ).toBe(true);
    expect(
      f.usb.reads.every(
        (read) => read.endpoint === 1 && read.length === 65_536,
      ),
    ).toBe(true);
  });
  it.each([14, 18, 45, 46])(
    "rejects malformed identity transfer %i and closes",
    async (request) => {
      const usb = new FakeHackrfUsb();
      usb.inOverride = (s) =>
        s.request === request
          ? Promise.resolve({ status: "ok", data: usbView([]) })
          : undefined;
      const transport = new HackrfTransport();
      await expect(transport.open(usb)).rejects.toThrow();
      expect(usb.lifecycle.at(-1)).toBe("close");
      expect(usb.calls.some((c) => c.setup.request === 54)).toBe(false);
    },
  );
  it("rejects One/API mismatch/low-speed layout before Pro setup", async () => {
    for (const change of ["board", "api", "speed"] as const) {
      const usb = new FakeHackrfUsb();
      const transport = new HackrfTransport();
      if (change === "board")
        usb.inOverride = (s) =>
          s.request === 14
            ? Promise.resolve({ status: "ok", data: usbView([2]) })
            : undefined;
      if (change === "api") usb.deviceVersionSubminor = 2;
      if (change === "speed")
        usb.layout = {
          ...usb.layout,
          interfaces: [
            {
              ...usb.layout.interfaces[0]!,
              alternate: {
                ...usb.layout.interfaces[0]!.alternate,
                endpoints: [
                  {
                    endpointNumber: 1,
                    direction: "in",
                    type: "bulk",
                    packetSize: 64,
                  },
                ],
              },
            },
          ],
        };
      await expect(transport.open(usb)).rejects.toThrow();
      expect(usb.opened).toBe(false);
      expect(usb.calls.some((c) => c.setup.request === 54)).toBe(false);
    }
  });
  it.each(["stall", "length", "gain", "fpga"])(
    "rejects bad configuration %s and releases the device",
    async (fault) => {
      const usb = new FakeHackrfUsb();
      const transport = new HackrfTransport();
      await transport.open(usb);
      if (fault === "stall" || fault === "length")
        usb.outOverride = (s) =>
          s.request === 54
            ? Promise.resolve({
                status: fault === "stall" ? "stall" : "ok",
                bytesWritten: fault === "length" ? 1 : 0,
              })
            : undefined;
      else
        usb.inOverride = (s) =>
          s.request === (fault === "gain" ? 19 : 50)
            ? Promise.resolve({ status: "ok", data: usbView([0]) })
            : undefined;
      await expect(transport.configure(config())).rejects.toThrow();
      expect(usb.opened).toBe(false);
    },
  );
});

describe("ordered, bounded HackRF samples", () => {
  it("waits for both sample-count and wall-clock settling before readiness", async () => {
    const f = await setup();
    const receive = vi.fn();
    const ready = vi.fn();
    const task = f.transport.startRx(receive, ready);
    await flush();
    for (let n = 0; n < 8; n++) {
      f.usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
      await flush();
    }
    expect(receive).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    f.time(120);
    f.usb.deliver([1, 2]);
    await flush();
    await task;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]![0]).toMatchObject({
      generation: 1,
      sequence: 0,
      firstSampleIndex: 0,
      complexSampleCount: 1,
    });
    await f.transport.close();
  });
  it("orders completed slots and preserves offset/odd chunks without growing the queue", async () => {
    const f = await setup();
    const blocks = await running(f);
    blocks.length = 0;
    f.usb.deliver([3, 4], 1);
    f.usb.deliver([5, 6], 1);
    await flush();
    expect(blocks).toHaveLength(0);
    expect(f.transport.diagnostics.readSlots).toBe(4);
    const submissions = f.usb.reads.length;
    await flush();
    expect(f.usb.reads).toHaveLength(submissions);
    f.usb.deliver([128], 0);
    await flush();
    expect(blocks.map((b) => [...b.bytes])).toEqual([
      [128, 3],
      [4, 5],
    ]);
    f.usb.deliver([127], 0);
    await flush();
    expect([...blocks.at(-1)!.bytes]).toEqual([6, 127]);
    expect(blocks.map((b) => b.firstSampleIndex)).toEqual([
      32768, 32769, 32770,
    ]);
    expect(f.transport.diagnostics.readSlotsHighWater).toBe(4);
    await f.transport.close();
  });
  it.each(["empty", "stall", "unplug"])(
    "stops and closes on %s without waiting for another read",
    async (fault) => {
      const f = await setup();
      await running(f);
      const read = f.usb.pendingReads[0]!;
      read.settled = true;
      if (fault === "unplug") read.result.reject(new Error("Device unplugged"));
      else
        read.result.resolve({
          status: fault === "stall" ? "stall" : "ok",
          data: usbView([]),
        });
      await flush();
      expect(f.error).toHaveBeenCalledTimes(1);
      await f.transport.stopRx();
      expect(f.usb.opened).toBe(false);
      expect(f.transport.diagnostics.pendingOperations).toBe(0);
    },
  );
  it("closes/reopens before reconfiguration and never pairs residual bytes across generations", async () => {
    const f = await setup();
    const blocks = await running(f);
    f.usb.deliver([128]);
    await flush();
    const next = await f.transport.configure({
      ...config(2),
      centerFrequencyHz: 6_000_000_000,
      sampleRateHz: 2_400_000,
      settings: {
        ...DEFAULT_HACKRF_RX_SETTINGS,
        rxLnaGainCode: 33,
        rxVgaGainDb: 62,
      },
    });
    expect(f.usb.lifecycle.filter((v) => v === "open")).toHaveLength(2);
    expect(f.transport.diagnostics.discardedPartialPairs).toBe(1);
    expect(next.details.fpgaDecimationFactor).toBe(16);
    expect(next.hardwareCenterFrequencyHz).toBe(6_000_000_000);
    expect(
      f.usb.calls.filter((c) => c.setup.request === 19).at(-1)!.setup.index,
    ).toBe(33);
    const oldLength = blocks.length;
    const task = f.transport.startRx((block) =>
      blocks.push({ ...block, bytes: block.bytes.slice() }),
    );
    await flush();
    f.time(300);
    for (let n = 0; n < 10; n++) {
      f.usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
      await flush();
    }
    f.usb.deliver([127, 255]);
    await flush();
    await task;
    expect(blocks).toHaveLength(oldLength + 1);
    expect(blocks.at(-1)).toMatchObject({
      generation: 2,
      sequence: 0,
      firstSampleIndex: 0,
    });
    expect([...blocks.at(-1)!.bytes]).toEqual([127, 255]);
    await f.transport.close();
  });
});

describe("HackRF ownership and cancellation", () => {
  it("calls the permission chooser synchronously and closes a late grant", async () => {
    const grant = deferredUsb<USBDevice>();
    const usb = new FakeHackrfUsb();
    const chooser = { requestDevice: vi.fn(() => grant.promise) };
    const transport = new HackrfTransport();
    const opening = transport.requestAndOpen(chooser);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(chooser.requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: 0x1d50, productId: 0x6089 }],
    });
    const closing = transport.close();
    grant.resolve(usb);
    await closing;
    await rejected;
    expect(usb.lifecycle).toEqual(["close"]);
  });
  it("handles chooser rejection and late open completion", async () => {
    const cancelled = new HackrfTransport();
    await expect(
      cancelled.requestAndOpen({
        requestDevice: () =>
          Promise.reject(new DOMException("cancelled", "NotFoundError")),
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    const usb = new FakeHackrfUsb();
    const gate = deferredUsb<void>();
    usb.openGate = gate.promise;
    const transport = new HackrfTransport();
    const opening = transport.open(usb);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    const closing = transport.close();
    await flush();
    expect(usb.lifecycle).toEqual(["open"]);
    gate.resolve();
    await closing;
    await rejected;
    expect(usb.lifecycle).toEqual(["open", "close"]);
  });
  it("closes pending reads and shares concurrent close operations", async () => {
    const f = await setup();
    await running(f);
    const one = f.transport.close();
    const two = f.transport.close();
    expect(one).toBe(two);
    await one;
    await f.transport.close();
    expect(f.usb.lifecycle.filter((value) => value === "close")).toHaveLength(
      1,
    );
    expect(f.usb.pendingReads).toHaveLength(0);
    expect(f.transport.diagnostics).toMatchObject({
      state: "closed",
      pendingOperations: 0,
      readSlots: 0,
    });
  });
  it("retains a failed close and rejects replacement until retry", async () => {
    const f = await setup();
    await running(f);
    f.usb.closeFailures = 1;
    await expect(f.transport.stopRx()).rejects.toThrow("close failed");
    expect(f.transport.diagnostics.state).toBe("cleanup-required");
    await expect(f.transport.configure(config(2))).rejects.toThrow();
    await f.transport.stopRx();
    expect(f.transport.diagnostics.pendingOperations).toBe(0);
    await f.transport.configure(config(2));
    await f.transport.close();
  });
  it("cleans partial initialization, retaining failed cleanup for retry", async () => {
    const usb = new FakeHackrfUsb();
    usb.claimFailure = true;
    usb.closeFailures = 1;
    const transport = new HackrfTransport();
    await expect(transport.open(usb)).rejects.toThrow("claim failed");
    expect(transport.diagnostics.state).toBe("cleanup-required");
    await transport.close();
    expect(usb.opened).toBe(false);
  });
  it("a no-progress watchdog starts real close and does not pretend it cancelled reads", async () => {
    vi.useFakeTimers();
    const f = await setup();
    await running(f);
    const gate = deferredUsb<void>();
    f.usb.closeGate = gate.promise;
    await vi.advanceTimersByTimeAsync(2_001);
    expect(f.error).toHaveBeenCalledTimes(1);
    expect(f.usb.lifecycle.at(-1)).toBe("close");
    expect(f.transport.diagnostics.state).toBe("closing");
    expect(f.transport.diagnostics.pendingOperations).toBeGreaterThan(0);
    gate.resolve();
    await flush();
    await f.transport.close();
    expect(f.transport.diagnostics.pendingOperations).toBe(0);
  });
  it("stops during startup before first retained samples", async () => {
    const f = await setup();
    const callback = vi.fn();
    const starting = f.transport.startRx(callback);
    const rejected = expect(starting).rejects.toMatchObject({
      name: "AbortError",
    });
    await flush();
    await f.transport.stopRx();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    expect(f.usb.pendingReads).toHaveLength(0);
  });
});

describe("HackRF interruption boundaries", () => {
  it("does not reopen if Stop arrives during a retune's pending close", async () => {
    const f = await setup();
    await running(f);
    const gate = deferredUsb<void>();
    f.usb.closeGate = gate.promise;
    const retune = f.transport.configure(config(2));
    const rejected = expect(retune).rejects.toMatchObject({
      name: "AbortError",
    });
    await flush();
    const stopping = f.transport.stopRx();
    gate.resolve();
    await stopping;
    await rejected;
    expect(f.usb.lifecycle.filter((v) => v === "open")).toHaveLength(1);
    expect(f.usb.opened).toBe(false);
  });
  it("does not deliver late successful reads after cancellation", async () => {
    const f = await setup();
    const blocks = await running(f);
    const count = blocks.length;
    const oldReads = [...f.usb.pendingReads];
    f.usb.settleReadsOnClose = false;
    let closed = false;
    const close = f.transport.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    expect(f.transport.diagnostics.pendingOperations).toBe(4);
    for (const read of oldReads) {
      read.settled = true;
      read.result.resolve({ status: "ok", data: usbView([1, 2]) });
    }
    await close;
    expect(blocks).toHaveLength(count);
    expect(f.transport.diagnostics.pendingOperations).toBe(0);
  });
  it("OFF timeout closes USB and retains the actual pending control until settled", async () => {
    vi.useFakeTimers();
    const f = await setup();
    await running(f);
    const off = deferredUsb<USBOutTransferResult>();
    f.usb.outOverride = (s) =>
      s.request === 1 && s.value === 0 ? off.promise : undefined;
    const originalClose = f.usb.close.bind(f.usb);
    f.usb.close = async () => {
      await originalClose();
      off.reject(new DOMException("aborted", "AbortError"));
    };
    const stopping = f.transport.stopRx();
    await flush();
    expect(f.usb.lifecycle.at(-1)).not.toBe("close");
    await vi.advanceTimersByTimeAsync(2_001);
    await stopping;
    expect(f.usb.lifecycle.at(-1)).toBe("close");
    expect(f.transport.diagnostics.pendingOperations).toBe(0);
    expect(f.transport.diagnostics.lastOffError).toContain("deadline");
  });
  it("control timeout closes without issuing competing controls or abandoning a raw Promise", async () => {
    vi.useFakeTimers();
    const usb = new FakeHackrfUsb();
    const transport = new HackrfTransport({}, () => Date.now());
    await transport.open(usb);
    const image = deferredUsb<USBOutTransferResult>();
    usb.outOverride = (s) => (s.request === 54 ? image.promise : undefined);
    const originalClose = usb.close.bind(usb);
    usb.close = async () => {
      await originalClose();
      image.reject(new DOMException("aborted image load", "AbortError"));
    };
    const configuring = transport.configure(config());
    const rejected = expect(configuring).rejects.toThrow(/deadline/);
    await flush();
    const calls = usb.calls.length;
    await vi.advanceTimersByTimeAsync(2_001);
    await rejected;
    expect(usb.calls).toHaveLength(calls);
    expect(usb.opened).toBe(false);
    expect(transport.diagnostics.pendingOperations).toBe(0);
  });
  it("rejects overlapping commands and invalid settings without disturbing a running generation", async () => {
    const f = await setup();
    await running(f);
    await expect(
      f.transport.configure({
        ...config(2),
        settings: { ...DEFAULT_HACKRF_RX_SETTINGS, rxVgaGainDb: 3 },
      }),
    ).rejects.toThrow();
    expect(f.transport.diagnostics.state).toBe("running");
    const changing = f.transport.configure(config(2));
    await expect(f.transport.configure(config(3))).rejects.toThrow(/busy/);
    await changing;
    await f.transport.close();
  });
  it("limits stale settings polling and closes on mismatched applied state", async () => {
    vi.useFakeTimers();
    const usb = new FakeHackrfUsb();
    const transport = new HackrfTransport({}, () => Date.now());
    await transport.open(usb);
    usb.inOverride = (s) =>
      s.request === 60 && s.value === 12
        ? Promise.resolve({ status: "ok", data: usbView(new Uint8Array(8)) })
        : undefined;
    const task = transport.configure(config());
    const rejected = expect(task).rejects.toThrow(/settle/);
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(
      usb.calls.filter((c) => c.setup.request === 60 && c.setup.value === 12),
    ).toHaveLength(20);
    expect(usb.opened).toBe(false);
  });
  it("cleans up when a consumer or error observer throws", async () => {
    const usb = new FakeHackrfUsb();
    let now = 0;
    const error = vi.fn(() => {
      throw new Error("observer failed");
    });
    const transport = new HackrfTransport({ error }, () => now);
    await transport.open(usb);
    await transport.configure(config());
    const task = transport.startRx(() => {
      throw new Error("consumer failed");
    });
    const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    now = 150;
    for (let n = 0; n < 6; n++) {
      usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
      await flush();
    }
    // A failure in the first consumer must not publish a stale startup success.
    await rejected;
    await transport.close();
    expect(error).toHaveBeenCalledTimes(1);
    expect(transport.diagnostics.lastDiscontinuity).toMatchObject({
      missingSamples: null,
      reason: "consumer failed",
    });
    expect(usb.opened).toBe(false);
  });
});

it("stops sustained slow mandatory consumption instead of buffering a backlog", async () => {
  const usb = new FakeHackrfUsb();
  let now = 0;
  const error = vi.fn();
  const transport = new HackrfTransport({ error }, () => now);
  await transport.open(usb);
  await transport.configure(config());
  const starting = transport.startRx(() => {
    now += 40;
  });
  await flush();
  now = 150;
  // Five settling blocks, then twelve 8 ms overruns exhaust the 96 ms headroom.
  for (let n = 0; n < 17; n++) {
    usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
    await flush();
  }
  await starting;
  await transport.close();
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]![0])).toContain("cannot sustain");
  expect(transport.diagnostics.readSlotsHighWater).toBe(4);
});

it("absorbs brief consecutive processing overruns and recovers within fixed USB headroom", async () => {
  const usb = new FakeHackrfUsb();
  let now = 0;
  const error = vi.fn();
  let count = 0;
  const transport = new HackrfTransport({ error }, () => now);
  await transport.open(usb);
  await transport.configure(config());
  const starting = transport.startRx(() => {
    now += count++ % 8 < 4 ? 40 : 20;
  });
  await flush();
  now = 150;
  // Repeated four-slow/four-fast cycles recover; no unbounded lag or allocation.
  for (let n = 0; n < 45; n++) {
    usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
    await flush();
  }
  await starting;
  expect(count).toBe(40);
  expect(error).not.toHaveBeenCalled();
  expect(transport.diagnostics.state).toBe("running");
  expect(transport.diagnostics.readSlotsHighWater).toBe(4);
  await transport.close();
});

it.each([2_400_000, 4_800_000, 9_600_000, 19_200_000] as const)(
  "keeps a bounded completion-burst queue at %i samples/s",
  async (sampleRateHz) => {
    const usb = new FakeHackrfUsb();
    const transport = new HackrfTransport();
    await transport.open(usb);
    await transport.configure({ ...config(), sampleRateHz });
    const starting = transport.startRx(() => undefined);
    void starting.catch(() => undefined);
    await flush();
    const slots = HACKRF_WIDEBAND_READ_SLOTS;
    expect(transport.diagnostics.readSlotsHighWater).toBe(slots);
    expect(transport.diagnostics.rawSlotBytesLimit).toBe(
      slots * HACKRF_READ_BYTES,
    );
    await transport.close();
  },
);

it.each(
  ([9_600_000, 19_200_000] as const).flatMap((rate) =>
    [false, true].map((sustained) => ({ rate, sustained })),
  ),
)(
  "bounds $rate transport and distinguishes jitter from sustained overload: $sustained",
  async ({ rate, sustained }) => {
    const usb = new FakeHackrfUsb();
    let now = 0,
      calls = 0;
    const error = vi.fn();
    const transport = new HackrfTransport({ error }, () => now);
    await transport.open(usb);
    await transport.configure({ ...config(), sampleRateHz: rate });
    const starting = transport.startRx(() => {
      now += sustained || calls++ === 0 ? 12 : 0.2;
    });
    void starting.catch(() => undefined);
    await flush();
    now = 150;
    for (let n = 0; n < 160 && !error.mock.calls.length; n++) {
      usb.deliver(new Uint8Array(HACKRF_READ_BYTES));
      await flush();
    }
    await starting;
    const slots = HACKRF_WIDEBAND_READ_SLOTS;
    expect(transport.diagnostics.readSlotsHighWater).toBe(slots);
    expect(transport.diagnostics.rawSlotBytesLimit).toBe(
      slots * HACKRF_READ_BYTES,
    );
    if (sustained)
      expect(String(error.mock.calls[0]?.[0])).toContain("cannot sustain");
    else {
      expect(error).not.toHaveBeenCalled();
      expect(transport.diagnostics.state).toBe("running");
    }
    await transport.close();
    expect(transport.diagnostics.readSlots).toBe(0);
  },
);
