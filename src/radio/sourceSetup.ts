import { AIRSPY_USB_FILTER } from "./airspySettings";
import type { SourceKind } from "./types";
import { HACKRF_USB_FILTER } from "./hackrfProtocol";
import { BLADERF_USB_FILTER } from "./bladerfProtocol";
import { USRP_B205_USB_FILTER } from "./usrpB205Fx3";
const RTL_USB_FILTERS = [
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2838 },
] as const;

export function usbDeviceMatchesSource(
  device: USBDevice,
  source: SourceKind,
): boolean {
  const filters =
    source === "airspy" ? [AIRSPY_USB_FILTER] : source === "hackrf"
      ? [HACKRF_USB_FILTER]
      : source === "bladerf"
        ? [BLADERF_USB_FILTER]
        : source === "usrp-b205"
          ? [USRP_B205_USB_FILTER]
          : source === "rtl-sdr"
            ? RTL_USB_FILTERS
            : [];
  return filters.some(
    (filter) =>
      device.vendorId === filter.vendorId &&
      device.productId === filter.productId,
  );
}

function isUsrpb205RuntimeDescriptor(device: USBDevice): boolean {
  return (
    device.configurations?.some(
      (configuration) =>
        configuration.configurationValue === 1 &&
        configuration.interfaces.length === 5 &&
        configuration.interfaces.every(
          (item, index) => item.interfaceNumber === index,
        ),
    ) ?? false
  );
}

export function selectAuthorizedUsbDevice(
  devices: readonly USBDevice[],
  source: SourceKind,
): USBDevice | undefined {
  const matches = devices.filter((candidate) =>
    usbDeviceMatchesSource(candidate, source),
  );
  if (source === "usrp-b205") {
    return matches.find(isUsrpb205RuntimeDescriptor) ?? matches[0];
  }
  return matches[0];
}
