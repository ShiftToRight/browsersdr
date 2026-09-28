/** Minimal WebUSB surface used by the receiver and its upstream declarations. */
interface USBDeviceRequestOptions {
  filters: Array<{ vendorId?: number; productId?: number }>;
}

interface USBDevice {
  readonly opened: boolean;
  close(): Promise<void>;
}

interface USB {
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
  /** Devices for which this origin already has permission. Does not show a chooser. */
  getDevices?(): Promise<USBDevice[]>;
}

interface Navigator {
  readonly usb?: USB;
}

interface WorkerNavigator {
  readonly usb?: USB;
}

/** WebUSB members used by the receive-only HackRF adapter. */
interface USBControlTransferParameters {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}
interface USBInTransferResult {
  readonly status: "ok" | "stall" | "babble";
  readonly data?: DataView | null;
}
interface USBOutTransferResult {
  readonly status: "ok" | "stall";
  readonly bytesWritten: number;
}
interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
  readonly packetSize: number;
}
interface USBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly endpoints: readonly USBEndpoint[];
}
interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterface;
  readonly alternates?: readonly USBAlternateInterface[];
}
interface USBConfiguration {
  readonly configurationValue: number;
  readonly interfaces: readonly USBInterface[];
}
interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string | null;
  readonly productName?: string | null;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
  readonly configuration?: USBConfiguration | null;
  readonly configurations?: readonly USBConfiguration[];
  open(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface?(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(
    interfaceNumber: number,
    alternateSetting: number,
  ): Promise<void>;
  controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult>;
  controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult>;
  transferIn(
    endpointNumber: number,
    length: number,
  ): Promise<USBInTransferResult>;
  transferOut(
    endpointNumber: number,
    data: BufferSource,
  ): Promise<USBOutTransferResult>;
  clearHalt?(direction: "in" | "out", endpointNumber: number): Promise<void>;
}
