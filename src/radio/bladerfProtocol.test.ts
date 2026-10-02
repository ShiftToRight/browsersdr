import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { selectBladeRfImage } from "./bladerfImages";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import {
  BLADERF_PROTOCOL_PROFILE,
  BladeRfProtocol,
  packBladeRfRficRequest,
  unpackBladeRfRficResponse,
} from "./bladerfProtocol";

// Offline success tests mock only SHA-256. Real digest rejections and optional
// downloaded official-artifact success tests below retain the production verifier.
function mockOfficialDigest(model: "xA4" | "xA5" | "xA9", minor: number) {
  const image = selectBladeRfImage(model, { major: 2, minor });
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
    Uint8Array.from(image.sha256.match(/../g)!, (hex) =>
      Number.parseInt(hex, 16),
    ).buffer,
  );
}
afterEach(() => vi.restoreAllMocks());

describe("bladeRF xA4 protocol", () => {
  it("packs the public NIOS 16x64 RFIC format byte-for-byte", () => {
    const packet = packBladeRfRficRequest(true, 4, 0, 100_000_000n);
    expect([...packet]).toEqual([
      0x45, 0x01, 0x01, 0, 4, 0, 0, 0xe1, 0xf5, 5, 0, 0, 0, 0, 0, 0,
    ]);
    const response = Uint8Array.from(packet);
    response[2] = response[2]! | 2;
    expect(unpackBladeRfRficResponse(response, true, 4, 0)).toBe(100_000_000n);
  });

  it("discovers pinned firmware/gateware and configures RX0 without TX or flashing", async () => {
    const usb = new FakeBladeRfUsb();
    await usb.open();
    await usb.selectConfiguration(1);
    await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb);
    const identity = await protocol.open();
    expect(identity).toMatchObject({
      kind: "bladerf-2-micro-xa4",
      firmware: { major: 2, minor: 4 },
      fpga: { major: 0, minor: 15, patch: 3 },
    });
    const details = await protocol.configure({
      centerFrequencyHz: 109_000_000,
      sampleRateHz: 19_200_000,
      bandwidthHz: 19_200_000,
    });
    expect(details).toMatchObject({
      protocolProfile: BLADERF_PROTOCOL_PROFILE,
      nativeEncoding: "ci16_le_sc11",
      nativeSampleRateHz: 19_200_000,
      acceptedSampleRateHz: 19_200_000,
      effectiveSampleRateHz: 2_400_000,
      acceptedCenterFrequencyHz: 109_000_000,
      gainMode: "slow-attack-agc",
    });
    await protocol.setRxEnabled(true);
    await protocol.setRxEnabled(false);
    expect(usb.vendorRequests).not.toContain(5); // firmware TX command
    expect(usb.lifecycle).toContain("rx:on");
    expect(usb.lifecycle).toContain("rx:off");
  });

  it("loads the firmware-compatible hostedxA4 image into volatile RAM when the FPGA is empty", async () => {
    const missing = new FakeBladeRfUsb();
    missing.fpgaConfigured = false;
    await missing.open();
    await missing.selectConfiguration(1);
    await missing.claimInterface(0);
    mockOfficialDigest("xA4", 4);
    const statuses: string[] = [];
    const protocol = new BladeRfProtocol(missing, {
      loadImage: async (image) => {
        expect(image).toMatchObject({
          model: "xA4",
          version: "0.15.3",
          byteLength: 2_632_660,
        });
        return new Uint8Array(image.byteLength);
      },
      statusChanged: (message) => statuses.push(message),
    });
    await expect(protocol.open()).resolves.toMatchObject({
      fpga: { major: 0, minor: 15, patch: 3 },
      volatileImage: { model: "xA4", version: "0.15.3" },
    });
    expect(missing.lifecycle).toContain("alternate:3");
    expect(missing.lifecycle).toContain("fpga:begin");
    expect(missing.lifecycle).toContain("fpga:write:2632660");
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Verifying/),
        expect.stringMatching(/volatile FPGA RAM/),
        expect.stringMatching(/verifying the hosted profile/),
      ]),
    );
    expect(missing.vendorRequests).not.toContain(5);
  });

  it("rejects an invalid imported image before beginning FPGA programming", async () => {
    const missing = new FakeBladeRfUsb();
    missing.fpgaConfigured = false;
    await missing.open();
    await missing.selectConfiguration(1);
    await missing.claimInterface(0);
    await expect(
      new BladeRfProtocol(missing, {
        loadImage: async () => new Uint8Array(16),
      }).open(),
    ).rejects.toThrow(/requires.*bytes/i);
    expect(missing.lifecycle).not.toContain("alternate:3");
    expect(missing.lifecycle).not.toContain("fpga:begin");
  });

  it("loads hostedxA4 0.16.0 for firmware 2.5 and newer", async () => {
    const usb = new FakeBladeRfUsb();
    usb.fpgaConfigured = false;
    usb.firmware = { major: 2, minor: 6 };
    usb.fpga = { major: 0, minor: 16, patch: 0 };
    await usb.open();
    await usb.selectConfiguration(1);
    await usb.claimInterface(0);
    mockOfficialDigest("xA4", 6);
    const identity = await new BladeRfProtocol(usb, {
      loadImage: async (image) => {
        expect(image).toMatchObject({ model: "xA4", version: "0.16.0" });
        return new Uint8Array(image.byteLength);
      },
    }).open();
    expect(identity).toMatchObject({
      firmware: { major: 2, minor: 6 },
      fpga: { major: 0, minor: 16, patch: 0 },
      volatileImage: { version: "0.16.0" },
    });
  });

  it("accepts and records small AD9361 rate and LO quantization", async () => {
    const usb = new FakeBladeRfUsb();
    usb.sampleRateReadbackOffset = -7;
    usb.frequencyReadbackOffset = 2;
    await usb.open();
    await usb.selectConfiguration(1);
    await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb);
    await protocol.open();
    await expect(
      protocol.configure({
        centerFrequencyHz: 100_000_000,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      }),
    ).resolves.toMatchObject({
      nativeSampleRateHz: 2_400_000,
      acceptedSampleRateHz: 2_399_993,
      requestedCenterFrequencyHz: 100_000_000,
      acceptedCenterFrequencyHz: 100_000_002,
    });
  });

  it("rejects unpinned configured gateware without enabling RX or TX", async () => {
    const old = new FakeBladeRfUsb();
    old.fpga = { major: 0, minor: 14, patch: 0 };
    await old.open();
    await old.selectConfiguration(1);
    await old.claimInterface(0);
    await expect(new BladeRfProtocol(old).open()).rejects.toThrow(
      /pinned receive profile/i,
    );
    expect(old.vendorRequests).not.toContain(5);
  });
});

