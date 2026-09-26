import { describe, expect, it, vi } from "vitest";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import { BladeRfProtocol } from "./bladerfProtocol";
import { BladeRfSampleAdapter } from "./bladerfSource";

describe("bladeRF SC16 Q11 adapter", () => {
  it("normalizes little-endian signed Q11 samples and preserves I/Q orientation", async () => {
    const usb = new FakeBladeRfUsb(); await usb.open(); await usb.selectConfiguration(1); await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb); await protocol.open();
    const details = await protocol.configure({ centerFrequencyHz: 100_000_000, sampleRateHz: 2_400_000, bandwidthHz: 2_400_000 });
    const receiveSamples = vi.fn();
    const adapter = new BladeRfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples });
    adapter.ready({ generation: 1, hardwareCenterFrequencyHz: 100_000_000, details });
    const bytes = new Uint8Array(8); const view = new DataView(bytes.buffer);
    view.setInt16(0, -2048, true); view.setInt16(2, 2047, true); view.setInt16(4, 1024, true); view.setInt16(6, -1024, true);
    adapter.receive({ bytes, encoding: "ci16_le_sc11", sampleOrder: "interleaved-iq", bytesPerComplexSample: 4,
      complexSampleCount: 2, nativeSampleRateHz: 2_400_000, generation: 1, sequence: 0, firstSampleIndex: 0, receivedAtMonotonicMs: 0 });
    const block = receiveSamples.mock.calls[0]![0];
    expect([...block.I]).toEqual([-1, 0.5]); expect([...block.Q]).toEqual([2047 / 2048, -0.5]); expect(block.frequency).toBe(100_000_000);
  });

  it("routes native SC16 directly to the wideband workers without main-thread normalization", async () => {
    const usb = new FakeBladeRfUsb(); await usb.open(); await usb.selectConfiguration(1); await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb); await protocol.open();
    const details = await protocol.configure({ centerFrequencyHz: 100_000_000, sampleRateHz: 19_200_000, bandwidthHz: 19_200_000 });
    const receiveSc16 = vi.fn(() => true), receiveSamples = vi.fn();
    const adapter = new BladeRfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples, receiveSc16 });
    adapter.ready({ generation: 1, hardwareCenterFrequencyHz: 100_000_000, details });
    const bytes = Uint8Array.of(0, 4, 0, 252);
    adapter.receive({ bytes, encoding: "ci16_le_sc11", sampleOrder: "interleaved-iq", bytesPerComplexSample: 4,
      complexSampleCount: 1, nativeSampleRateHz: 19_200_000, generation: 1, sequence: 0, firstSampleIndex: 0, receivedAtMonotonicMs: 0 });
    expect(receiveSc16).toHaveBeenCalledWith(bytes, 100_000_000);
    expect(receiveSamples).not.toHaveBeenCalled();
  });
});
