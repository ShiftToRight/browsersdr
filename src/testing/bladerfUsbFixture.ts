import { BLADERF_READ_BYTES } from "../radio/bladerfProtocol";

function viewOf(data: Uint8Array, offset = 3): DataView {
  const copy = new Uint8Array(data.byteLength + offset + 2);
  copy.set(data, offset);
  return new DataView(copy.buffer, offset, data.byteLength);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class FakeBladeRfUsb implements USBDevice {
  opened = false;
  vendorId = 0x2cf0;
  productId = 0x5250;
  serialNumber = "xa4-fixture";
  deviceVersionMajor = 2;
  deviceVersionMinor = 4;
  deviceVersionSubminor = 0;
  readonly lifecycle: string[] = [];
  readonly vendorRequests: number[] = [];
  readonly controlOutRequests: USBControlTransferParameters[] = [];
  readonly niosRequests: Uint8Array[] = [];
  readonly rfic = new Map<number, bigint>([
    [0x0f01, 0n],
    [0x0f00, 0n],
    [0x0003, 2_400_000n],
    [0x0004, 100_000_000n],
    [0x0005, 2_400_000n],
    [0x0006, 3n],
  ]);
  gpio = 0;
  model: "xA4" | "xA5" | "xA9" = "xA4";
  calibration?: Uint8Array;
  flashId = 0xc236;
  fpgaConfigured = true;
  claimed = false;
  firmware = { major: 2, minor: 4 };
  fpga = { major: 0, minor: 15, patch: 3 };
  sampleRateReadbackOffset = 0;
  frequencyReadbackOffset = 0;
  rxStopSettlesReads = true;
  configuration: USBConfiguration | null = null;
  currentAlternate = 0;
  private response?: Uint8Array;
  private reads: ReturnType<typeof deferred<USBInTransferResult>>[] = [];

  private alternate(setting: number): USBAlternateInterface {
    return {
      alternateSetting: setting,
      interfaceClass: 255,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      endpoints:
        setting === 1
          ? [
              {
                endpointNumber: 1,
                direction: "in",
                type: "bulk",
                packetSize: 1024,
              },
              {
                endpointNumber: 1,
                direction: "out",
                type: "bulk",
                packetSize: 1024,
              },
              {
                endpointNumber: 2,
                direction: "in",
                type: "bulk",
                packetSize: 1024,
              },
              {
                endpointNumber: 2,
                direction: "out",
                type: "bulk",
                packetSize: 1024,
              },
            ]
          : setting === 3
            ? [
                {
                  endpointNumber: 2,
                  direction: "out",
                  type: "bulk",
                  packetSize: 1024,
                },
              ]
            : [],
    };
  }
  async open() {
    this.lifecycle.push("open");
    this.opened = true;
  }
  async close() {
    this.lifecycle.push("close");
    this.opened = false;
    this.claimed = false;
    for (const read of this.reads.splice(0))
      read.reject(new DOMException("closed", "AbortError"));
  }
  async selectConfiguration(value: number) {
    this.lifecycle.push(`configuration:${value}`);
    this.configuration = {
      configurationValue: value,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: this.claimed,
          alternate: this.alternate(0),
        },
      ],
    };
  }
  async claimInterface(value: number) {
    this.lifecycle.push(`claim:${value}`);
    this.claimed = true;
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: true,
          alternate: this.alternate(this.currentAlternate),
        },
      ],
    };
  }
  async releaseInterface(value: number) {
    this.lifecycle.push(`release:${value}`);
    this.claimed = false;
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: false,
          alternate: this.alternate(this.currentAlternate),
        },
      ],
    };
  }
  async selectAlternateInterface(_interfaceNumber: number, setting: number) {
    if (this.currentAlternate === 1 && setting !== 1) {
      for (const read of this.reads.splice(0))
        read.reject(
          new DOMException("Alternate interface changed", "AbortError"),
        );
    }
    this.lifecycle.push(`alternate:${setting}`);
    this.currentAlternate = setting;
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: this.claimed,
          alternate: this.alternate(setting),
        },
      ],
    };
  }
  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    this.vendorRequests.push(setup.request);
    this.lifecycle.push(`vendor:${setup.request}:${setup.index}`);
    let result: Uint8Array;
    if (setup.request === 0)
      result = Uint8Array.of(this.firmware.major, 0, this.firmware.minor, 0);
    else if (setup.request === 7)
      result = new Uint8Array(new Uint32Array([this.flashId]).buffer);
    else if (setup.request === 110) {
      // Independent phase-01 literals (WIRE-VECTORS.json/upstream zcrc), not the production parser.
      const page = this.calibration ?? new Uint8Array(256).fill(0xff);
      if (!this.calibration)
        page.set(
          this.model === "xA4"
            ? [3, 0x42, 0x41, 0x34, 0x3b, 0xa0]
            : this.model === "xA5"
              ? [3, 0x42, 0x41, 0x35, 0x1a, 0xb0]
              : [3, 0x42, 0x41, 0x39, 0x96, 0x71],
        );
      result = page.slice(setup.index, setup.index + length);
    } else if (setup.request === 1)
      result = new Uint8Array(
        new Int32Array([this.fpgaConfigured ? 1 : 0]).buffer,
      );
    else if (setup.request === 2) {
      this.lifecycle.push("fpga:begin");
      result = new Uint8Array(new Int32Array([0]).buffer);
    } else if (setup.request === 4) {
      this.lifecycle.push(setup.value ? "rx:on" : "rx:off");
      result = new Uint8Array(new Int32Array([0]).buffer);
      if (!setup.value && this.rxStopSettlesReads)
        for (const read of this.reads.splice(0))
          read.reject(new DOMException("RX stopped", "AbortError"));
    } else if (setup.request === 6)
      result = new Uint8Array(new Int32Array([1]).buffer);
    else throw new Error(`Unexpected vendor request ${setup.request}`);
    if (result.byteLength !== length)
      throw new Error("Fixture length mismatch");
    return { status: "ok", data: viewOf(result) };
  }
  async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult> {
    this.controlOutRequests.push({ ...setup });
    this.lifecycle.push(`vendor-out:${setup.request}:${setup.index}`);
    const size = data
      ? ArrayBuffer.isView(data)
        ? data.byteLength
        : data.byteLength
      : 0;
    return { status: "ok", bytesWritten: size };
  }
  async transferOut(
    endpoint: number,
    data: BufferSource,
  ): Promise<USBOutTransferResult> {
    if (endpoint !== 2) throw new Error("Unexpected output endpoint");
    const request = Uint8Array.from(
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data),
    );
    if (this.currentAlternate === 3) {
      this.lifecycle.push(`fpga:write:${request.byteLength}`);
      this.fpgaConfigured = true;
      return { status: "ok", bytesWritten: request.byteLength };
    }
    this.niosRequests.push(request);
    this.lifecycle.push(
      `nios:${request[0]}:${request[1]}:${request[2]}:${request[4]}:${request[5]}`,
    );
    const response = Uint8Array.from(request);
    response[2] = response[2]! | 0x02;
    if (request[0] === 0x43) {
      if (request[1] === 0) {
        response[5] = this.fpga.major;
        response[6] = this.fpga.minor;
        response[7] = this.fpga.patch & 0xff;
        response[8] = this.fpga.patch >>> 8;
      } else if (request[1] === 1) {
        if (request[2]! & 1)
          this.gpio = new DataView(request.buffer).getUint32(5, true);
        new DataView(response.buffer).setUint32(5, this.gpio, true);
      }
    } else if (request[0] === 0x45) {
      const address = request[4]! | (request[5]! << 8);
      if (request[2]! & 1) {
        const value = new DataView(request.buffer).getBigUint64(6, true);
        const adjustment =
          (address & 0xff) === 0x03
            ? this.sampleRateReadbackOffset
            : (address & 0xff) === 0x04
              ? this.frequencyReadbackOffset
              : 0;
        this.rfic.set(address, value + BigInt(adjustment));
        if (address === 0x0f01) this.rfic.set(0x0f00, value === 1n ? 1n : 0n);
      }
      new DataView(response.buffer).setBigUint64(
        6,
        this.rfic.get(address) ?? 0n,
        true,
      );
    } else throw new Error("Unexpected NIOS packet");
    this.response = response;
    return { status: "ok", bytesWritten: request.byteLength };
  }
  transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint === 2) {
      if (!this.response) throw new Error("No peripheral response queued");
      const response = this.response;
      this.response = undefined;
      return Promise.resolve({ status: "ok", data: viewOf(response) });
    }
    if (endpoint !== 1 || length !== BLADERF_READ_BYTES)
      throw new Error("Unexpected sample read");
    const read = deferred<USBInTransferResult>();
    this.reads.push(read);
    return read.promise;
  }
  deliverSamples(values: readonly number[]): void {
    const read = this.reads.shift();
    if (!read) throw new Error("No pending sample read");
    const data = new Uint8Array(values.length * 2);
    const view = new DataView(data.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, true));
    read.resolve({ status: "ok", data: viewOf(data) });
  }
}
