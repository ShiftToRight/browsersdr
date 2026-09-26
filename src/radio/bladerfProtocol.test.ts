import { describe, expect, it } from "vitest";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import { BLADERF_PROTOCOL_PROFILE, BladeRfProtocol, packBladeRfRficRequest, unpackBladeRfRficResponse } from "./bladerfProtocol";

describe("bladeRF xA4 protocol", () => {
  it("packs the public NIOS 16x64 RFIC format byte-for-byte", () => {
    const packet = packBladeRfRficRequest(true, 4, 0, 100_000_000n);
    expect([...packet]).toEqual([0x45, 0x01, 0x01, 0, 4, 0, 0, 0xe1, 0xf5, 5, 0, 0, 0, 0, 0, 0]);
    const response = Uint8Array.from(packet); response[2] = response[2]! | 2;
    expect(unpackBladeRfRficResponse(response, true, 4, 0)).toBe(100_000_000n);
  });

  it("discovers pinned firmware/gateware and configures RX0 without TX or flashing", async () => {
    const usb = new FakeBladeRfUsb(); await usb.open(); await usb.selectConfiguration(1); await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb);
    const identity = await protocol.open();
    expect(identity).toMatchObject({ kind: "bladerf-2-micro-xa4", firmware: { major: 2, minor: 4 }, fpga: { major: 0, minor: 15, patch: 3 } });
    const details = await protocol.configure({ centerFrequencyHz: 109_000_000, sampleRateHz: 19_200_000, bandwidthHz: 19_200_000 });
    expect(details).toMatchObject({ protocolProfile: BLADERF_PROTOCOL_PROFILE, nativeEncoding: "ci16_le_sc11", nativeSampleRateHz: 19_200_000, acceptedSampleRateHz: 19_200_000, effectiveSampleRateHz: 2_400_000, acceptedCenterFrequencyHz: 109_000_000, gainMode: "slow-attack-agc" });
    await protocol.setRxEnabled(true); await protocol.setRxEnabled(false);
    expect(usb.vendorRequests).not.toContain(5); // firmware TX command
    expect(usb.lifecycle).toContain("rx:on"); expect(usb.lifecycle).toContain("rx:off");
  });

  it("loads the firmware-compatible hostedxA4 image into volatile RAM when the FPGA is empty", async () => {
    const missing = new FakeBladeRfUsb(); missing.fpgaConfigured = false; await missing.open(); await missing.selectConfiguration(1); await missing.claimInterface(0);
    const statuses: string[] = [];
    const protocol = new BladeRfProtocol(missing, {
      loadImage: async (image) => {
        expect(image).toMatchObject({ model: "xA4", version: "0.15.3", byteLength: 2_632_660 });
        return new Uint8Array(image.byteLength);
      },
      statusChanged: (message) => statuses.push(message),
    });
    await expect(protocol.open()).resolves.toMatchObject({
      fpga: { major: 0, minor: 15, patch: 3 },
      volatileImage: { model: "xA4", version: "0.15.3" },
    });
    expect(missing.lifecycle).toContain("alternate:3");
    expect(missing.lifecycle).toContain("fpga:begin");
    expect(missing.lifecycle).toContain("fpga:write:2632660");
    expect(statuses).toEqual(expect.arrayContaining([expect.stringMatching(/Verifying/), expect.stringMatching(/volatile FPGA RAM/), expect.stringMatching(/verifying the hosted profile/)]));
    expect(missing.vendorRequests).not.toContain(5);
  });

  it("rejects an invalid imported image before beginning FPGA programming", async () => {
    const missing = new FakeBladeRfUsb(); missing.fpgaConfigured = false; await missing.open(); await missing.selectConfiguration(1); await missing.claimInterface(0);
    await expect(new BladeRfProtocol(missing, { loadImage: async () => new Uint8Array(16) }).open()).rejects.toThrow(/image length/i);
    expect(missing.lifecycle).not.toContain("alternate:3");
    expect(missing.lifecycle).not.toContain("fpga:begin");
  });

  it("loads hostedxA4 0.16.0 for firmware 2.5 and newer", async () => {
    const usb = new FakeBladeRfUsb(); usb.fpgaConfigured = false; usb.firmware = { major: 2, minor: 6 }; usb.fpga = { major: 0, minor: 16, patch: 0 };
    await usb.open(); await usb.selectConfiguration(1); await usb.claimInterface(0);
    const identity = await new BladeRfProtocol(usb, { loadImage: async (image) => {
      expect(image).toMatchObject({ model: "xA4", version: "0.16.0" });
      return new Uint8Array(image.byteLength);
    } }).open();
    expect(identity).toMatchObject({ firmware: { major: 2, minor: 6 }, fpga: { major: 0, minor: 16, patch: 0 }, volatileImage: { version: "0.16.0" } });
  });

  it("accepts and records small AD9361 rate and LO quantization", async () => {
    const usb = new FakeBladeRfUsb(); usb.sampleRateReadbackOffset = -7; usb.frequencyReadbackOffset = 2;
    await usb.open(); await usb.selectConfiguration(1); await usb.claimInterface(0);
    const protocol = new BladeRfProtocol(usb); await protocol.open();
    await expect(protocol.configure({ centerFrequencyHz: 100_000_000, sampleRateHz: 2_400_000, bandwidthHz: 2_400_000 })).resolves.toMatchObject({
      nativeSampleRateHz: 2_400_000,
      acceptedSampleRateHz: 2_399_993,
      requestedCenterFrequencyHz: 100_000_000,
      acceptedCenterFrequencyHz: 100_000_002,
    });
  });

  it("rejects unpinned configured gateware without enabling RX or TX", async () => {

    const old = new FakeBladeRfUsb(); old.fpga = { major: 0, minor: 14, patch: 0 }; await old.open(); await old.selectConfiguration(1); await old.claimInterface(0);
    await expect(new BladeRfProtocol(old).open()).rejects.toThrow(/pinned receive profile/i);
    expect(old.vendorRequests).not.toContain(5);
  });
});
