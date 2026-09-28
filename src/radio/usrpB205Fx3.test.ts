import { describe, expect, it, vi } from "vitest";
import { FakeUsrpB205Usb, deferredUsb } from "../testing/usrpB205UsbFixture";
import {
  USRP_B205_CLAIM_ORDER,
  USRP_B205_FX3_REQUESTS,
  USRP_B205_RELEASE_ORDER,
  USRP_B205_USB_FILTER,
  selectAuthorizedUsrpB205Device,
  UsrpB205Fx3Connection,
} from "./usrpB205Fx3";
import { USRP_B205_IMAGE, type VerifiedUsrpB205Image } from "./usrpB205Images";
import { USRP_B205_FIRMWARE } from "./usrpB205Firmware";
import { usrpB205FirmwareFixture } from "../testing/usrpB205FirmwareFixture";

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function image(bytes = Uint8Array.of(1, 2, 3)): VerifiedUsrpB205Image {
  return {
    contract: USRP_B205_IMAGE,
    bytes,
    importedAs: "official-member",
    archiveSha256: null,
    memberSha256: USRP_B205_IMAGE.memberSha256,
    legacyHash: USRP_B205_IMAGE.legacyHash,
  };
}

function connection() {
  return new UsrpB205Fx3Connection({
    verifyImage: async (value) => Uint8Array.from(value.bytes),
    verifyFirmware: async () => [
      { address: 0x40000000, bytes: Uint8Array.of(0xaa, 0x55), execute: false },
      {
        address: USRP_B205_FIRMWARE.entryAddress,
        bytes: new Uint8Array(),
        execute: true,
      },
    ],
    pause: async () => undefined,
  });
}

function stalledIn(): Promise<USBInTransferResult> {
  return new Promise(() => undefined);
}