describe("bladeRF gain and antenna control", () => {
  async function open() {
    const usb = new FakeBladeRfUsb();
    await usb.open();
    await usb.selectConfiguration(1);
    await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb);
    await protocol.open();
    return { usb, protocol };
  }
  const configuration = {
    centerFrequencyHz: 100_000_000,
    sampleRateHz: 2_400_000 as const,
    bandwidthHz: 2_400_000,
  };
  it.each([
    [100e6, -16, 1],
    [2e9, -15, -4],
    [5e9, -12, -10],
    [100e6, 30, 47],
  ])(
    "maps %s Hz / %s dB to signed native gain %s",
    async (frequency, gain, raw) => {
      const { usb, protocol } = await open();
      const details = await protocol.configure({
        ...configuration,
        centerFrequencyHz: frequency,
        rxSettings: {
          kind: "bladerf",
          rxInput: "RX1",
          gainMode: "manual",
          manualGainDb: gain,
        },
      });
      expect(usb.rfic.get(0x0007)).toBe(BigInt.asUintN(64, BigInt(raw)));
      expect(details).toMatchObject({
        gainMode: "manual",
        requestedGainDb: gain,
        acceptedGainDb: gain,
        rxInput: "RX1",
      });
    },
  );
  it.each(["slow-attack-agc", "fast-attack-agc", "hybrid-agc"] as const)(
    "reads back %s without reporting fixed gain",
    async (gainMode) => {
      const { usb, protocol } = await open();
      const details = await protocol.configure({
        ...configuration,
        rxSettings: {
          kind: "bladerf",
          rxInput: "RX1",
          gainMode,
          manualGainDb: 30,
        },
      });
      expect(details).toMatchObject({
        gainMode,
        requestedGainDb: null,
        acceptedGainDb: null,
      });
      expect(
        usb.niosRequests.some((p) => p[0] === 0x45 && p[4] === 7 && p[2]! & 1),
      ).toBe(false);
    },
  );
  it("switches single-channel RX1 → RX2 → RX1, disabling the other chain and never addressing TX", async () => {
    const { usb, protocol } = await open();
    for (const rxInput of ["RX1", "RX2", "RX1"] as const) {
      await protocol.configure({
        ...configuration,
        rxSettings: {
          kind: "bladerf",
          rxInput,
          gainMode: "manual",
          manualGainDb: 20,
        },
      });
      await protocol.setRxEnabled(true);
      expect(usb.rfic.get(0x0002)).toBe(rxInput === "RX1" ? 1n : 0n);
      expect(usb.rfic.get(0x0202)).toBe(rxInput === "RX2" ? 1n : 0n);
      expect(usb.rfic.get(rxInput === "RX1" ? 0x0007 : 0x0207)).toBe(37n);
      await protocol.setRxEnabled(false);
    }
    expect(usb.rfic.get(0x0002)).toBe(0n);
    expect(usb.rfic.get(0x0202)).toBe(0n);
    expect(usb.vendorRequests).not.toContain(5);
    expect(
      usb.niosRequests
        .filter((p) => p[0] === 0x45)
        .every((p) => [0, 2, 15].includes(p[5]!)),
    ).toBe(true);
  });
  it("rejects bad settings before RF writes and rejects gain mode/readback mismatch", async () => {
    const { usb, protocol } = await open();
    const count = usb.niosRequests.length;
    await expect(
      protocol.configure({
        ...configuration,
        rxSettings: {
          kind: "bladerf",
          rxInput: "RX1",
          gainMode: "manual",
          manualGainDb: 100,
        },
      }),
    ).rejects.toThrow(/Invalid bladeRF/);
    expect(usb.niosRequests).toHaveLength(count);
    const read = usb.transferIn.bind(usb);
    usb.transferIn = async (endpoint, length) => {
      const result = await read(endpoint, length);
      if (
        endpoint === 2 &&
        result.data?.getUint8(0) === 0x45 &&
        result.data.getUint8(4) === 6 &&
        !(result.data.getUint8(2) & 1)
      )
        result.data.setBigUint64(6, 99n, true);
      return result;
    };
    await expect(protocol.configure(configuration)).rejects.toThrow(
      /mode readback/,
    );
  });
});

