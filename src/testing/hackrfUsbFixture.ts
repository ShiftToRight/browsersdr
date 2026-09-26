/** Scriptable USB fixture. Radio values are modeled, not hardware observations. */
export function deferredUsb<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function usbView(bytes: number[] | Uint8Array, offset = 3): DataView {
  const backing = new Uint8Array(bytes.length + offset + 5);
  backing.fill(0xee); backing.set(bytes, offset);
  return new DataView(backing.buffer, offset, bytes.length);
}
export interface FakeUsbRead {
  length: number;
  endpoint: number;
  settled: boolean;
  result: ReturnType<typeof deferredUsb<USBInTransferResult>>;
}
export class FakeHackrfUsb implements USBDevice {
  constructor(api = 0x0113) {
    this.deviceVersionMinor = Math.floor((api % 256) / 16); this.deviceVersionSubminor = api % 16;
  }
  get stable() { return this.deviceVersionMinor === 0 || this.deviceVersionSubminor === 0; }
  private appliedStableFrequency?: bigint;
  private applyStableFrequency() {
    const frequency = this.radio.get(1)!;
    if (frequency === this.appliedStableFrequency) return;
    this.appliedStableFrequency = frequency;
    this.fpga.set(1, ((this.fpga.get(1) ?? 0) & ~6) | (frequency < 2_000_000_000n * 2n ** 24n ? 2 : 6));
  }
  private applyStableRate() {
    // Stable firmware: request 6 doubles numerator; radio chooses n from that clock.
    const clock = Number(this.radio.get(6)! / 2n ** 36n) * 2;
    let n = 1, twiceClock = 2 * clock;
    while (twiceClock <= 40_000_000 && n < 5) { twiceClock *= 2; n++; }
    this.fpga.set(2, n); this.applyStableFrequency();
  }
  opened = false;
  vendorId = 0x1d50; productId = 0x6089;
  deviceVersionMajor = 1; deviceVersionMinor = 1; deviceVersionSubminor = 3;
  configuration: USBConfiguration | null = null;
  layout: USBConfiguration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0,
    alternate: { alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 255, interfaceProtocol: 255,
      endpoints: [{ endpointNumber: 1, direction: "in", type: "bulk", packetSize: 512 }, { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 512 }] } }] };
  readonly calls: { direction: "in" | "out"; setup: USBControlTransferParameters; bytes: number[]; length: number }[] = [];
  readonly reads: FakeUsbRead[] = [];
  readonly lifecycle: string[] = [];
  radio = new Map<number, bigint>([[0, 0n], [1, 100_000_000n * 2n ** 24n], [5, 0n], [6, 1_024_000n * 2n ** 36n], [8, 5n], [11, 0n], [12, 16n], [13, 12n], [15, 768_000n], [17, 768_000n], [20, 0n], [21, 0n], [22, 1n]]);
  fpga = new Map<number, number>();
  rotationRx = 0x40000000n;
  amp = 0n;
  openGate?: Promise<void>;
  closeGate?: Promise<void>;
  closeFailures = 0;
  claimFailure = false;
  settleReadsOnClose = true;
  inOverride?: (setup: USBControlTransferParameters, length: number) => Promise<USBInTransferResult> | undefined;
  outOverride?: (setup: USBControlTransferParameters, bytes: Uint8Array) => Promise<USBOutTransferResult> | undefined;
  async open() { this.lifecycle.push("open"); await this.openGate; this.opened = true; }
  async selectConfiguration(value: number) { this.lifecycle.push(`configuration:${value}`); this.configuration = this.layout; }
  async claimInterface(value: number) { this.lifecycle.push(`claim:${value}`); if (this.claimFailure) throw new Error("claim failed"); }
  async selectAlternateInterface(_interfaceNumber: number, _alternateSetting: number) {}
  async transferOut(_endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult> {
    const length = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
    return { status: "ok", bytesWritten: length };
  }
  async close() {
    this.lifecycle.push("close");
    if (this.closeFailures-- > 0) throw new Error("close failed");
    await this.closeGate; this.opened = false;
    if (this.settleReadsOnClose) for (const read of this.reads) if (!read.settled) {
      read.settled = true; read.result.reject(new DOMException("USB read aborted by close", "AbortError"));
    }
  }
  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    this.calls.push({ direction: "in", setup, length, bytes: [] });
    const override = this.inOverride?.(setup, length); if (override) return override;
    let bytes: Uint8Array;
    switch (setup.request) {
      case 14: bytes = Uint8Array.of(5); break;
      case 15: bytes = new TextEncoder().encode(this.stable ? "v2026.01.3" : "fixture-unvalidated"); break;
      case 18: bytes = new Uint8Array(24); new DataView(bytes.buffer).setUint32(8, 0x01020304, true); break;
      case 45: bytes = Uint8Array.of(0x89); break;
      case 46: bytes = Uint8Array.of(0, 0, 0, 16); break;
      case 19: this.radio.set(12, BigInt(setup.index)); bytes = Uint8Array.of(1); break;
      case 20: this.radio.set(13, BigInt(setup.index)); bytes = Uint8Array.of(1); break;
      case 41:
        if (!this.stable) throw new Error("Unexpected M0 query in development fixture");
        bytes = new Uint8Array(40);
        new DataView(bytes.buffer).setUint32(0, this.radio.get(0) === 1n ? 2 : 0, true);
        new DataView(bytes.buffer).setUint32(4, this.radio.get(0) === 1n ? 2 : 0, true); break;
      case 50: bytes = Uint8Array.of(this.fpga.get(setup.index) ?? 0); break;
      case 60: if (this.stable) throw new Error("Radio-register API unavailable"); bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, this.radio.get(setup.value) ?? 0xffffffffffffffffn, true); break;
      default: throw new Error(`Unmodeled input ${setup.request}`);
    }
    return { status: "ok", data: usbView(bytes) };
  }
  async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult> {
    const bytes = data ? ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data) : new Uint8Array();
    this.calls.push({ direction: "out", setup, length: bytes.length, bytes: [...bytes] });
    const override = this.outOverride?.(setup, bytes); if (override) return override;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (setup.request) {
      case 1:
        if (setup.value !== 0 && setup.value !== 1) throw new Error("Forbidden TX mode");
        this.radio.set(0, BigInt(setup.value)); this.radio.set(5, setup.value === 1 ? this.rotationRx : 0n);
        this.radio.set(11, setup.value === 1 ? this.amp : 0n); if (this.stable) { if (setup.value === 1) this.applyStableRate(); } else this.fpga.set(3, Number(this.radio.get(5)! / 2n ** 24n)); break;
      case 6: this.radio.set(6, BigInt(view.getUint32(0, true)) * 2n ** 36n); if (this.stable && this.radio.get(0) === 1n) this.applyStableRate(); break;
      case 16: this.radio.set(1, (BigInt(view.getUint32(0, true)) * 1_000_000n + BigInt(view.getUint32(4, true))) * 2n ** 24n); if (this.stable && this.radio.get(0) === 1n) this.applyStableFrequency(); break;
      case 17: this.amp = BigInt(setup.value); break;
      case 23: this.radio.set(20, BigInt(setup.value)); break;
      case 29: this.radio.set(21, BigInt(setup.value)); break;
      case 48: if (!this.stable || setup.value !== 0x36) throw new Error("Invalid bias-tee override"); break;
      case 49: this.fpga.set(setup.index, setup.value); break;
      case 54: this.fpga.clear(); break;
      case 59: if (this.stable) throw new Error("Radio-register API unavailable"); if (setup.index === 1 && bytes[0] !== 5) this.radio.set(bytes[0]!, view.getBigUint64(1, true)); break;
      default: throw new Error(`Unmodeled output ${setup.request}`);
    }
    return { status: "ok", bytesWritten: bytes.length };
  }
  transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    const result = deferredUsb<USBInTransferResult>();
    this.reads.push({ endpoint, length, result, settled: false }); return result.promise;
  }
  get pendingReads() { return this.reads.filter((read) => !read.settled); }
  deliver(bytes: number[] | Uint8Array, index = 0) {
    const read = this.pendingReads[index];
    if (!read) throw new Error("No pending fake USB read");
    read.settled = true; read.result.resolve({ status: "ok", data: usbView(bytes) });
  }
}
