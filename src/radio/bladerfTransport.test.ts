import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBladeRfImage } from "./bladerfImages";
import { BladeRfProtocol } from "./bladerfProtocol";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import {
  BladeRfTransport,
  BLADERF_HIGH_RATE_READ_SLOTS,
  BLADERF_READ_SLOTS,
} from "./bladerfTransport";

describe("bladeRF xA4 WebUSB transport", () => {
  it("opens an already-authorized device without a chooser", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();

    await transport.open(device);

    expect(device.opened).toBe(true);
    await transport.close();
  });

  it("requests only 2cf0:5250, streams bounded SC16 slots, and stops RX", async () => {
    const device = new FakeBladeRfUsb();
    const requestDevice = vi.fn(async () => device);
    const transport = new BladeRfTransport();
    await transport.requestAndOpen({ requestDevice } as USB);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: 0x2cf0, productId: 0x5250 }],
    });
    const session = await transport.configure(
      {
        centerFrequencyHz: 100_000_000,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      7,
    );
    const blocks: unknown[] = [];
    await transport.startRx(
      (block) => blocks.push(block),
      (ready) => expect(ready).toEqual(session),
    );
    expect(transport.diagnostics.pendingOperations).toBe(BLADERF_READ_SLOTS);
    device.deliverSamples([-2048, 2047, 0, 1]);
    await Promise.resolve();
    await Promise.resolve();
    expect(blocks).toEqual([
      expect.objectContaining({
        generation: 7,
        encoding: "ci16_le_sc11",
        complexSampleCount: 2,
        firstSampleIndex: 0,
      }),
    ]);
    await transport.stopRx();
    expect(device.lifecycle.slice(-3)).toEqual([
      "rx:off",
      "alternate:0",
      "alternate:1",
    ]);
    await transport.close();
    expect(device.opened).toBe(false);
  });

  it("doubles the bounded USB scheduling window at experimental 19.2 MS/s", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();
    await transport.requestAndOpen({
      requestDevice: async () => device,
    } as USB);
    await transport.configure(
      {
        centerFrequencyHz: 100_000_000,
        sampleRateHz: 19_200_000,
        bandwidthHz: 19_200_000,
      },
      8,
    );
    expect(transport.diagnostics).toMatchObject({
      readSlotsHighWater: BLADERF_HIGH_RATE_READ_SLOTS,
      rawSlotBytesLimit: BLADERF_HIGH_RATE_READ_SLOTS * 65_536,
    });
    await transport.startRx(
      () => undefined,
      () => undefined,
    );
    expect(transport.diagnostics.pendingOperations).toBe(
      BLADERF_HIGH_RATE_READ_SLOTS,
    );
    await transport.stopRx();
    await transport.close();
  });

  it("aborts pending WebUSB reads by resetting the RF-link alternate", async () => {
    const device = new FakeBladeRfUsb();
    device.rxStopSettlesReads = false;
    const transport = new BladeRfTransport();
    await transport.open(device);
    await transport.configure(
      {
        centerFrequencyHz: 178_352_000,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      9,
    );
    await transport.startRx(
      () => undefined,
      () => undefined,
    );

    await transport.stopRx();

    expect(transport.diagnostics.pendingOperations).toBe(0);
    expect(device.lifecycle.slice(-3)).toEqual([
      "rx:off",
      "alternate:0",
      "alternate:1",
    ]);
    await transport.close();
  });
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("bladeRF pending discovery ownership", () => {
  it.each(["stopRx", "close"] as const)(
    "%s invalidates the chooser before device ownership",
    async (cancel) => {
      const chosen = gate<USBDevice>();
      const device = new FakeBladeRfUsb();
      const transport = new BladeRfTransport();
      const opening = transport.requestAndOpen({
        requestDevice: () => chosen.promise,
      } as USB);
      const rejected = expect(opening).rejects.toMatchObject({
        name: "AbortError",
      });
      await transport[cancel]();
      chosen.resolve(device);
      await rejected;
      expect(device.lifecycle).toEqual([]);
      await transport.open(device);
      await transport.close();
    },
  );

  const stages = [
    "open",
    "configuration",
    "claim",
    "ready",
    "firmware",
    "status",
    "flash",
    "cache0",
    "cache64",
    "cache128",
    "cache192",
    "alternate1",
    "version",
    "initialization",
  ] as const;
  it.each(
    stages.flatMap((stage) =>
      (["stopRx", "close"] as const).map((cancel) => ({ stage, cancel })),
    ),
  )(
    "$cancel cancels pending $stage and permits a fresh open",
    async ({ stage, cancel }) => {
      const device = new FakeBladeRfUsb();
      const reached = gate<void>();
      const resume = gate<void>();
      let blocked = false;
      async function pause() {
        if (!blocked) {
          blocked = true;
          reached.resolve();
          await resume.promise;
        }
      }
      for (const method of [
        "open",
        "selectConfiguration",
        "claimInterface",
      ] as const) {
        const original = device[method].bind(device) as (
          ...args: number[]
        ) => Promise<void>;
        const matches =
          (method === "open" && stage === "open") ||
          (method === "selectConfiguration" && stage === "configuration") ||
          (method === "claimInterface" && stage === "claim");
        if (matches)
          Object.assign(device, {
            [method]: async (...args: number[]) => {
              await original(...args);
              await pause();
            },
          });
      }
      const control = device.controlTransferIn.bind(device);
      device.controlTransferIn = async (setup, length) => {
        const result = await control(setup, length);
        const request = { ready: 6, firmware: 0, status: 1, flash: 7 }[
          stage as "ready"
        ];
        if (
          request === setup.request ||
          (stage.startsWith("cache") &&
            setup.request === 110 &&
            setup.index === Number(stage.slice(5)))
        )
          await pause();
        return result;
      };
      const alternate = device.selectAlternateInterface.bind(device);
      device.selectAlternateInterface = async (iface, setting) => {
        await alternate(iface, setting);
        if (stage === "alternate1" && setting === 1) await pause();
      };
      const transfer = device.transferIn.bind(device);
      device.transferIn = async (endpoint, length) => {
        const result = await transfer(endpoint, length);
        if (
          endpoint === 2 &&
          ((stage === "version" &&
            result.data?.getUint8(0) === 0x43 &&
            result.data?.getUint8(1) === 0) ||
            (stage === "initialization" &&
              result.data?.getUint8(0) === 0x45 &&
              result.data?.getUint8(4) === 1))
        )
          await pause();
        return result;
      };
      const transport = new BladeRfTransport();
      const opening = transport.open(device);
      const rejected = expect(opening).rejects.toMatchObject({
        name: "AbortError",
      });
      await reached.promise;
      await transport[cancel]();
      resume.resolve();
      await rejected;
      expect(device.opened).toBe(false);
      expect(
        device.niosRequests.filter((packet) => packet[2]! & 1),
      ).toHaveLength(0);
      expect(device.vendorRequests).not.toContain(2);
      expect(device.lifecycle).not.toContain("rx:on");
      if (
        !(
          ["alternate1", "version", "initialization"] as readonly string[]
        ).includes(stage)
      )
        expect(
          device.lifecycle.some((event) => event.startsWith("alternate:")),
        ).toBe(false);
      await expect(transport.open(device)).resolves.toMatchObject({
        model: "xA4",
      });
      await transport.close();
    },
  );

  it("stale cleanup cannot clear or close a newer device", async () => {
    const stale = new FakeBladeRfUsb();
    const reached = gate<void>();
    const resume = gate<void>();
    const original = stale.open.bind(stale);
    stale.open = async () => {
      await original();
      reached.resolve();
      await resume.promise;
    };
    const transport = new BladeRfTransport();
    const opening = transport.open(stale);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    await reached.promise;
    await transport.close();
    const fresh = new FakeBladeRfUsb();
    fresh.model = "xA9";
    await transport.open(fresh);
    resume.resolve();
    await rejected;
    expect(fresh.opened).toBe(true);
    expect(fresh.lifecycle).not.toContain("close");
    expect(transport.diagnostics.state).toBe("open");
    expect((await transport.open(fresh)).model).toBe("xA9");
    await transport.close();
  });

  it("rejects same-device reuse until a stale open finishes cleanup", async () => {
    const device = new FakeBladeRfUsb();
    const reached = gate<void>();
    const resume = gate<void>();
    const original = device.open.bind(device);
    device.open = async () => {
      await original();
      reached.resolve();
      await resume.promise;
    };
    const transport = new BladeRfTransport();
    const opening = transport.open(device);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    await reached.promise;
    await transport.stopRx();
    await expect(transport.open(device)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    resume.resolve();
    await rejected;
    await expect(transport.open(device)).resolves.toMatchObject({
      model: "xA4",
    });
    await transport.close();
  });
});

describe("bladeRF recoverable cleanup ownership", () => {
  it("does not republish configuration that completes after close", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();
    await transport.open(device);
    const reached = gate<void>();
    const resume = gate<void>();
    const configure = BladeRfProtocol.prototype.configure;
    vi.spyOn(BladeRfProtocol.prototype, "configure").mockImplementation(
      async function (this: BladeRfProtocol, configuration) {
        const details = await configure.call(this, configuration);
        reached.resolve();
        await resume.promise;
        return details;
      },
    );
    const pending = expect(
      transport.configure(
        {
          centerFrequencyHz: 100e6,
          sampleRateHz: 2_400_000,
          bandwidthHz: 2_400_000,
        },
        1,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await reached.promise;
    await transport.close();
    resume.resolve();
    await pending;
    expect(transport.diagnostics.state).toBe("closed");
    await expect(
      transport.startRx(
        () => {},
        () => {},
      ),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("does not restore RF alternate or configured state after close interrupts stop", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();
    await transport.open(device);
    await transport.configure(
      {
        centerFrequencyHz: 100e6,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      1,
    );
    await transport.startRx(
      () => {},
      () => {},
    );
    const reached = gate<void>();
    const resume = gate<void>();
    const alternate = device.selectAlternateInterface.bind(device);
    device.selectAlternateInterface = async (iface, setting) => {
      await alternate(iface, setting);
      if (setting === 0) {
        reached.resolve();
        await resume.promise;
      }
    };
    const pending = expect(transport.stopRx()).rejects.toMatchObject({
      name: "AbortError",
    });
    await reached.promise;
    await transport.close();
    const events = device.lifecycle.length;
    resume.resolve();
    await pending;
    expect(device.lifecycle.slice(events)).not.toContain("alternate:1");
    expect(transport.diagnostics.state).toBe("closed");
  });

  it.each([false, true])(
    "accepts browser-confirmed closure despite rejection after established=%s open",
    async (established) => {
      const device = new FakeBladeRfUsb();
      if (!established) device.calibration = new Uint8Array(256).fill(0xff);
      const close = device.close.bind(device);
      device.close = vi.fn(async () => {
        await close();
        throw new DOMException(
          "closed despite rejected promise",
          "NetworkError",
        );
      });
      const transport = new BladeRfTransport();
      if (established) await transport.open(device);
      else await expect(transport.open(device)).rejects.toThrow(/calibration/);
      await transport.close();
      expect(device.opened).toBe(false);
      expect(transport.diagnostics.state).toBe("closed");
      expect(device.close).toHaveBeenCalledTimes(1);
      device.calibration = undefined;
      expect((await transport.open(device)).model).toBe("xA4");
      await transport.close();
    },
  );

  it("isolates failed stale opening cleanup from the newer published session and drains both devices on retry", async () => {
    const stale = new FakeBladeRfUsb();
    const reached = gate<void>();
    const resume = gate<void>();
    const originalOpen = stale.open.bind(stale);
    stale.open = async () => {
      await originalOpen();
      reached.resolve();
      await resume.promise;
    };
    const originalClose = stale.close.bind(stale);
    stale.close = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("stale close rejected", "NetworkError"),
      )
      .mockImplementation(originalClose);
    const transport = new BladeRfTransport();
    const pending = transport.open(stale);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await reached.promise;
    await transport.close();
    const fresh = new FakeBladeRfUsb();
    fresh.model = "xA9";
    await transport.open(fresh);
    resume.resolve();
    await rejected;
    expect(stale.opened).toBe(true);
    expect(fresh.opened).toBe(true);
    expect(fresh.lifecycle).not.toContain("close");
    await expect(transport.open(fresh)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await transport.close();
    expect(stale.close).toHaveBeenCalledTimes(2);
    expect(stale.opened).toBe(false);
    expect(fresh.opened).toBe(false);
    expect((await transport.open(fresh)).model).toBe("xA9");
    await transport.close();
  });

  it("bounds retained stalled openings and recovers every admitted device without touching a rejected device", async () => {
    const transport = new BladeRfTransport();
    const resume = gate<void>();
    const devices: FakeBladeRfUsb[] = [];
    const rejected: Promise<void>[] = [];
    for (let index = 0; index < 8; ++index) {
      const device = new FakeBladeRfUsb();
      devices.push(device);
      const reached = gate<void>();
      const open = device.open.bind(device);
      device.open = async () => {
        await open();
        reached.resolve();
        await resume.promise;
      };
      rejected.push(
        expect(transport.open(device)).rejects.toMatchObject({
          name: "AbortError",
        }),
      );
      await reached.promise;
      await transport.stopRx();
    }
    const excess = new FakeBladeRfUsb();
    await expect(transport.open(excess)).rejects.toThrow(/Too many/);
    expect(excess.lifecycle).toEqual([]);
    resume.resolve();
    await Promise.all(rejected);
    expect(devices.every((device) => !device.opened)).toBe(true);
    await transport.open(excess);
    await transport.close();
  });
});

describe("bladeRF programming cancellation", () => {
  afterEach(() => vi.restoreAllMocks());
  function imageDigest() {
    const image = selectBladeRfImage("xA4", { major: 2, minor: 5 });
    return Uint8Array.from(image.sha256.match(/../g)!, (hex) =>
      parseInt(hex, 16),
    ).buffer;
  }
  function emptyDevice() {
    const device = new FakeBladeRfUsb();
    device.fpgaConfigured = false;
    device.firmware = { major: 2, minor: 5 };
    device.fpga = { major: 0, minor: 16, patch: 0 };
    return device;
  }
  it.each(["Verifying saved", "Loading hosted"])(
    "synchronous %s status cancellation prevents alternate 3 and BEGIN",
    async (prefix) => {
      vi.spyOn(crypto.subtle, "digest").mockResolvedValue(imageDigest());
      const device = emptyDevice();
      const loadImage = vi.fn(
        async (image: { byteLength: number }) =>
          new Uint8Array(image.byteLength),
      );
      const transport = new BladeRfTransport({
        loadImage,
        statusChanged: (message) => {
          if (message.startsWith(prefix)) void transport.stopRx();
        },
      });
      await expect(transport.open(device)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(device.lifecycle).not.toContain("alternate:3");
      expect(device.vendorRequests).not.toContain(2);
      expect(device.niosRequests).toHaveLength(0);
      expect(device.opened).toBe(false);
      if (prefix === "Verifying saved")
        expect(loadImage).not.toHaveBeenCalled();
    },
  );

  it.each([
    "provider",
    "digest",
    "alternate",
    "begin",
    "upload",
    "poll",
  ] as const)(
    "cancels pending %s and reports dispatched programming honestly",
    async (stage) => {
      const device = emptyDevice();
      const reached = gate<void>();
      const resume = gate<void>();
      async function pause() {
        reached.resolve();
        await resume.promise;
      }
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
        if (stage === "digest") await pause();
        return imageDigest();
      });
      const alternate = device.selectAlternateInterface.bind(device);
      device.selectAlternateInterface = async (iface, setting) => {
        await alternate(iface, setting);
        if (stage === "alternate" && setting === 3) await pause();
      };
      const control = device.controlTransferIn.bind(device);
      device.controlTransferIn = async (setup, length) => {
        const result = await control(setup, length);
        if (
          (stage === "begin" && setup.request === 2) ||
          (stage === "poll" &&
            setup.request === 1 &&
            device.currentAlternate === 3)
        )
          await pause();
        return result;
      };
      const transfer = device.transferOut.bind(device);
      device.transferOut = async (endpoint, bytes) => {
        const result = await transfer(endpoint, bytes);
        if (stage === "upload" && device.currentAlternate === 3) await pause();
        return result;
      };
      const transport = new BladeRfTransport({
        loadImage: async (image) => {
          if (stage === "provider") await pause();
          return new Uint8Array(image.byteLength);
        },
      });
      const opening = transport.open(device);
      const rejected = expect(opening).rejects.toMatchObject({
        name: "AbortError",
        ...(["begin", "upload", "poll"].includes(stage)
          ? {
              message: expect.stringContaining(
                "Volatile FPGA state may have changed",
              ),
            }
          : {}),
      });
      await reached.promise;
      await transport.close();
      resume.resolve();
      await rejected;
      expect(device.opened).toBe(false);
      expect(
        device.niosRequests.filter((packet) => packet[2]! & 1),
      ).toHaveLength(0);
      expect(device.lifecycle).not.toContain("rx:on");
      if (["provider", "digest", "alternate"].includes(stage))
        expect(device.vendorRequests).not.toContain(2);
      if (["provider", "digest"].includes(stage))
        expect(device.lifecycle).not.toContain("alternate:3");
    },
  );

  it("reports volatile mutation when BEGIN rejects after cancellation", async () => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(imageDigest());
    const device = emptyDevice();
    const control = device.controlTransferIn.bind(device);
    const transport = new BladeRfTransport({
      loadImage: async (image) => new Uint8Array(image.byteLength),
    });
    device.controlTransferIn = async (setup, length) => {
      if (setup.request === 2) {
        await transport.stopRx();
        throw new DOMException("BEGIN rejected", "NetworkError");
      }
      return control(setup, length);
    };
    await expect(transport.open(device)).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("Volatile FPGA state may have changed"),
    });
    expect(
      device.lifecycle.some((event) => event.startsWith("fpga:write:")),
    ).toBe(false);
    expect(device.niosRequests).toHaveLength(0);
  });
});
