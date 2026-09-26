import { describe, expect, it, vi } from "vitest";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import {
  BladeRfTransport,
  BLADERF_HIGH_RATE_READ_SLOTS,
  BLADERF_READ_SLOTS,
} from "./bladerfTransport";

describe("bladeRF xA4 WebUSB transport", () => {
  it("opens an already-authorized device without a chooser", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();

    await transport.open(device);

    expect(device.opened).toBe(true);
    await transport.close();
  });

  it("requests only 2cf0:5250, streams bounded SC16 slots, and stops RX", async () => {
    const device = new FakeBladeRfUsb();
    const requestDevice = vi.fn(async () => device);
    const transport = new BladeRfTransport();
    await transport.requestAndOpen({ requestDevice } as USB);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: 0x2cf0, productId: 0x5250 }],
    });
    const session = await transport.configure(
      {
        centerFrequencyHz: 100_000_000,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      7,
    );
    const blocks: unknown[] = [];
    await transport.startRx(
      (block) => blocks.push(block),
      (ready) => expect(ready).toEqual(session),
    );
    expect(transport.diagnostics.pendingOperations).toBe(BLADERF_READ_SLOTS);
    device.deliverSamples([-2048, 2047, 0, 1]);
    await Promise.resolve();
    await Promise.resolve();
    expect(blocks).toEqual([
      expect.objectContaining({
        generation: 7,
        encoding: "ci16_le_sc11",
        complexSampleCount: 2,
        firstSampleIndex: 0,
      }),
    ]);
    await transport.stopRx();
    expect(device.lifecycle.slice(-3)).toEqual([
      "rx:off",
      "alternate:0",
      "alternate:1",
    ]);
    await transport.close();
    expect(device.opened).toBe(false);
  });

  it("doubles the bounded USB scheduling window at experimental 19.2 MS/s", async () => {
    const device = new FakeBladeRfUsb();
    const transport = new BladeRfTransport();
    await transport.requestAndOpen({
      requestDevice: async () => device,
    } as USB);
    await transport.configure(
      {
        centerFrequencyHz: 100_000_000,
        sampleRateHz: 19_200_000,
        bandwidthHz: 19_200_000,
      },
      8,
    );
    expect(transport.diagnostics).toMatchObject({
      readSlotsHighWater: BLADERF_HIGH_RATE_READ_SLOTS,
      rawSlotBytesLimit: BLADERF_HIGH_RATE_READ_SLOTS * 65_536,
    });
    await transport.startRx(
      () => undefined,
      () => undefined,
    );
    expect(transport.diagnostics.pendingOperations).toBe(
      BLADERF_HIGH_RATE_READ_SLOTS,
    );
    await transport.stopRx();
    await transport.close();
  });

  it("aborts pending WebUSB reads by resetting the RF-link alternate", async () => {
    const device = new FakeBladeRfUsb();
    device.rxStopSettlesReads = false;
    const transport = new BladeRfTransport();
    await transport.open(device);
    await transport.configure(
      {
        centerFrequencyHz: 178_352_000,
        sampleRateHz: 2_400_000,
        bandwidthHz: 2_400_000,
      },
      9,
    );
    await transport.startRx(
      () => undefined,
      () => undefined,
    );

    await transport.stopRx();

    expect(transport.diagnostics.pendingOperations).toBe(0);
    expect(device.lifecycle.slice(-3)).toEqual([
      "rx:off",
      "alternate:0",
      "alternate:1",
    ]);
    await transport.close();
  });
});
