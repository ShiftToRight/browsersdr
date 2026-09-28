import { USRP_B205_IMAGE } from "../radio/usrpB205Images";

function viewOf(data: Uint8Array, offset = 3): DataView {
  const backing = new Uint8Array(data.byteLength + offset + 2);
  backing.set(data, offset);
  return new DataView(backing.buffer, offset, data.byteLength);
}

export function deferredUsb<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export interface UsrpB205UsbCall {
  direction: "in" | "out";
  setup: USBControlTransferParameters;
  length: number;
  bytes: number[];
}

function alternate(interfaceNumber: number): USBAlternateInterface {
  const endpoint = interfaceNumber === 0 ? [] : [{
    endpointNumber: interfaceNumber === 1 ? 2 : interfaceNumber === 2 ? 6 : interfaceNumber === 3 ? 4 : 8,
    direction: (interfaceNumber === 1 || interfaceNumber === 3 ? "out" : "in") as "in" | "out",
    type: "bulk" as const,
    packetSize: 1024,
  }];
  return {
    alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0,
    interfaceProtocol: 0, interfaceName: null, endpoints: endpoint,
  } as USBAlternateInterface;
}

function configuration(): USBConfiguration {
  return {
    configurationValue: 1,
    configurationName: null,
    interfaces: [0, 1, 2, 3, 4].map((interfaceNumber) => {
      const value = alternate(interfaceNumber);
      return { interfaceNumber, alternate: value, alternates: [value], claimed: false } as USBInterface;
    }),
  } as USBConfiguration;
}

/** Deterministic EP0-only B205 fixture. It is not hardware evidence. */
export class FakeUsrpB205Usb implements USBDevice {
  readonly usbVersionMajor = 3;
  readonly usbVersionMinor = 2;
  readonly usbVersionSubminor = 0;
  readonly deviceClass = 0;
  readonly deviceSubclass = 0;
  readonly deviceProtocol = 0;
  vendorId = 0x2500;
  productId = 0x0022;
  readonly deviceVersionMajor = 0;
  readonly deviceVersionMinor = 0;
  readonly deviceVersionSubminor = 0;
  manufacturerName: string | null = "Ettus Research";
  productName: string | null = "USRP B205-mini";
  serialNumber: string | null = "fixture-b205";
  opened = false;
  configuration: USBConfiguration | null = null;
  configurations: USBConfiguration[] = [configuration()];
  firmware = { major: 8, minor: 0 };
  usbSpeed = 3;
  loaderState = 4;
  legacyHash = USRP_B205_IMAGE.legacyHash;
  stateReads: number[] = [];
  autoAdvanceLoader = true;
  disconnected = false;
  closeFailures = 0;
  releaseFailures = new Set<number>();
  claimFailures = new Set<number>();
  openGate?: Promise<void>;
  inOverride?: (setup: USBControlTransferParameters, length: number) => Promise<USBInTransferResult> | undefined;
  outOverride?: (setup: USBControlTransferParameters, bytes: Uint8Array) => Promise<USBOutTransferResult> | undefined;
  readonly lifecycle: string[] = [];
  readonly calls: UsrpB205UsbCall[] = [];
  readonly claimed = new Set<number>();
  readonly imageBytes: number[] = [];

  private checkConnected(): void {
    if (this.disconnected) throw new DOMException("USRP fixture unplugged", "NetworkError");
  }

  async open(): Promise<void> {
    this.lifecycle.push("open");
    await this.openGate;
    this.checkConnected();
    this.opened = true;
  }

  async close(): Promise<void> {
    this.lifecycle.push("close");
    if (this.closeFailures-- > 0) throw new Error("fixture close failed");
    this.opened = false;
    this.claimed.clear();
  }

  async selectConfiguration(value: number): Promise<void> {
    this.checkConnected();
    this.lifecycle.push(`configuration:${value}`);
    if (value !== 1) throw new Error("unexpected configuration");
    this.configuration = this.configurations[0]!;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.checkConnected();
    this.lifecycle.push(`claim:${interfaceNumber}`);
    if (this.claimFailures.has(interfaceNumber)) throw new Error(`fixture claim ${interfaceNumber} failed`);
    this.claimed.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.lifecycle.push(`release:${interfaceNumber}`);
    if (this.releaseFailures.has(interfaceNumber)) throw new Error(`fixture release ${interfaceNumber} failed`);
    this.claimed.delete(interfaceNumber);
  }

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    this.checkConnected();
    this.calls.push({ direction: "in", setup: { ...setup }, length, bytes: [] });
    const overridden = this.inOverride?.(setup, length);
    if (overridden) return overridden;
    let result: Uint8Array;
    switch (setup.request) {
      case 0x15: result = Uint8Array.of(this.firmware.major, this.firmware.minor); break;
      case 0x80: result = Uint8Array.of(this.usbSpeed); break;
      case 0x83: result = Uint8Array.of(this.stateReads.shift() ?? this.loaderState); break;
      case 0x1d: result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, this.legacyHash, true); break;
      case 0x22: result = new Uint8Array(512); for (let index = 0; index < result.length; index += 1) result[index] = index & 0xff; break;
      default: throw new Error(`Unmodeled USRP control IN 0x${setup.request.toString(16)}`);
    }
    return { status: "ok", data: viewOf(result) };
  }

  async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult> {
    this.checkConnected();
    const bytes = data ? ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data) : new Uint8Array();
    this.calls.push({ direction: "out", setup: { ...setup }, length: bytes.byteLength, bytes: [...bytes] });
    const overridden = this.outOverride?.(setup, bytes);
    if (overridden) return overridden;
    switch (setup.request) {
      case 0x1c: this.legacyHash = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true); break;
      case 0x55: if (this.autoAdvanceLoader) this.loaderState = 1; break;
      case 0x02: if (this.autoAdvanceLoader) this.loaderState = 2; break;
      case 0x12: this.imageBytes.push(...bytes); if (this.autoAdvanceLoader) this.loaderState = 4; break;
      case 0x72: this.lifecycle.push("gpif-reset"); break;
      default: throw new Error(`Unmodeled USRP control OUT 0x${setup.request.toString(16)}`);
    }
    return { status: "ok", bytesWritten: bytes.byteLength };
  }

  async selectAlternateInterface(): Promise<void> { throw new Error("USRP fixture does not select alternates"); }
  async clearHalt(): Promise<void> { throw new Error("USRP fixture does not clear halts in step 03"); }
  async transferIn(): Promise<USBInTransferResult> { throw new Error("USRP fixture does not use bulk transfers in step 03"); }
  async transferOut(): Promise<USBOutTransferResult> { throw new Error("USRP fixture does not use bulk transfers in step 03"); }
  async reset(): Promise<void> { throw new Error("USRP fixture reset is forbidden"); }
  async forget(): Promise<void> { throw new Error("USRP fixture forget is forbidden"); }
}
