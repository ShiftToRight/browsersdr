import { afterEach, expect, it, vi } from "vitest";
import { openBrowserUsbDevice, closeBrowserUsbDevice, browserOwnedRtlDevice } from "./browserUsbOwnership";
import { classifyReceiverIssue } from "./receiverRecovery";

afterEach(() => vi.unstubAllGlobals());
function fixture(serial = "fixture-one") {
  const d = {vendorId: 1, productId: 2, serialNumber: serial, opened: false,
    open: vi.fn(async () => { d.opened = true; }),
    close: vi.fn(async () => { d.opened = false; }),
    claimInterface: vi.fn(function(this: unknown) { expect(this).toBe(d); }),
  };
  return d as unknown as USBDevice;
}
function locks() {
  const held = new Set<string>();
  const manager = {request: vi.fn(async (key: string, _options: unknown, action: (lock: unknown) => Promise<void>) => {
    if (held.has(key)) return action(null);
    held.add(key);
    try { await action({name: key}); } finally { held.delete(key); }
  })};
  vi.stubGlobal("navigator", {locks: manager});
  return manager;
}
it("blocks the same serial across owners, keeps different receivers available and releases only after close", async () => {
  const manager = locks(), first = fixture(), second = fixture(), other = fixture("fixture-two");
  await openBrowserUsbDevice(first);
  const error = await openBrowserUsbDevice(second).catch(error => error);
  expect(error.name).toBe("BrowserSdrTabBusy");
  expect(classifyReceiverIssue(new Error("wrapped", {cause: error})).summary).toContain("another BrowserSDR tab");
  expect(second.open).not.toHaveBeenCalled();
  await closeBrowserUsbDevice(second);
  expect(second.close).not.toHaveBeenCalled();
  await openBrowserUsbDevice(other);
  const original = first.close;
  vi.mocked(first.close).mockRejectedValueOnce(new Error("close failed"));
  await expect(closeBrowserUsbDevice(first)).rejects.toThrow("close failed");
  await expect(openBrowserUsbDevice(second)).rejects.toHaveProperty("name", "BrowserSdrTabBusy");
  await closeBrowserUsbDevice(first);
  expect(first.close).toBe(original);
  await openBrowserUsbDevice(second);
  expect(second.open).toHaveBeenCalledOnce();
  expect(manager.request.mock.calls.every(([key]) => !key.includes("fixture"))).toBe(true);
  await closeBrowserUsbDevice(second); await closeBrowserUsbDevice(other);
});
it("does not guess identity without a serial or Web Locks, and releases a failed opening", async () => {
  const manager = locks(), noSerial = fixture("");
  await openBrowserUsbDevice(noSerial);
  expect(manager.request).not.toHaveBeenCalled();
  const failing = fixture(); vi.mocked(failing.open).mockRejectedValueOnce(new Error("driver"));
  await expect(openBrowserUsbDevice(failing)).rejects.toThrow("driver");
  const replacement = fixture(); await openBrowserUsbDevice(replacement); await closeBrowserUsbDevice(replacement);
  vi.stubGlobal("navigator", {});
  const fallback = fixture(); await openBrowserUsbDevice(fallback); await closeBrowserUsbDevice(fallback);
  await closeBrowserUsbDevice(noSerial);
});
it("binds pinned RTL calls to the actual WebUSB handle", async () => {
  locks(); const device = fixture(), wrapped = browserOwnedRtlDevice(device);
  await wrapped.open(); await wrapped.claimInterface(0); await wrapped.close();
  expect(device.open).toHaveBeenCalledOnce(); expect(device.close).toHaveBeenCalledOnce();
});
it("does not misidentify two authorized devices with duplicated manufacturer serials", async () => {
  const manager = locks(), first = fixture(), second = fixture();
  vi.stubGlobal("navigator", {locks:manager,usb:{getDevices:async()=>[first,second]}});
  await openBrowserUsbDevice(first); await openBrowserUsbDevice(second);
  expect(manager.request).not.toHaveBeenCalled();
  await closeBrowserUsbDevice(first); await closeBrowserUsbDevice(second);
});
it("retains ordinary WebUSB access when the optional browser lock API rejects", async () => {
  vi.stubGlobal("navigator", {locks:{request:vi.fn(async()=>{throw new DOMException("Locks unavailable","SecurityError");})}});
  const device=fixture(); await openBrowserUsbDevice(device); expect(device.opened).toBe(true); await closeBrowserUsbDevice(device);
});
it("releases a disconnected handle without waiting for failed graceful tuner shutdown", async () => {
  const manager=locks(), usb=new EventTarget();
  vi.stubGlobal("navigator",{locks:manager,usb});
  const first=fixture(), replacement=fixture();
  await openBrowserUsbDevice(first);
  const event=new Event("disconnect"); Object.defineProperty(event,"device",{value:first}); usb.dispatchEvent(event);
  await openBrowserUsbDevice(replacement); expect(replacement.opened).toBe(true);
  await closeBrowserUsbDevice(first); await closeBrowserUsbDevice(replacement);
});