describe("bladeRF manual gain settling", () => {
  it.each([false, true])(
    "requires an enabled RX chain for gain evidence and cleans up on mismatch=%s",
    async (mismatch) => {
      const usb = new FakeBladeRfUsb();
      await usb.open();
      await usb.selectConfiguration(1);
      await usb.claimInterface(0);
      const protocol = new BladeRfProtocol(usb);
      await protocol.open();
      const read = usb.transferIn.bind(usb);
      let reads = 0;
      usb.transferIn = async (endpoint, length) => {
        const result = await read(endpoint, length);
        if (
          endpoint === 2 &&
          result.data?.getUint8(0) === 0x45 &&
          result.data.getUint8(4) === 7 &&
          !(result.data.getUint8(2) & 1)
        ) {
          reads++;
          expect(usb.rfic.get(2)).toBe(0n);
          expect(usb.rfic.get(0x202)).toBe(1n);
          if (mismatch || reads < 2) result.data.setBigUint64(6, 77n, true);
        }
        return result;
      };
      const configure = protocol.configure({
        centerFrequencyHz: 100e6,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
        rxSettings: {
          kind: "bladerf",
          rxInput: "RX2",
          gainMode: "manual",
          manualGainDb: 30,
        },
      });
      if (mismatch) await expect(configure).rejects.toThrow(/gain readback/);
      else
        await expect(configure).resolves.toMatchObject({ acceptedGainDb: 30 });
      expect(reads).toBe(mismatch ? 20 : 2);
      expect(usb.rfic.get(0x202)).toBe(0n);
      expect(usb.lifecycle).not.toContain("rx:on");
    },
  );
});