describe("USRP B205-mini FX3 discovery and volatile loading", () => {
  it("resolves the sole current replug identity when the previous serial is stale", () => {
    const configuration = (interfaces: number[]) =>
      ({
        configurationValue: 1,
        interfaces: interfaces.map((interfaceNumber) => ({ interfaceNumber })),
      }) as unknown as USBConfiguration;
    const bootloader = {
      vendorId: 0x2500,
      productId: 0x0022,
      serialNumber: "BOOT",
      configurations: [configuration([0])],
    } as unknown as USBDevice;
    const runtime = {
      vendorId: 0x2500,
      productId: 0x0022,
      serialNumber: "RUNTIME",
      configurations: [configuration([0, 1, 2, 3, 4])],
    } as unknown as USBDevice;

    expect(selectAuthorizedUsrpB205Device([runtime], "OLD-RUNTIME")).toBe(
      runtime,
    );
    expect(
      selectAuthorizedUsrpB205Device([bootloader, runtime], "OLD-RUNTIME"),
    ).toBe(runtime);
    expect(selectAuthorizedUsrpB205Device([bootloader], "OLD-RUNTIME")).toBe(
      bootloader,
    );
  });

  it("does not guess between multiple unmatched authorized runtime devices", () => {
    const runtime = (serialNumber: string) =>
      ({
        vendorId: 0x2500,
        productId: 0x0022,
        serialNumber,
        configurations: [
          {
            configurationValue: 1,
            interfaces: [0, 1, 2, 3, 4].map((interfaceNumber) => ({
              interfaceNumber,
            })),
          },
        ],
      }) as unknown as USBDevice;

    expect(
      selectAuthorizedUsrpB205Device([runtime("A"), runtime("B")], "STALE"),
    ).toBeUndefined();
  });

  it("freezes golden EP0 request directions, recipients, values, indices and lengths", () => {
    expect(USRP_B205_FX3_REQUESTS).toEqual({
      firmwareRamWrite: {
        direction: "out",
        request: 0xa0,
        minimumLength: 0,
        maximumLength: 255,
      },
      firmwareCompatibility: { direction: "in", request: 0x15, length: 2 },
      usbSpeed: { direction: "in", request: 0x80, length: 1 },
      loaderState: { direction: "in", request: 0x83, length: 1 },
      fpgaHashRead: { direction: "in", request: 0x1d, length: 4 },
      fpgaHashWrite: { direction: "out", request: 0x1c, length: 4 },
      preflight: { direction: "in", request: 0x22, length: 512 },
      prepare: { direction: "out", request: 0x55, length: 1 },
      configure: { direction: "out", request: 0x02, length: 1 },
      imageChunk: {
        direction: "out",
        request: 0x12,
        minimumLength: 1,
        maximumLength: 512,
      },
      gpifReset: { direction: "out", request: 0x72, length: 4 },
    });
    const setupBytes = (
      direction: "in" | "out",
      request: number,
      length: number,
    ) => [
      direction === "in" ? 0xc0 : 0x40,
      request,
      0,
      0,
      0,
      0,
      length & 0xff,
      length >>> 8,
    ];
    expect(setupBytes("in", 0x15, 2)).toEqual([0xc0, 0x15, 0, 0, 0, 0, 2, 0]);
    expect(setupBytes("out", 0x55, 1)).toEqual([0x40, 0x55, 0, 0, 0, 0, 1, 0]);
    expect(setupBytes("out", 0x12, 512)).toEqual([
      0x40, 0x12, 0, 0, 0, 0, 0, 2,
    ]);
  });

  it("invokes the exact chooser synchronously, skips a compatible image and claims only 4,3,2", async () => {
    const usb = new FakeUsrpB205Usb();
    const chooser = { requestDevice: vi.fn(async () => usb) } as unknown as USB;
    const loader = connection();
    const opening = loader.requestAndOpen(image(), chooser);
    expect(chooser.requestDevice).toHaveBeenCalledWith({
      filters: [{ ...USRP_B205_USB_FILTER }],
    });
    const identity = await opening;
    expect(identity).toMatchObject({
      imageDisposition: "already-compatible",
      firmware: { major: 8, minor: 0 },
      loaderState: 4,
      fpgaCompatibilityCheck: "pending-chdr-step-04",
    });
    expect(usb.lifecycle).toEqual([
      "open",
      "configuration:1",
      "gpif-reset",
      "claim:4",
      "claim:3",
      "claim:2",
    ]);
    expect([...usb.claimed]).toEqual([...USRP_B205_CLAIM_ORDER]);
    expect(Object.keys(loader.claimedBulkIo()).sort()).toEqual([
      "clearRxHalt",
      "transferControlIn",
      "transferControlOut",
      "transferRxIn",
    ]);
    expect(
      usb.calls
        .filter((call) => call.direction === "out")
        .map((call) => call.setup.request),
    ).toEqual([0x72]);
    for (const call of usb.calls)
      expect(call.setup).toMatchObject({
        requestType: "vendor",
        recipient: "device",
        value: 0,
        index: 0,
      });
    await loader.close();
    expect(usb.lifecycle.slice(-4)).toEqual([
      ...USRP_B205_RELEASE_ORDER.map((value) => `release:${value}`),
      "close",
    ]);
  });

  it("defers full interface validation until Chrome has opened the device", async () => {
    const usb = new FakeUsrpB205Usb();
    const fullConfiguration = usb.configurations[0]!;
    usb.configurations = [
      { ...fullConfiguration, interfaces: [] } as USBConfiguration,
    ];
    const open = usb.open.bind(usb);
    usb.open = async () => {
      await open();
      usb.configurations = [fullConfiguration];
    };

    const loader = connection();
    await expect(loader.open(usb, image())).resolves.toMatchObject({
      descriptorLayoutVerified: true,
      imageDisposition: "already-compatible",
    });
    expect(usb.lifecycle.slice(0, 2)).toEqual(["open", "configuration:1"]);
    await loader.close();
  });

  it("identifies the empty FX3 bootloader layout without writing when firmware has not been imported", async () => {
    const usb = new FakeUsrpB205Usb();
    const runtime = usb.configurations[0]!;
    usb.productName = "WestBridge";
    usb.configurations = [
      {
        ...runtime,
        interfaces: [runtime.interfaces[0]!],
      } as USBConfiguration,
    ];

    await expect(connection().open(usb, image())).rejects.toThrow(
      /WestBridge mode.*Import the pinned.*firmware first/,
    );
    expect(usb.calls).toHaveLength(0);
    expect(usb.lifecycle).toEqual(["open", "configuration:1", "close"]);
  });

  it("identifies WestBridge by its pinned loader layout rather than an unstable product string", async () => {
    const usb = new FakeUsrpB205Usb();
    const runtime = usb.configurations[0]!;
    usb.productName = "Cypress WestBridge";
    usb.configurations = [
      {
        ...runtime,
        interfaces: [runtime.interfaces[0]!],
      } as USBConfiguration,
    ];

    await expect(connection().open(usb, image())).rejects.toThrow(
      /WestBridge mode.*Import the pinned.*firmware first/,
    );
    expect(usb.calls).toHaveLength(0);
  });

  it("loads verified FX3 firmware into RAM, follows re-enumeration, then continues with the runtime device", async () => {
    const bootloader = new FakeUsrpB205Usb();
    const runtimeConfiguration = bootloader.configurations[0]!;
    bootloader.productName = "WestBridge";
    bootloader.configurations = [
      {
        ...runtimeConfiguration,
        interfaces: [runtimeConfiguration.interfaces[0]!],
      } as USBConfiguration,
    ];
    let executed = false;
    bootloader.outOverride = (setup, bytes) => {
      if (setup.request !== 0xa0) return undefined;
      if (bytes.byteLength === 0) executed = true;
      return Promise.resolve({ status: "ok", bytesWritten: bytes.byteLength });
    };
    const runtime = new FakeUsrpB205Usb();
    bootloader.serialNumber = "0000000004BE";
    runtime.serialNumber = "34BC216";
    const usb = {
      getDevices: vi.fn(async () => (executed ? [runtime] : [bootloader])),
    };
    const loader = connection();

    const identity = await loader.open(
      bootloader,
      image(),
      usrpB205FirmwareFixture(),
      usb,
    );

    expect(identity).toMatchObject({
      productName: "USRP B205-mini",
      imageDisposition: "already-compatible",
    });
    const firmwareWrites = bootloader.calls.filter(
      (call) => call.setup.request === 0xa0,
    );
    expect(firmwareWrites).toHaveLength(2);
    expect(firmwareWrites[0]).toMatchObject({
      setup: {
        requestType: "vendor",
        recipient: "device",
        value: 0,
        index: 0x4000,
      },
      bytes: [0xaa, 0x55],
    });
    expect(firmwareWrites[1]).toMatchObject({
      setup: { value: USRP_B205_FIRMWARE.entryAddress & 0xffff, index: 0x4001 },
      length: 0,
    });
    expect(loader.diagnostics).toMatchObject({
      firmwareDisposition: "loaded-volatile",
      firmwareWrites: 2,
      state: "ready",
    });
    expect(identity.serialNumber).toBe("34BC216");
    expect(runtime.lifecycle).toEqual([
      "open",
      "configuration:1",
      "gpif-reset",
      "claim:4",
      "claim:3",
      "claim:2",
    ]);
    await loader.close();
  });

  it("loads a mismatched/unconfigured FPGA once in 512-byte chunks and verifies hash/state after GPIF reset", async () => {
    const usb = new FakeUsrpB205Usb();
    usb.loaderState = 5;
    usb.legacyHash = 0;
    const bytes = new Uint8Array(1_025);
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = index & 0xff;
    const loader = connection();
    const identity = await loader.open(usb, image(bytes));
    expect(identity.imageDisposition).toBe("loaded-volatile");
    expect(usb.imageBytes).toEqual([...bytes]);
    expect(
      usb.calls
        .filter((call) => call.setup.request === 0x12)
        .map((call) => call.length),
    ).toEqual([512, 512, 1]);
    const writes = usb.calls.filter((call) => call.direction === "out");
    expect(writes.map((call) => call.setup.request)).toEqual([
      0x1c, 0x55, 0x02, 0x12, 0x12, 0x12, 0x1c, 0x72,
    ]);
    expect(writes[0]!.bytes).toEqual([0, 0, 0, 0]);
    expect(writes.at(-2)!.bytes).toEqual([0x5e, 0x15, 0x24, 0x16]);
    expect(writes.at(-1)!.bytes).toEqual([0, 0, 0, 0]);
    const allowedIn = new Set([0x15, 0x80, 0x83, 0x1d, 0x22]);
    const allowedOut = new Set([0x1c, 0x55, 0x02, 0x12, 0x72]);
    for (const call of usb.calls)
      expect(call.direction === "in" ? allowedIn : allowedOut).toContain(
        call.setup.request,
      );
    expect(
      usb.calls.some((call) =>
        new Set([0xa0, 0xba, 0x27, 0x29, 0x99, 0x13, 0x14, 0x1e, 0x31]).has(
          call.setup.request,
        ),
      ),
    ).toBe(false);
    expect(loader.diagnostics).toMatchObject({
      state: "ready",
      mutationStarted: true,
      powerCycleRequired: false,
      lastLoaderState: 4,
    });
    await loader.close();
  });

  it.each([0, 1, 2, 6])(
    "rejects unsafe initial FX3 state %i without mutating the device",
    async (state) => {
      const usb = new FakeUsrpB205Usb();
      usb.loaderState = state;
      const loader = connection();
      await expect(loader.open(usb, image())).rejects.toThrow(
        /unsafe initial state/,
      );
      expect(usb.calls.filter((call) => call.direction === "out")).toHaveLength(
        0,
      );
      expect(usb.opened).toBe(false);
    },
  );

  it("waits boundedly for busy state 3 and rejects persistent/unknown state", async () => {
    const busy = new FakeUsrpB205Usb();
    busy.loaderState = 3;
    await expect(connection().open(busy, image())).rejects.toThrow(
      /remained busy/,
    );
    expect(
      busy.calls.filter((call) => call.setup.request === 0x83),
    ).toHaveLength(101);
    const interrupted = new FakeUsrpB205Usb();
    interrupted.loaderState = 3;
    interrupted.stateReads = [3, 5];
    await expect(connection().open(interrupted, image())).rejects.toThrow(
      /left busy state for unsafe state 5/,
    );
    const unknown = new FakeUsrpB205Usb();
    unknown.loaderState = 255;
    await expect(connection().open(unknown, image())).rejects.toThrow(
      /unknown FPGA loader state/,
    );
  });

  it("accepts busy-to-running only after checking the resulting hash", async () => {
    const usb = new FakeUsrpB205Usb();
    usb.loaderState = 4;
    usb.stateReads = [3, 3, 4];
    const result = await connection().open(usb, image());
    expect(result.imageDisposition).toBe("already-compatible");
  });

  it("rejects product, descriptor, firmware and USB-speed mismatches before mutation", async () => {
    const cases: Array<(usb: FakeUsrpB205Usb) => void> = [
      (usb) => {
        usb.productId = 0x0021;
      },
      (usb) => {
        usb.productName = "";
      },
      (usb) => {
        usb.configurations = [];
      },
      (usb) => {
        usb.firmware.major = 7;
      },
      (usb) => {
        usb.usbSpeed = 2;
      },
    ];
    for (const alter of cases) {
      const usb = new FakeUsrpB205Usb();
      alter(usb);
      await expect(connection().open(usb, image())).rejects.toThrow();
      expect(usb.calls.some((call) => call.direction === "out")).toBe(false);
      expect(usb.opened).toBe(false);
    }
  });

  it("verifies the image before opening and rejects short/stalled/short-write/reset transfers", async () => {
    const invalid = new FakeUsrpB205Usb();
    const defaultLoader = new UsrpB205Fx3Connection();
    await expect(
      defaultLoader.open(invalid, image(Uint8Array.of(1))),
    ).rejects.toThrow(/bytes/);
    expect(invalid.lifecycle).toEqual([]);

    const short = new FakeUsrpB205Usb();
    short.inOverride = (setup) =>
      setup.request === 0x15
        ? Promise.resolve({
            status: "ok",
            data: new DataView(new Uint8Array([8]).buffer),
          })
        : undefined;
    await expect(connection().open(short, image())).rejects.toThrow(
      /1\/2 bytes/,
    );

    const stall = new FakeUsrpB205Usb();
    stall.inOverride = (setup) =>
      setup.request === 0x80
        ? Promise.resolve({
            status: "stall",
            data: new DataView(new Uint8Array([3]).buffer),
          })
        : undefined;
    await expect(connection().open(stall, image())).rejects.toThrow(/stall/);

    const write = new FakeUsrpB205Usb();
    write.loaderState = 5;
    write.legacyHash = 0;
    write.outOverride = (setup, bytes) =>
      setup.request === 0x12
        ? Promise.resolve({ status: "ok", bytesWritten: bytes.length - 1 })
        : undefined;
    const writeLoader = connection();
    await expect(writeLoader.open(write, image())).rejects.toThrow(
      /2\/3 bytes.*power-cycle/,
    );
    expect(writeLoader.diagnostics.powerCycleRequired).toBe(true);

    const reset = new FakeUsrpB205Usb();
    reset.outOverride = (setup) =>
      setup.request === 0x72
        ? Promise.resolve({ status: "stall", bytesWritten: 0 })
        : undefined;
    await expect(connection().open(reset, image())).rejects.toThrow(/stall/);
  });

  it("times out a control transfer and closes the device without retrying the request", async () => {
    vi.useFakeTimers();
    const usb = new FakeUsrpB205Usb();
    usb.inOverride = (setup) =>
      setup.request === 0x15 ? stalledIn() : undefined;
    const loader = new UsrpB205Fx3Connection({
      verifyImage: async (value) => value.bytes,
      ep0TimeoutMs: 25,
    });
    const opening = loader.open(usb, image());
    const rejected = expect(opening).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(26);
    await rejected;
    expect(
      usb.calls.filter((call) => call.setup.request === 0x15),
    ).toHaveLength(1);
    expect(usb.opened).toBe(false);
    vi.useRealTimers();
  });

  it("handles chooser cancellation, late permission and late open completion without leaking ownership", async () => {
    const cancelled = connection();
    await expect(
      cancelled.requestAndOpen(image(), {
        requestDevice: () =>
          Promise.reject(new DOMException("cancelled", "NotFoundError")),
      } as USB),
    ).rejects.toMatchObject({ name: "NotFoundError" });

    const grant = deferredUsb<USBDevice>();
    const lateUsb = new FakeUsrpB205Usb();
    const late = connection();
    const opening = late.requestAndOpen(image(), {
      requestDevice: () => grant.promise,
    } as USB);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    const closing = late.close();
    grant.resolve(lateUsb);
    await closing;
    await rejected;
    expect(lateUsb.lifecycle).toEqual([]);

    const gate = deferredUsb<void>();
    const openingUsb = new FakeUsrpB205Usb();
    openingUsb.openGate = gate.promise;
    const openingLoader = connection();
    const pending = openingLoader.open(openingUsb, image());
    await tick();
    const pendingRejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const pendingClose = openingLoader.close();
    gate.resolve();
    await pendingClose;
    await pendingRejected;
    expect(openingUsb.lifecycle).toEqual(["open", "close"]);
  });

  it("cleans partial claims, reports release errors, shares repeated close and retries failed close", async () => {
    const claim = new FakeUsrpB205Usb();
    claim.claimFailures.add(3);
    await expect(connection().open(claim, image())).rejects.toThrow(
      /claim 3 failed/,
    );
    expect(claim.opened).toBe(false);

    const release = new FakeUsrpB205Usb();
    const releaseLoader = connection();
    await releaseLoader.open(release, image());
    release.releaseFailures.add(3);
    await releaseLoader.close();
    expect(release.opened).toBe(false);
    expect(releaseLoader.diagnostics.cleanupErrors).toContain(
      "fixture release 3 failed",
    );

    const retry = new FakeUsrpB205Usb();
    const retryLoader = connection();
    await retryLoader.open(retry, image());
    retry.closeFailures = 1;
    const one = retryLoader.close();
    const two = retryLoader.close();
    expect(one).toBe(two);
    await expect(one).rejects.toThrow(/close failed/);
    expect(retryLoader.diagnostics.state).toBe("cleanup-required");
    await retryLoader.close();
    expect(retryLoader.diagnostics.state).toBe("closed");
    await retryLoader.close();
    expect(retry.lifecycle.filter((value) => value === "close")).toHaveLength(
      2,
    );
  });

  it("closes on unplug and emits only the EP0 allowlist with no persistent/TX operation", async () => {
    const usb = new FakeUsrpB205Usb();
    usb.inOverride = (setup) => {
      if (setup.request === 0x80) {
        usb.disconnected = true;
        return Promise.reject(new DOMException("unplugged", "NetworkError"));
      }
      return undefined;
    };
    await expect(connection().open(usb, image())).rejects.toMatchObject({
      name: "NetworkError",
    });
    const allowedIn = new Set([0x15, 0x80, 0x83, 0x1d, 0x22]);
    const allowedOut = new Set([0x1c, 0x55, 0x02, 0x12, 0x72]);
    for (const call of usb.calls)
      expect(call.direction === "in" ? allowedIn : allowedOut).toContain(
        call.setup.request,
      );
    const forbidden = new Set([
      0xa0, 0xba, 0x27, 0x29, 0x99, 0x13, 0x14, 0x1e, 0x31,
    ]);
    expect(usb.calls.some((call) => forbidden.has(call.setup.request))).toBe(
      false,
    );
  });
});
