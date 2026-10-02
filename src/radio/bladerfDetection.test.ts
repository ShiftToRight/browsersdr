import { describe, expect, it } from "vitest";
import wireVectors from "../../docs/implementation/bladerf-variants/WIRE-VECTORS.json";
import {
  detectBladeRfMicroModel,
  parseBladeRfCalibration,
} from "./bladerfDetection";
import type { BladeRfFirmwareVersion } from "./bladerfModels";

// Literal pages/checksums were produced independently of the detector. This fake
// only slices them; it does not encode fields or generate identity expectations.
function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.replaceAll(" ", "").match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
}

function view(bytes: Uint8Array): DataView {
  const padded = new Uint8Array(bytes.length + 11);
  padded.fill(0xaa);
  padded.set(bytes, 5);
  return new DataView(padded.buffer, 5, bytes.length);
}

const pageFor = (name: string) =>
  fromHex(wireVectors.pages.find((page) => page.name === name)!.hex);
const firmware = { major: 2, minor: 6 };
const statusView = (configured: boolean) =>
  view(fromHex(configured ? "01000000" : "00000000"));
type ReadCall = USBControlTransferParameters & { length: number };

class DetectionUsbFake implements USBDevice {
  opened = true;
  vendorId = 0x2cf0;
  productId = 0x5250;
  deviceVersionMajor = 2;
  deviceVersionMinor = 0;
  deviceVersionSubminor = 0;
  configuration = {
    configurationValue: 1,
    interfaces: [
      {
        interfaceNumber: 0,
        claimed: true,
        alternate: {
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0xff,
          interfaceProtocol: 0xff,
          endpoints: [],
        },
      },
    ],
  };
  calls: ReadCall[] = [];
  forbiddenCalls: string[] = [];
  page = pageFor("a4");
  flashId = fromHex("36 c2 00 00");
  configured = false;
  finalConfigured?: boolean;
  onRead?: (
    call: ReadCall,
    ordinal: number,
  ) =>
    Promise<USBInTransferResult | undefined> | USBInTransferResult | undefined;

  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    const call = { ...setup, length };
    this.calls.push(call);
    const intercepted = await this.onRead?.(call, this.calls.length);
    if (intercepted) return intercepted;
    if (call.request === 1)
      return {
        status: "ok",
        data: statusView(
          this.calls.length === 7
            ? (this.finalConfigured ?? this.configured)
            : this.configured,
        ),
      };
    if (call.request === 7) return { status: "ok", data: view(this.flashId) };
    if (call.request === 110)
      return {
        status: "ok",
        data: view(this.page.subarray(call.index, call.index + length)),
      };
    return this.forbidden(`controlTransferIn ${call.request}`);
  }

  private forbidden(operation: string): never {
    this.forbiddenCalls.push(operation);
    throw new Error(`Forbidden detector operation: ${operation}`);
  }
  open(): Promise<void> {
    return this.forbidden("open");
  }
  close(): Promise<void> {
    return this.forbidden("close");
  }
  selectConfiguration(): Promise<void> {
    return this.forbidden("selectConfiguration");
  }
  claimInterface(): Promise<void> {
    return this.forbidden("claimInterface");
  }
  releaseInterface(): Promise<void> {
    return this.forbidden("releaseInterface");
  }
  selectAlternateInterface(): Promise<void> {
    return this.forbidden("selectAlternateInterface");
  }
  controlTransferOut(): Promise<USBOutTransferResult> {
    return this.forbidden("controlTransferOut");
  }
  transferIn(): Promise<USBInTransferResult> {
    return this.forbidden("transferIn");
  }
  transferOut(): Promise<USBOutTransferResult> {
    return this.forbidden("transferOut");
  }
}

const statusCall = {
  requestType: "vendor",
  recipient: "device",
  request: 1,
  value: 0,
  index: 0,
  length: 4,
};
const expectedCalls = [
  statusCall,
  { ...statusCall, request: 7 },
  ...wireVectors.cacheTransfers,
  statusCall,
];

describe("source-derived bladeRF calibration parser", () => {
  for (const vector of wireVectors.pages) {
    it(`checks independent literal ${vector.name}`, () => {
      const page = fromHex(vector.hex);
      expect(page.byteLength).toBe(vector.byteLength);
      if (vector.expected === "reject") {
        expect(() => parseBladeRfCalibration(page)).toThrow(/calibration/i);
      } else {
        const result = parseBladeRfCalibration(page);
        expect(result.model).toBe(vector.expected);
        expect(result.calibrationValue).toBe(vector.expected.substring(1));
        expect(result.calibrationRecordOffset).toBe(
          vector.name === "non_identity_record_before_a4" ? 11 : 0,
        );
        expect(result.calibrationCrc16).toBe(
          vector.expected === "xA4"
            ? 0xa03b
            : vector.expected === "xA5"
              ? 0xb01a
              : 0x7196,
        );
      }
    });
  }

  it("respects a calibration subarray offset and rejects oversized/non-byte pages", () => {
    const padded = new Uint8Array(300);
    padded.set(pageFor("a9"), 13);
    expect(parseBladeRfCalibration(padded.subarray(13, 269)).model).toBe("xA9");
    expect(() => parseBladeRfCalibration(padded)).toThrow(/256/);
    expect(() =>
      parseBladeRfCalibration(null as unknown as Uint8Array),
    ).toThrow(/256/);
  });
});

