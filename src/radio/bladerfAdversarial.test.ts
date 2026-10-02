import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import { BLADERF_HOSTED_IMAGES, selectBladeRfImage } from "./bladerfImages";
import { BladeRfProtocol } from "./bladerfProtocol";
import { BladeRfTransport, type BladeRfNativeBlock } from "./bladerfTransport";
import { BladeRfSampleAdapter } from "./bladerfSource";

const models = ["xA4", "xA5", "xA9"] as const;
const firmwareMatrix = models.flatMap((model) =>
  [4, 5, 6].map((minor) => ({ model, minor })),
);
const vectors = JSON.parse(
  readFileSync(
    "docs/implementation/bladerf-variants/WIRE-VECTORS.json",
    "utf8",
  ),
) as { pages: { name: string; hex: string }[] };

async function prepared(
  model: (typeof models)[number],
  minor = 5,
  configured = true,
) {
  const usb = new FakeBladeRfUsb();
  usb.model = model;
  usb.firmware = { major: 2, minor };
  usb.fpga =
    minor === 4
      ? { major: 0, minor: 15, patch: 3 }
      : { major: 0, minor: 16, patch: 0 };
  usb.fpgaConfigured = configured;
  await usb.open();
  await usb.selectConfiguration(1);
  await usb.claimInterface(0);
  return usb;
}
function forbiddenWritesAbsent(usb: FakeBladeRfUsb) {
  // The inspected receive-only contract allows only these vendor IN requests.
  expect(
    usb.vendorRequests.every((request) =>
      [0, 1, 2, 4, 6, 7, 110].includes(request),
    ),
  ).toBe(true);
  expect(usb.controlOutRequests).toEqual([]);
  expect(usb.lifecycle).not.toContain("alternate:2");
  const writes = usb.niosRequests.filter((p) => p[0] === 0x45 && p[2]! & 1);
  expect(writes.every((p) => [0, 2, 15].includes(p[5]!))).toBe(true);
}
function noMutations(usb: FakeBladeRfUsb) {
  forbiddenWritesAbsent(usb);
  expect(usb.lifecycle.some((event) => event.startsWith("alternate:"))).toBe(
    false,
  );
  expect(usb.vendorRequests).not.toContain(2);
  expect(usb.niosRequests).toEqual([]);
  expect(usb.lifecycle).not.toContain("rx:on");
}
function noRficWrites(usb: FakeBladeRfUsb) {
  forbiddenWritesAbsent(usb);
  expect(usb.niosRequests.filter((p) => p[2]! & 1)).toEqual([]);
  expect(usb.lifecycle).not.toContain("rx:on");
}
// Deliberately isolated OFFLINE digest mock. These tests check error ordering and
// timing, while real SHA rejection and opt-in real artifacts are tested elsewhere.
function offlineImage(usb: FakeBladeRfUsb) {
  const image = selectBladeRfImage(usb.model, usb.firmware);
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
    Uint8Array.from(image.sha256.match(/../g)!, (hex) => parseInt(hex, 16))
      .buffer,
  );
  return async () => new Uint8Array(image.byteLength);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bladeRF adversarial configured release boundaries", () => {
  it.each(
    models.flatMap((model) => [0, 1, 2].map((patch) => ({ model, patch }))),
  )(
    "accepts legacy configured $model 0.15.$patch on firmware 2.4 with unknown provenance",
    async ({ model, patch }) => {
      const usb = await prepared(model, 4);
      usb.fpga.patch = patch;
      expect(await new BladeRfProtocol(usb).open()).toMatchObject({
        model,
        volatileImage: null,
        fpga: { patch },
      });
      forbiddenWritesAbsent(usb);
      expect(usb.vendorRequests).not.toContain(2);
    },
  );
  it.each(
    firmwareMatrix.flatMap((row) =>
      [
        { major: 1, minor: 16, patch: 0 },
        { major: 0, minor: 16, patch: 1 },
        { major: 0, minor: 15, patch: 4 },
        row.minor === 4
          ? { major: 0, minor: 16, patch: 0 }
          : { major: 0, minor: 15, patch: 3 },
      ].map((fpga) => ({ ...row, fpga })),
    ),
  )(
    "rejects $model firmware 2.$minor incompatible configured $fpga without provider/programming",
    async ({ model, minor, fpga }) => {
      const usb = await prepared(model, minor);
      usb.fpga = fpga;
      const loadImage = vi.fn();
      await expect(
        new BladeRfProtocol(usb, { loadImage }).open(),
      ).rejects.toThrow(/pinned receive profile/);
      expect(loadImage).not.toHaveBeenCalled();
      expect(usb.vendorRequests).not.toContain(2);
      noRficWrites(usb);
    },
  );
  it.each(
    models.flatMap((model) =>
      [true, false].flatMap((configured) =>
        [
          { major: 2, minor: 3 },
          { major: 1, minor: 9 },
          { major: 3, minor: 0 },
        ].map((firmware) => ({ model, configured, firmware })),
      ),
    ),
  )(
    "rejects unsupported $firmware for $model configured=$configured before detection/mutation",
    async ({ model, configured, firmware }) => {
      const usb = await prepared(model, 5, configured);
      usb.firmware = firmware;
      await expect(new BladeRfProtocol(usb).open()).rejects.toThrow(
        /requires supported firmware/,
      );
      expect(usb.vendorRequests).toEqual([6, 0]);
      noMutations(usb);
    },
  );
});

