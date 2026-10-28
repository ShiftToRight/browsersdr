import { expect, it, vi } from "vitest";
import { lazyUsbBackend } from "./lazyUsbBackend";
import type { ReceiverBackend } from "./receiverController";
const options = {
  source: "airspy" as const,
  channelFrequencyHz: 100e6,
  volume: 0.5,
};
it("requests permission synchronously and loads only after an actual device selection", async () => {
  const device = {} as USBDevice,
    metadata = { source: "airspy" };
  const inner = {
    connectGranted: vi.fn(async () => metadata),
    stop: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    tune: vi.fn(),
  } as unknown as ReceiverBackend;
  const create = vi.fn(async () => inner),
    requestDevice = vi.fn(async () => device);
  const backend = lazyUsbBackend(create, { vendorId: 1, productId: 2 }, {
    requestDevice,
  } as unknown as USB);
  const connecting = backend.connect!(options);
  expect(requestDevice).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(await connecting).toEqual(metadata);
  expect(create).toHaveBeenCalledOnce();
  await backend.tune(101e6, 2);
  expect(inner.tune).toHaveBeenCalledWith(101e6, 2);
  await backend.disconnect!();
  expect(inner.disconnect).toHaveBeenCalledOnce();
});
it("cannot open a device selected after cancellation or disconnect", async () => {
  let grant!: (device: USBDevice) => void;
  const permission = new Promise<USBDevice>((resolve) => {
    grant = resolve;
  });
  const create = vi.fn(async () => ({}) as ReceiverBackend);
  const backend = lazyUsbBackend(create, { vendorId: 1, productId: 2 }, {
    requestDevice: () => permission,
  } as unknown as USB);
  const connecting = backend.connect!(options);
  await backend.disconnect!();
  grant({} as USBDevice);
  await expect(connecting).rejects.toThrow(/cancelled/);
  expect(create).not.toHaveBeenCalled();
});