describe("read-only bladeRF Micro model discovery", () => {
  for (const model of ["a4", "a5", "a9"] as const) {
    for (const configured of [false, true]) {
      for (const flash of wireVectors.flashIds) {
        it(`detects ${model}, configured=${configured}, MID/DID=${flash.manufacturerId}/${flash.deviceId}`, async () => {
          for (const minor of [4, 5, 6, 65535]) {
            const device = new DetectionUsbFake();
            device.page = pageFor(model);
            device.configured = configured;
            device.flashId = fromHex(flash.responseHex);
            const detection = await detectBladeRfMicroModel(device, {
              major: 2,
              minor,
            });
            expect(detection).toEqual({
              model: `xA${model[1]}`,
              fpgaConfigured: configured,
              evidence: {
                source: "firmware-calibration-cache",
                calibrationField: "B",
                calibrationValue: `A${model[1]}`,
                calibrationCrc16:
                  model === "a4" ? 0xa03b : model === "a5" ? 0xb01a : 0x7196,
                calibrationRecordOffset: 0,
                flash: {
                  manufacturerId: flash.manufacturerId,
                  deviceId: flash.deviceId,
                  totalBytes: flash.totalBytes,
                  pageBytes: 256,
                  eraseBlockBytes: 65536,
                },
                temperatureGrade: "unknown",
              },
            });
            expect(device.calls).toEqual(expectedCalls);
            expect(device.forbiddenCalls).toEqual([]);
          }
        });
      }
    }
  }

  it("leaves the current alternate untouched", async () => {
    for (const alternate of [0, 1, 3]) {
      const device = new DetectionUsbFake();
      device.configuration.interfaces[0]!.alternate.alternateSetting =
        alternate;
      await detectBladeRfMicroModel(device, firmware);
      expect(
        device.configuration.interfaces[0]!.alternate.alternateSetting,
      ).toBe(alternate);
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  for (const vector of wireVectors.pages.filter(
    (page) => page.expected === "reject",
  )) {
    it(`fails closed on cache ${vector.name} before any programming or RF I/O`, async () => {
      const device = new DetectionUsbFake();
      device.page = fromHex(vector.hex);
      await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow();
      expect(device.calls).toEqual(expectedCalls.slice(0, 6));
      expect(device.forbiddenCalls).toEqual([]);
    });
  }

  it("rejects firmware without flash-ID capability, unsupported majors and malformed versions before I/O", async () => {
    for (const unsupported of [
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      { major: 2, minor: 2 },
      { major: 2, minor: 3 },
      { major: 1, minor: 4 },
      { major: 3, minor: 6 },
      { major: 65536, minor: 6 },
      { major: 2, minor: 65536 },
      { major: 2, minor: -1 },
      { major: 2.5, minor: 4 },
      { major: 2, minor: 4.5 },
      { major: Number.NaN, minor: 4 },
      { major: 2, minor: Infinity },
      { major: 2, minor: "6" },
      null,
    ]) {
      const device = new DetectionUsbFake();
      await expect(
        detectBladeRfMicroModel(device, unsupported as BladeRfFirmwareVersion),
      ).rejects.toThrow(/firmware/i);
      expect(device.calls).toEqual([]);
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("requires an opened configured and claimed discovery connection", async () => {
    for (const condition of [
      "closed",
      "configuration",
      "unconfigured",
      "interface",
      "missingInterface",
      "unclaimed",
      "missingClaimed",
    ] as const) {
      const device = new DetectionUsbFake();
      if (condition === "closed") device.opened = false;
      if (condition === "configuration")
        device.configuration.configurationValue = 2;
      if (condition === "unconfigured")
        Object.defineProperty(device, "configuration", { value: null });
      if (condition === "interface")
        device.configuration.interfaces[0]!.interfaceNumber = 1;
      if (condition === "missingInterface")
        device.configuration.interfaces.length = 0;
      if (condition === "unclaimed")
        device.configuration.interfaces[0]!.claimed = false;
      if (condition === "missingClaimed")
        Object.defineProperty(device.configuration.interfaces[0]!, "claimed", {
          value: undefined,
        });
      await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow(
        /claimed/i,
      );
      expect(device.calls).toEqual([]);
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("rejects unrecognized flash geometry and malformed high bits without fallback", async () => {
    for (const hex of [
      "36 00 00 00",
      "00 c2 00 00",
      "14 ef 00 00",
      "46 1f 00 00",
      "36 c2 01 00",
      "ff ff ff ff",
      "00 00 c2 36",
    ]) {
      const device = new DetectionUsbFake();
      device.flashId = fromHex(hex);
      await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow(
        /flash architecture/i,
      );
      expect(device.calls).toEqual(expectedCalls.slice(0, 2));
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("rejects negative/unexpected FPGA status and state changes in both directions", async () => {
    for (const ordinal of [1, 7]) {
      for (const hex of ["ff ff ff ff", "02 00 00 00", "00 00 00 01"]) {
        const device = new DetectionUsbFake();
        device.onRead = (_call, count) =>
          count === ordinal
            ? { status: "ok", data: view(fromHex(hex)) }
            : undefined;
        await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow(
          /FPGA status/i,
        );
        expect(device.calls).toHaveLength(ordinal);
        expect(device.forbiddenCalls).toEqual([]);
      }
    }
    for (const configured of [false, true]) {
      const device = new DetectionUsbFake();
      device.configured = configured;
      device.finalConfigured = !configured;
      await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow(
        /state changed/i,
      );
      expect(device.calls).toEqual(expectedCalls);
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  for (const failure of [
    "stall",
    "babble",
    "short",
    "long",
    "absent",
    "null",
    "throw",
  ] as const) {
    it(`rejects ${failure} on every USB read without retries or cleanup mutations`, async () => {
      for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
        const device = new DetectionUsbFake();
        device.onRead = (call, count) => {
          if (count !== ordinal) return;
          if (failure === "throw")
            throw new DOMException("USB failed", "NetworkError");
          if (failure === "absent") return { status: "ok" };
          if (failure === "null") return { status: "ok", data: null };
          if (failure === "short" || failure === "long")
            return {
              status: "ok",
              data: view(
                new Uint8Array(call.length + (failure === "short" ? -1 : 1)),
              ),
            };
          return { status: failure, data: view(new Uint8Array(call.length)) };
        };
        await expect(
          detectBladeRfMicroModel(device, firmware),
        ).rejects.toMatchObject({ name: "NetworkError" });
        expect(device.calls).toEqual(expectedCalls.slice(0, ordinal));
        expect(device.forbiddenCalls).toEqual([]);
      }
    });
  }

  it("checks cancellation before and after every awaited USB operation", async () => {
    for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
      const device = new DetectionUsbFake();
      const cancelled = new DOMException("Discovery cancelled", "AbortError");
      let current = true;
      let checks = 0;
      device.onRead = (_call, count) => {
        if (count === ordinal) current = false;
        return undefined;
      };
      await expect(
        detectBladeRfMicroModel(device, firmware, {
          checkCurrent() {
            checks += 1;
            if (!current) throw cancelled;
          },
        }),
      ).rejects.toBe(cancelled);
      expect(checks).toBe(1 + ordinal * 2);
      expect(device.calls).toEqual(expectedCalls.slice(0, ordinal));
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("cancels at each pre-I/O check, preserving the cancellation error", async () => {
    for (const callNumber of [1, 2, 4, 6, 8, 10, 12, 14]) {
      const device = new DetectionUsbFake();
      const cancelled = new DOMException("Discovery cancelled", "AbortError");
      let checks = 0;
      await expect(
        detectBladeRfMicroModel(device, firmware, {
          checkCurrent() {
            checks += 1;
            if (checks === callNumber) throw cancelled;
          },
        }),
      ).rejects.toBe(cancelled);
      expect(device.calls).toHaveLength(
        callNumber === 1 ? 0 : (callNumber - 2) / 2,
      );
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("checks cancellation while a read is pending and after a rejected USB promise", async () => {
    for (const rejectUsb of [false, true]) {
      const device = new DetectionUsbFake();
      const cancelled = new DOMException("Discovery cancelled", "AbortError");
      let current = true;
      let finish!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      device.onRead = async () => {
        started();
        await pending;
        if (rejectUsb) throw new Error("device disconnected");
        return undefined;
      };
      const result = detectBladeRfMicroModel(device, firmware, {
        checkCurrent() {
          if (!current) throw cancelled;
        },
      });
      const rejection = expect(result).rejects.toBe(cancelled);
      await entered;
      current = false;
      finish();
      await rejection;
      expect(device.calls).toEqual(expectedCalls.slice(0, 1));
      expect(device.forbiddenCalls).toEqual([]);
    }
  });

  it("rejects a connection losing its interface claim without altering ownership", async () => {
    const device = new DetectionUsbFake();
    device.onRead = () => {
      device.configuration.interfaces[0]!.claimed = false;
      return undefined;
    };
    await expect(detectBladeRfMicroModel(device, firmware)).rejects.toThrow(
      /claimed/i,
    );
    expect(device.calls).toEqual(expectedCalls.slice(0, 1));
    expect(device.forbiddenCalls).toEqual([]);
  });
});