describe("bladeRF identity failures at the integration boundary", () => {
  it.each(
    ["unknown_a0", "contradictory_b", "bad_crc_after_b"].flatMap((name) =>
      [true, false].map((configured) => ({ name, configured })),
    ),
  )(
    "rejects independent $name page configured=$configured before image provider or USB mutations",
    async ({ name, configured }) => {
      const usb = await prepared("xA9", 5, configured);
      const hex = vectors.pages.find((page) => page.name === name)!.hex;
      usb.calibration = Uint8Array.from(hex.match(/../g)!, (byte) =>
        parseInt(byte, 16),
      );
      const loadImage = vi.fn();
      await expect(
        new BladeRfProtocol(usb, { loadImage }).open(),
      ).rejects.toThrow();
      expect(loadImage).not.toHaveBeenCalled();
      noMutations(usb);
    },
  );
  it.each(["short", "stall", "reject"] as const)(
    "propagates %s cache read through transport cleanup without programming",
    async (failure) => {
      const usb = new FakeBladeRfUsb();
      usb.fpgaConfigured = false;
      const read = usb.controlTransferIn.bind(usb);
      usb.controlTransferIn = async (setup, length) => {
        const result = await read(setup, length);
        if (setup.request === 110 && setup.index === 128) {
          if (failure === "reject")
            throw new DOMException("cache rejected", "NetworkError");
          return failure === "short"
            ? { status: "ok", data: new DataView(new ArrayBuffer(63)) }
            : { status: "stall" };
        }
        return result;
      };
      const loadImage = vi.fn();
      await expect(
        new BladeRfTransport({ loadImage }).open(usb),
      ).rejects.toThrow();
      expect(loadImage).not.toHaveBeenCalled();
      expect(usb.opened).toBe(false);
      noMutations(usb);
    },
  );
});

