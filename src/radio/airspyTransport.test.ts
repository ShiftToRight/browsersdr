import { expect, it, vi } from "vitest";
import { FakeAirspyUsb } from "../testing/airspyUsbFixture";
import { AirspyTransport } from "./airspyTransport";
import { DEFAULT_AIRSPY_SETTINGS } from "./airspySettings";

it("retains ordered USB reads while awaiting consumer progress", async () => {
  const device = new FakeAirspyUsb();
  const error = vi.fn();
  const transport = new AirspyTransport(error);
  await transport.open(device as unknown as USBDevice);
  await transport.configure(10_000_000, 100e6, { ...DEFAULT_AIRSPY_SETTINGS });
  let entered!: () => void, release!: () => void;
  const first = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receive = vi.fn(() => {
    entered();
    return barrier;
  });
  await transport.start(false, receive);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(receive).toHaveBeenCalledTimes(1);
  expect(device.maxPending).toBe(16);
  release();
  await vi.waitFor(() => expect(receive.mock.calls.length).toBeGreaterThan(1));
  await transport.stop();
  expect(device.pending.size).toBe(0);
  expect(error).not.toHaveBeenCalled();
});

it("identifies R2, uses firmware rate INDEX, acknowledges settings and retains bounded reads through stop/restart", async () => {
  const device = new FakeAirspyUsb(),
    error = vi.fn(),
    transport = new AirspyTransport(error);
  expect(await transport.open(device as unknown as USBDevice)).toMatchObject({
    rateProfile: "r2",
    sampleRates: [10_000_000, 2_500_000],
  });
  expect(
    await transport.configure(2_500_000, 100_000_000, {
      ...DEFAULT_AIRSPY_SETTINGS,
      ppm: 1,
    }),
  ).toBe(100_000_100);
  expect(device.calls.find((call) => call.request === 12)).toMatchObject({
    direction: "in",
    value: 0,
    index: 1,
  });
  expect(device.calls.find((call) => call.request === 13)?.bytes).toEqual([
    100, 225, 245, 5,
  ]);
  let received!: () => void;
  const block = new Promise<void>((resolve) => {
    received = resolve;
  });
  await transport.start(false, () => received());
  await block;
  await transport.stop();
  expect(device.pending.size).toBe(0);
  expect(device.bias).toBe(false);
  expect(device.opened).toBe(false);
  await transport.configure(10_000_000, 100e6, {
    ...DEFAULT_AIRSPY_SETTINGS,
    packing: true,
  });
  expect(device.rate).toBe(10_000_000);
  expect(device.packing).toBe(true);
  await transport.close();
  expect(device.maxPending).toBeLessThanOrEqual(16);
  expect(error).not.toHaveBeenCalled();
  expect(
    device.calls.some((call) =>
      [2, 4, 6, 7, 8, 19, 20, 23, 24, 27].includes(call.request),
    ),
  ).toBe(false);
});
it("rejects unadvertised rates, failed acknowledgement and unsupported board before acquisition", async () => {
  const device = new FakeAirspyUsb(),
    transport = new AirspyTransport(vi.fn());
  await transport.open(device as unknown as USBDevice);
  await expect(
    transport.configure(3_000_000, 100e6, { ...DEFAULT_AIRSPY_SETTINGS }),
  ).rejects.toThrow(/does not advertise/);
  device.failRequest = 14;
  await expect(
    transport.configure(2_500_000, 100e6, { ...DEFAULT_AIRSPY_SETTINGS }),
  ).rejects.toThrow(/14/);
  expect(device.receiving).toBe(false);
  await transport.close();
});
it("distinguishes the Mini rate profile and powers down bias tee on close", async () => {
  const device = new FakeAirspyUsb();
  device.rates = [6_000_000, 3_000_000];
  const transport = new AirspyTransport(vi.fn());
  expect(
    (await transport.open(device as unknown as USBDevice)).rateProfile,
  ).toBe("mini");
  await transport.configure(3_000_000, 100e6, {
    ...DEFAULT_AIRSPY_SETTINGS,
    biasTee: true,
  });
  expect(device.bias).toBe(true);
  await transport.close();
  await transport.close();
  expect(device.bias).toBe(false);
});
