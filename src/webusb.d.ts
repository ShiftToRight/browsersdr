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
}

interface Navigator {
  readonly usb?: USB;
}