describe("bladeRF detected variant integration", () => {
  async function prepared(
    model: "xA4" | "xA5" | "xA9",
    minor: number,
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
  const cases = (["xA4", "xA5", "xA9"] as const).flatMap((model) =>
    [4, 5, 6].map((minor) => ({ model, minor })),
  );

  it.each(cases)(
    "detects configured $model firmware 2.$minor without fabricated image provenance",
    async ({ model, minor }) => {
      const usb = await prepared(model, minor);
      const loadImage = vi.fn();
      const protocol = new BladeRfProtocol(usb, { loadImage });
      const identity = await protocol.open();
      expect(identity).toMatchObject({
        model,
        variantValidation:
          model === "xA4" ? "existing-xa4-profile" : "experimental",
        volatileImage: null,
        detection: {
          calibrationValue: model.slice(1),
          temperatureGrade: "unknown",
        },
      });
      expect(loadImage).not.toHaveBeenCalled();
      const details = await protocol.configure({
        centerFrequencyHz: 100e6,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      });
      expect(details.protocolProfile).toBe(
        `bladerf2-${model.toLowerCase()}-fpga-rfic-35174c3-v1`,
      );
      expect(details.hardwareValidation).toBe("pending");
      expect(usb.vendorRequests.slice(0, 9)).toEqual([
        6, 0, 1, 7, 110, 110, 110, 110, 1,
      ]);
      expect(usb.lifecycle.indexOf("alternate:1")).toBeGreaterThan(
        usb.lifecycle.lastIndexOf("vendor:110:192"),
      );
      expect(usb.lifecycle).not.toContain("alternate:2");
      expect(usb.vendorRequests).not.toContain(2);
    },
  );

  it.each(cases)(
    "loads the matrix-selected $model firmware 2.$minor (isolated digest mock)",
    async ({ model, minor }) => {
      const usb = await prepared(model, minor, false);
      mockOfficialDigest(model, minor);
      const image = selectBladeRfImage(model, usb.firmware);
      const protocol = new BladeRfProtocol(usb, {
        loadImage: async (selected) => {
          expect(selected).toEqual(image);
          return new Uint8Array(selected.byteLength);
        },
      });
      expect(await protocol.open()).toMatchObject({
        model,
        volatileImage: { model, version: image.version, sha256: image.sha256 },
      });
      expect(
        usb.lifecycle.filter((event) => event.startsWith("fpga:write:")),
      ).toEqual([`fpga:write:${image.byteLength}`]);
      expect(usb.lifecycle.indexOf("alternate:3")).toBeGreaterThan(
        usb.lifecycle.lastIndexOf("vendor:110:192"),
      );
      expect(usb.lifecycle).not.toContain("alternate:2");
      expect(usb.vendorRequests).not.toContain(5);
    },
  );

  it.each([true, false])(
    "rejects invalid model evidence in configured=%s before alternates or RF mutation",
    async (configured) => {
      const usb = await prepared("xA9", 5, configured);
      usb.calibration = new Uint8Array(256).fill(0xff);
      const loadImage = vi.fn();
      await expect(
        new BladeRfProtocol(usb, { loadImage }).open(),
      ).rejects.toThrow(/calibration/);
      expect(loadImage).not.toHaveBeenCalled();
      expect(
        usb.lifecycle.some((event) => event.startsWith("alternate:")),
      ).toBe(false);
      expect(usb.niosRequests).toHaveLength(0);
      expect(usb.vendorRequests).not.toContain(2);
    },
  );

  it("rejects same-length corrupt bytes with real SHA-256 before alternate 3 or programming", async () => {
    const usb = await prepared("xA4", 5, false);
    await expect(
      new BladeRfProtocol(usb, {
        loadImage: async (image) => new Uint8Array(image.byteLength),
      }).open(),
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(usb.lifecycle).not.toContain("alternate:3");
    expect(usb.vendorRequests).not.toContain(2);
    expect(usb.niosRequests).toHaveLength(0);
  });

  it.each(["model", "version", "byteLength", "sha256"] as const)(
    "rejects provider-forged %s descriptor",
    async (field) => {
      const usb = await prepared("xA4", 5, false);
      await expect(
        new BladeRfProtocol(usb, {
          loadImage: async (image) => {
            Object.assign(image, {
              [field]: field === "byteLength" ? 0 : "forged",
            });
            return new Uint8Array(2_632_660);
          },
        }).open(),
      ).rejects.toThrow(/catalog descriptor/);
      expect(selectBladeRfImage("xA4", usb.firmware).model).toBe("xA4");
      expect(usb.lifecycle).not.toContain("alternate:3");
      expect(usb.vendorRequests).not.toContain(2);
    },
  );

  it("uses an owned nonzero-offset view snapshot despite provider mutation during digest (digest mock)", async () => {
    const usb = await prepared("xA4", 5, false);
    const image = selectBladeRfImage("xA4", usb.firmware);
    const buffer = new Uint8Array(image.byteLength + 12).fill(42);
    const input = buffer.subarray(7, 7 + image.byteLength);
    let hashed: ArrayBuffer | undefined;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (_algorithm, bytes) => {
        hashed = bytes as ArrayBuffer;
        input.fill(99);
        return Uint8Array.from(image.sha256.match(/../g)!, (hex) =>
          parseInt(hex, 16),
        ).buffer;
      },
    );
    const write = usb.transferOut.bind(usb);
    usb.transferOut = async (endpoint, bytes) => {
      if (usb.currentAlternate === 3) {
        expect((bytes as Uint8Array).buffer).toBe(hashed);
        expect((bytes as Uint8Array)[0]).toBe(42);
        expect((bytes as Uint8Array)[image.byteLength - 1]).toBe(42);
        expect((bytes as Uint8Array).byteLength).toBe(image.byteLength);
      }
      return write(endpoint, bytes);
    };
    await new BladeRfProtocol(usb, { loadImage: async () => input }).open();
  });

  it("rejects observed FPGA state changes during hashing before alternate 3", async () => {
    const usb = await prepared("xA4", 5, false);
    const image = selectBladeRfImage("xA4", usb.firmware);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
      usb.fpgaConfigured = true;
      return Uint8Array.from(image.sha256.match(/../g)!, (hex) =>
        parseInt(hex, 16),
      ).buffer;
    });
    await expect(
      new BladeRfProtocol(usb, {
        loadImage: async () => new Uint8Array(image.byteLength),
      }).open(),
    ).rejects.toThrow(/state changed/);
    expect(usb.lifecycle).not.toContain("alternate:3");
    expect(usb.vendorRequests).not.toContain(2);
  });

  it.each(["short", "rejected", "wrong-version", "invalid-status"])(
    "propagates %s programming failure without RF initialization/retry",
    async (failure) => {
      const usb = await prepared("xA9", 5, false);
      mockOfficialDigest("xA9", 5);
      const write = usb.transferOut.bind(usb);
      usb.transferOut = async (endpoint, bytes) => {
        const result = await write(endpoint, bytes);
        if (usb.currentAlternate === 3) {
          if (failure === "short")
            return { status: "ok", bytesWritten: result.bytesWritten - 1 };
          if (failure === "rejected")
            throw new DOMException("write rejected", "NetworkError");
          if (failure === "wrong-version")
            usb.fpga = { major: 0, minor: 16, patch: 1 };
        }
        return result;
      };
      if (failure === "invalid-status") {
        const read = usb.controlTransferIn.bind(usb);
        usb.controlTransferIn = async (setup, length) => {
          const result = await read(setup, length);
          if (setup.request === 1 && usb.currentAlternate === 3)
            result.data!.setInt32(0, -1, true);
          return result;
        };
      }
      await expect(
        new BladeRfProtocol(usb, {
          loadImage: async (image) => new Uint8Array(image.byteLength),
        }).open(),
      ).rejects.toThrow(/Volatile FPGA state may have changed/);
      expect(
        usb.vendorRequests.filter((request) => request === 2),
      ).toHaveLength(1);
      expect(usb.niosRequests.filter((packet) => packet[2]! & 1)).toHaveLength(
        0,
      );
      expect(usb.lifecycle).not.toContain("rx:on");
    },
  );

  it.each([4, 5, 6])(
    "rejects configured firmware 2.%s/release mismatch without overwrite",
    async (minor) => {
      const usb = await prepared("xA5", minor);
      usb.fpga =
        minor === 4
          ? { major: 0, minor: 16, patch: 0 }
          : { major: 0, minor: 15, patch: 3 };
      await expect(new BladeRfProtocol(usb).open()).rejects.toThrow(
        /pinned receive profile/,
      );
      expect(usb.niosRequests.filter((packet) => packet[2]! & 1)).toHaveLength(
        0,
      );
      expect(usb.vendorRequests).not.toContain(2);
    },
  );

  // Opt-in ephemeral files; never bundle or commit official RBFs.
  it.skipIf(!process.env.BLADERF_OFFICIAL_ARTIFACT_DIR).each(cases)(
    "verifies and submits actual official $model firmware 2.$minor",
    async ({ model, minor }) => {
      const usb = await prepared(model, minor, false);
      const image = selectBladeRfImage(model, usb.firmware);
      const path = `${process.env.BLADERF_OFFICIAL_ARTIFACT_DIR}/${image.filename}`;
      expect(existsSync(path)).toBe(true);
      const identity = await new BladeRfProtocol(usb, {
        loadImage: async () => Uint8Array.from(readFileSync(path)),
      }).open();
      expect(identity.volatileImage?.sha256).toBe(image.sha256);
      expect(usb.lifecycle).toContain(`fpga:write:${image.byteLength}`);
    },
  );
});
