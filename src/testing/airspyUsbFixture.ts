/** Independently specified vendor-command fixture and paced REAL ADC transport.
 * No application driver or converter is imported here. Software evidence only. */
export class FakeAirspyUsb {
  vendorId = 0x1d50;
  productId = 0x60a1;
  serialNumber = "AIRSPY SN:0000000000000001";
  opened = false;
  configuration: USBConfiguration | null = null;
  configurations = [
    {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 255,
              endpoints: [{ endpointNumber: 1, direction: "in", type: "bulk" }],
            },
          ],
        },
      ],
    },
  ] as unknown as USBConfiguration[];
  calls: {
    direction: string;
    request: number;
    value: number;
    index: number;
    bytes: number[];
  }[] = [];
  lifecycle: string[] = [];
  rates = [10_000_000, 2_500_000];
  rate = 2_500_000;
  frequency = 100_000_000;
  packing = false;
  receiving = false;
  bias = false;
  nextRead = 0;
  startedAt = 0;
  deliveredComplex = 0;
  maxPending = 0;
  pending = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>();
  failRequest?: number;
  private cached?: Uint8Array;
  async open() {
    this.opened = true;
    this.lifecycle.push("open");
  }
  async selectConfiguration() {
    this.configuration = this.configurations[0]!;
  }
  async claimInterface() {
    this.lifecycle.push("claim");
  }
  async clearHalt() {}
  async close() {
    this.opened = false;
    this.receiving = false;
    this.lifecycle.push("close");
    for (const [timer, reject] of this.pending) {
      clearTimeout(timer);
      reject(new Error("Device closed"));
    }
    this.pending.clear();
  }
  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    this.calls.push({
      direction: "in",
      request: setup.request,
      value: setup.value,
      index: setup.index,
      bytes: [],
    });
    if (
      !this.opened ||
      setup.requestType !== "vendor" ||
      setup.recipient !== "device" ||
      setup.value ||
      setup.request === this.failRequest
    )
      return { status: "stall" };
    let bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    switch (setup.request) {
      case 9:
        if (length !== 1) return { status: "stall" };
        break;
      case 10:
        bytes = new TextEncoder().encode("AirSpy fixture R2");
        break;
      case 11:
        if (length !== 24) return { status: "stall" };
        view.setUint32(20, 1, true);
        break;
      case 25:
        if (setup.index === 0 && length === 4)
          view.setUint32(0, this.rates.length, true);
        else if (
          setup.index === this.rates.length &&
          length === this.rates.length * 4
        )
          this.rates.forEach((rate, n) => view.setUint32(n * 4, rate, true));
        else return { status: "stall" };
        break;
      case 12:
        if (length !== 1 || this.rates[setup.index] === undefined)
          return { status: "stall" };
        this.rate = this.rates[setup.index]!;
        bytes[0] = 1;
        break;
      case 26:
        if (length !== 1 || setup.index > 1) return { status: "stall" };
        this.packing = setup.index === 1;
        this.cached = undefined;
        bytes[0] = 1;
        break;
      case 14:
      case 15:
      case 16:
      case 17:
      case 18:
        if (
          length !== 1 ||
          setup.index >
            (setup.request === 14 ? 14 : setup.request < 17 ? 15 : 1)
        )
          return { status: "stall" };
        break;
      default:
        throw new Error(`Unexpected Airspy IN request ${setup.request}`);
    }
    return {
      status: "ok",
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult> {
    const bytes = data
      ? ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      : new Uint8Array();
    this.calls.push({
      direction: "out",
      request: setup.request,
      value: setup.value,
      index: setup.index,
      bytes: [...bytes],
    });
    if (
      !this.opened ||
      setup.requestType !== "vendor" ||
      setup.recipient !== "device" ||
      setup.request === this.failRequest
    )
      return { status: "stall", bytesWritten: 0 };
    if (
      setup.request === 1 &&
      setup.index === 0 &&
      bytes.length === 0 &&
      setup.value < 2
    ) {
      this.receiving = setup.value === 1;
      if (this.receiving) {
        // Preparing a synthetic waveform is not USB time. Do it before starting
        // the nominal sample clock, avoiding a fixture-only catch-up burst.
        this.prepareSamples(this.packing ? 49152 : 65536);
        this.nextRead = performance.now();
        this.startedAt = this.nextRead;
        this.deliveredComplex = 0;
      }
    } else if (
      setup.request === 21 &&
      setup.index === 45 &&
      setup.value < 2 &&
      bytes.length === 0
    )
      this.bias = setup.value === 1;
    else if (
      setup.request === 13 &&
      bytes.length === 4 &&
      !setup.index &&
      !setup.value
    )
      this.frequency = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
        0,
        true,
      );
    else
      throw new Error(
        `Unexpected Airspy OUT request ${setup.request}/${setup.value}/${setup.index}`,
      );
    return { status: "ok", bytesWritten: bytes.length };
  }
  private prepareSamples(length: number) {
    if (!this.cached || this.cached.length !== length) {
      const values = Array.from(
        { length: length / (this.packing ? 1.5 : 2) },
        (_, n) =>
          Math.round(
            2048 +
              700 *
                Math.cos(
                  (Math.PI * n) / 2 + 0.6 * Math.sin((2 * Math.PI * n) / 1024),
                ),
          ),
      );
      this.cached = new Uint8Array(length);
      const view = new DataView(this.cached.buffer);
      if (!this.packing)
        values.forEach((value, n) => view.setUint16(n * 2, value, true));
      else
        for (let n = 0; n < values.length; n += 8) {
          const bits = values
            .slice(n, n + 8)
            .map((value) => value.toString(2).padStart(12, "0"))
            .join("");
          for (let word = 0; word < 3; word++)
            view.setUint32(
              (n / 8) * 12 + word * 4,
              parseInt(bits.slice(word * 32, word * 32 + 32), 2),
              true,
            );
        }
    }
  }
  transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint !== 1 || !this.receiving)
      return Promise.reject(new Error("Airspy fixture is not receiving"));
    this.nextRead += (length / (this.packing ? 3 : 4) / this.rate) * 1000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(timer);
          const bytes = this.cached!.slice();
          this.deliveredComplex += length / (this.packing ? 3 : 4);
          resolve({ status: "ok", data: new DataView(bytes.buffer) });
        },
        Math.max(0, this.nextRead - performance.now()),
      );
      this.pending.set(timer, reject);
      this.maxPending = Math.max(this.maxPending, this.pending.size);
    });
  }
}
