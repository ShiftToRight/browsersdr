const leases = new WeakMap<USBDevice, () => void>();
const denied = new WeakSet<USBDevice>();

/** Serial-bearing devices can be identified across tabs without confusing identical receivers.
 * Origin-local locks expire when the tab closes; keys are never persisted or reported. */
export async function openBrowserUsbDevice(device: USBDevice): Promise<void> {
  const locks = globalThis.navigator?.locks;
  const serial = device.serialNumber;
  const devices = serial && !leases.has(device) ? await globalThis.navigator?.usb?.getDevices?.().catch(() => []) ?? [] : [];
  const ambiguous = devices.filter(other => other.vendorId === device.vendorId && other.productId === device.productId && other.serialNumber === serial).length > 1;
  if (!leases.has(device) && serial && !ambiguous && locks?.request && globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(`${device.vendorId}:${device.productId}:${device.serialNumber}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    await new Promise<void>((resolve, reject) => {
      void locks.request(`browsersdr.usb.${key}`, {ifAvailable: true}, async lock => {
        if (!lock) {
          denied.add(device);
          reject(new DOMException("This receiver is connected in another BrowserSDR tab or window. Disconnect it there, then retry here.", "BrowserSdrTabBusy"));
          return;
        }
        let release!: () => void;
        const held = new Promise<void>(done => { release = done; });
        const usb = globalThis.navigator?.usb as (USB & Partial<Pick<EventTarget, "addEventListener" | "removeEventListener">>) | undefined;
        const unplug = (event: Event) => { if ((event as Event & {device?: USBDevice}).device === device) releaseDevice(); };
        const releaseDevice = () => {
          usb?.removeEventListener?.("disconnect", unplug);
          leases.delete(device);
          release();
        };
        usb?.addEventListener?.("disconnect", unplug);
        leases.set(device, releaseDevice);
        resolve();
        await held;
      }).catch(() => resolve()); // Locks unavailable: let WebUSB enforce device ownership.
    });
  }
  denied.delete(device);
  try {
    if (!device.opened) await device.open();
  } catch (error) {
    if (!device.opened) release(device);
    throw error;
  }
}

function release(device: USBDevice) {
  leases.get(device)?.();
  leases.delete(device);
}

export async function closeBrowserUsbDevice(device: USBDevice): Promise<void> {
  if (denied.has(device)) return;
  try { await device.close(); }
  finally { if (!device.opened) release(device); }
}

/** The pinned RTL driver owns open/close internally. Bind other WebUSB calls to the real receiver. */
export function browserOwnedRtlDevice(device: USBDevice): USBDevice {
  return new Proxy(device, {get(target, property) {
    if (property === "open") return () => openBrowserUsbDevice(target);
    if (property === "close") return () => closeBrowserUsbDevice(target);
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  }});
}