describe("bladeRF programming acknowledgement and service failures", () => {
  it.each(["nonzero", "negative", "short", "stall", "reject"] as const)(
    "rejects %s BEGIN acknowledgement and never uploads/initializes/retries",
    async (failure) => {
      const usb = await prepared("xA9", 5, false);
      const loadImage = offlineImage(usb);
      const read = usb.controlTransferIn.bind(usb);
      usb.controlTransferIn = async (setup, length) => {
        const result = await read(setup, length);
        if (setup.request === 2) {
          if (failure === "reject")
            throw new DOMException("BEGIN rejected", "NetworkError");
          if (failure === "short")
            return { status: "ok", data: new DataView(new ArrayBuffer(3)) };
          if (failure === "stall") return { status: "stall" };
          result.data!.setInt32(0, failure === "negative" ? -1 : 1, true);
        }
        return result;
      };
      await expect(
        new BladeRfProtocol(usb, { loadImage }).open(),
      ).rejects.toThrow(/Volatile FPGA state may have changed/);
      expect(usb.vendorRequests.filter((r) => r === 2)).toHaveLength(1);
      expect(
        usb.lifecycle.some((entry) => entry.startsWith("fpga:write:")),
      ).toBe(false);
      noRficWrites(usb);
    },
  );
  it.each(["magic", "target", "write-bit", "success-bit", "address"] as const)(
    "rejects malformed configured RFIC service %s before initialization",
    async (failure) => {
      const usb = await prepared("xA5");
      const read = usb.transferIn.bind(usb);
      usb.transferIn = async (endpoint, length) => {
        const result = await read(endpoint, length);
        const data = result.data!;
        if (
          data.getUint8(0) === 0x45 &&
          data.getUint8(4) === 0 &&
          data.getUint8(5) === 15
        ) {
          const offset =
            failure === "magic"
              ? 0
              : failure === "target"
                ? 1
                : failure === "address"
                  ? 5
                  : 2;
          data.setUint8(
            offset,
            data.getUint8(offset) ^ (failure === "success-bit" ? 2 : 1),
          );
        }
        return result;
      };
      await expect(new BladeRfProtocol(usb).open()).rejects.toThrow(
        /RFIC command response/,
      );
      noRficWrites(usb);
    },
  );
  it("bounds polling to ten status requests and preserves TimeoutError without RF writes (offline digest)", async () => {
    vi.useFakeTimers();
    const usb = await prepared("xA9", 5, false);
    const loadImage = offlineImage(usb);
    const read = usb.controlTransferIn.bind(usb);
    usb.controlTransferIn = async (setup, length) => {
      const result = await read(setup, length);
      if (setup.request === 1 && usb.currentAlternate === 3)
        result.data!.setInt32(0, 0, true);
      return result;
    };
    const assertion = expect(
      new BladeRfProtocol(usb, { loadImage }).open(),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("Volatile FPGA state may have changed"),
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(usb.vendorRequests.filter((r) => r === 1)).toHaveLength(13); // discovery twice + final pre-load + ten polls
    expect(usb.vendorRequests.filter((r) => r === 2)).toHaveLength(1);
    noRficWrites(usb);
  });
  it("cancels during the 200ms polling delay before the next status query (offline digest)", async () => {
    vi.useFakeTimers();
    const usb = await prepared("xA9", 5, false);
    const loadImage = offlineImage(usb);
    let polled = false;
    const read = usb.controlTransferIn.bind(usb);
    usb.controlTransferIn = async (setup, length) => {
      const result = await read(setup, length);
      if (setup.request === 1 && usb.currentAlternate === 3) {
        polled = true;
        result.data!.setInt32(0, 0, true);
      }
      return result;
    };
    let cancelled = false;
    const assertion = expect(
      new BladeRfProtocol(usb, {
        loadImage,
        checkCurrent: () => {
          if (cancelled) throw new DOMException("cancelled", "AbortError");
        },
      }).open(),
    ).rejects.toMatchObject({ name: "AbortError" });
    for (let turn = 0; turn < 100 && !polled; turn++) await Promise.resolve();
    expect(polled).toBe(true);
    // Let the first poll settle and install its delay before invalidating.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(usb.vendorRequests.filter((r) => r === 1)).toHaveLength(4);
    noRficWrites(usb);
  });
  it.each(["provider", "digest"] as const)(
    "propagates rejected %s before alternate selection",
    async (stage) => {
      const usb = await prepared("xA5", 5, false);
      const failure = new DOMException(`${stage} rejected`, "OperationError");
      if (stage === "digest")
        vi.spyOn(crypto.subtle, "digest").mockRejectedValue(failure);
      await expect(
        new BladeRfProtocol(usb, {
          loadImage: async (image) => {
            if (stage === "provider") throw failure;
            return new Uint8Array(image.byteLength);
          },
        }).open(),
      ).rejects.toBe(failure);
      noMutations(usb);
    },
  );
});

it("rejects provider catalog hash mutation with native SHA before any programming mutation", async () => {
  const usb = new FakeBladeRfUsb();
  usb.fpgaConfigured = false;
  const transport = new BladeRfTransport({
    loadImage: async (image) => {
      const bytes = new Uint8Array(image.byteLength);
      const hash = Buffer.from(
        await crypto.subtle.digest("SHA-256", bytes),
      ).toString("hex");
      const exported = BLADERF_HOSTED_IMAGES.find(
        (candidate) => candidate.sha256 === image.sha256,
      )!;
      expect(Reflect.set(exported, "sha256", hash)).toBe(false);
      return bytes;
    },
  });
  await expect(transport.open(usb)).rejects.toThrow(/SHA-256/);
  expect(usb.opened).toBe(false);
  noMutations(usb);
});

// Failed USB close retains ownership until explicit cleanup succeeds.
it("retains a still-open device after rejected close so retry actually closes it", async () => {
  const usb = new FakeBladeRfUsb();
  const close = usb.close.bind(usb);
  const error = new DOMException("USB close rejected", "NetworkError");
  usb.close = vi.fn().mockRejectedValueOnce(error).mockImplementation(close);
  const transport = new BladeRfTransport();
  await transport.open(usb);
  await expect(transport.close()).rejects.toBe(error);
  expect(usb.opened).toBe(true);
  expect(transport.diagnostics.state).toBe("closing");
  await expect(transport.open(usb)).rejects.toMatchObject({
    name: "InvalidStateError",
  });
  await expect(
    transport.configure(
      {
        centerFrequencyHz: 100e6,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      1,
    ),
  ).rejects.toMatchObject({ name: "InvalidStateError" });
  await expect(
    transport.startRx(
      () => {},
      () => {},
    ),
  ).rejects.toMatchObject({ name: "InvalidStateError" });
  await transport.close();
  expect(usb.close).toHaveBeenCalledTimes(2);
  expect(usb.opened).toBe(false);
  usb.model = "xA9";
  expect((await transport.open(usb)).model).toBe("xA9");
  await transport.close();
});

it("blocks same-device reuse after failed opening cleanup until USB close succeeds", async () => {
  const usb = new FakeBladeRfUsb();
  usb.calibration = new Uint8Array(256).fill(0xff);
  usb.releaseInterface = vi
    .fn()
    .mockRejectedValue(new DOMException("release rejected", "NetworkError"));
  usb.close = vi
    .fn()
    .mockRejectedValue(new DOMException("close rejected", "NetworkError"));
  const claim = vi.spyOn(usb, "claimInterface");
  const transport = new BladeRfTransport();
  await expect(transport.open(usb)).rejects.toThrow();
  expect(usb.opened).toBe(true);
  const claims = claim.mock.calls.length;
  await expect(transport.open(usb)).rejects.toThrow();
  expect(claim).toHaveBeenCalledTimes(claims);
  await expect(transport.close()).rejects.toThrow(/close rejected/);
  expect(transport.diagnostics.state).toBe("closing");
  expect(usb.close).toHaveBeenCalledTimes(2);
  await expect(transport.open(new FakeBladeRfUsb())).rejects.toMatchObject({
    name: "InvalidStateError",
  });
  usb.close = vi.fn(FakeBladeRfUsb.prototype.close.bind(usb));
  await transport.close(); // Release still rejects, but confirmed close releases ownership.
  expect(usb.opened).toBe(false);
  expect(transport.diagnostics.state).toBe("closed");
  usb.calibration = undefined;
  usb.model = "xA5";
  expect((await transport.open(usb)).model).toBe("xA5");
  await transport.close();
});

it("reconnects a loaded FPGA without reloading or retaining session digest provenance (offline digest)", async () => {
  const usb = new FakeBladeRfUsb();
  usb.model = "xA9";
  usb.fpgaConfigured = false;
  const provider = vi.fn(offlineImage(usb));
  const transport = new BladeRfTransport({ loadImage: provider });
  expect((await transport.open(usb)).volatileImage).toMatchObject({
    model: "xA9",
  });
  await transport.close();
  expect((await transport.open(usb)).volatileImage).toBeNull();
  expect(provider).toHaveBeenCalledTimes(1);
  expect(usb.vendorRequests.filter((r) => r === 2)).toHaveLength(1);
  forbiddenWritesAbsent(usb);
  await transport.close();
});

it("drops old sample generations across rate changes and reset without relabelling their source", async () => {
  const usb = await prepared("xA5");
  const protocol = new BladeRfProtocol(usb);
  await protocol.open();
  const details = await protocol.configure({
    centerFrequencyHz: 100e6,
    sampleRateHz: 2_400_000,
    bandwidthHz: 2_400_000,
  });
  const receiveSc16 = vi.fn(() => true);
  const adapter = new BladeRfSampleAdapter({
    setSampleRate: vi.fn(),
    receiveSamples: vi.fn(),
    receiveSc16,
  });
  const block: BladeRfNativeBlock = {
    bytes: Uint8Array.of(0, 4, 0, 252),
    encoding: "ci16_le_sc11",
    sampleOrder: "interleaved-iq",
    bytesPerComplexSample: 4,
    complexSampleCount: 1,
    nativeSampleRateHz: 2_400_000,
    generation: 7,
    sequence: 0,
    firstSampleIndex: 0,
    receivedAtMonotonicMs: 0,
  };
  adapter.ready({ generation: 7, hardwareCenterFrequencyHz: 100e6, details });
  adapter.receive(block);
  expect(receiveSc16).toHaveBeenCalledTimes(1);
  adapter.ready({
    generation: 8,
    hardwareCenterFrequencyHz: 101e6,
    details: { ...details, nativeSampleRateHz: 4_800_000 },
  });
  adapter.receive(block);
  expect(receiveSc16).toHaveBeenCalledTimes(1);
  expect(block.generation).toBe(7);
  adapter.receive({ ...block, generation: 8, nativeSampleRateHz: 4_800_000 });
  expect(receiveSc16).toHaveBeenLastCalledWith(block.bytes, 101e6);
  adapter.reset();
  adapter.receive({ ...block, generation: 8, nativeSampleRateHz: 4_800_000 });
  expect(receiveSc16).toHaveBeenCalledTimes(2);
});

it.skipIf(!process.env.BLADERF_OFFICIAL_ARTIFACT_DIR).each(models)(
  "rejects actual wrong-release %s bytes of matching length before alternate 3",
  async (model) => {
    const usb = await prepared(model, 5, false);
    const wrongRelease = selectBladeRfImage(model, { major: 2, minor: 4 });
    const bytes = Uint8Array.from(
      readFileSync(
        `${process.env.BLADERF_OFFICIAL_ARTIFACT_DIR}/${wrongRelease.filename}`,
      ),
    );
    await expect(
      new BladeRfProtocol(usb, { loadImage: async () => bytes }).open(),
    ).rejects.toThrow(/SHA-256 mismatch/);
    noMutations(usb);
  },
);
