import { expect, it } from "vitest";
import { FakeHackrfUsb } from "../testing/hackrfUsbFixture";
import { HackrfProtocol } from "./hackrfProtocolDriver";
import { HackrfTransport } from "./hackrfTransport";
import { DEFAULT_HACKRF_RX_SETTINGS } from "./sourceCapabilities";
import type { HackrfControlIo } from "./hackrfProtocol";

it.each([0x0109, 0x0110, 0x0113])(
  "sends exact scoped antenna power commands and retains gain/rate on API %i",
  async (api) => {
    const usb = new FakeHackrfUsb(api),
      transport = new HackrfTransport({});
    await transport.open(usb);
    const config = {
      generation: 1,
      centerFrequencyHz: 100e6,
      sampleRateHz: 1_024_000 as const,
      settings: { ...DEFAULT_HACKRF_RX_SETTINGS },
    };
    const previous = await transport.configure(config);
    const setup = (
      request: number,
      value: number,
      index: number,
    ): USBControlTransferParameters => ({
      requestType: "vendor",
      recipient: "device",
      request,
      value,
      index,
    });
    const io: HackrfControlIo = {
      now: () => performance.now(),
      pause: async () => undefined,
      input: async (request, value, index, length) =>
        (await usb.controlTransferIn(setup(request, value, index), length))
          .data!,
      output: async (request, value, index, data) => {
        await usb.controlTransferOut(
          setup(request, value, index),
          data ?? new Uint8Array(0),
        );
      },
    };
    const protocol = new HackrfProtocol(io);
    usb.radio.set(0, 1n);
    const before = usb.calls.length;
    const powered = await protocol.updateRxSettings(
      previous.details.capabilities.identity,
      {
        ...config,
        settings: { ...config.settings, antennaPowerEnabled: true },
      },
      previous,
    );
    const writes = usb.calls
      .slice(before)
      .filter((call) => call.direction === "out");
    expect(
      writes.map((call) => [
        call.setup.request,
        call.setup.value,
        call.setup.index,
        call.bytes,
      ]),
    ).toEqual([[23, 1, 0, []]]);
    expect(powered.details.captureSettings.antennaPowerEnabled).toBe(true);
    expect(previous.details.captureSettings.antennaPowerEnabled).toBe(false);
    expect(powered.details.nativeSampleRateHz).toBe(
      previous.details.nativeSampleRateHz,
    );
    const disabled = await protocol.updateRxSettings(
      previous.details.capabilities.identity,
      config,
      powered,
    );
    expect(disabled.details.captureSettings.antennaPowerEnabled).toBe(false);
    expect(
      usb.calls.filter((call) => call.setup.request === 23).at(-1)?.setup.value,
    ).toBe(0);
    await transport.close();
    expect(
      usb.calls.filter((call) => call.setup.request === 23).at(-1)?.setup.value,
    ).toBe(0);
  },
);

it("rejects a failed power command without publishing accepted power metadata", async () => {
  const usb = new FakeHackrfUsb(0x0110),
    transport = new HackrfTransport({});
  await transport.open(usb);
  const config = {
    generation: 1,
    centerFrequencyHz: 100e6,
    sampleRateHz: 1_024_000 as const,
    settings: { ...DEFAULT_HACKRF_RX_SETTINGS },
  };
  const previous = await transport.configure(config);
  const protocol = new HackrfProtocol({
    now: () => 0,
    pause: async () => undefined,
    input: async () => new DataView(new ArrayBuffer(8)),
    output: async (request) => {
      if (request === 23) throw new Error("USB rejected power");
    },
  });
  await expect(
    protocol.updateRxSettings(
      previous.details.capabilities.identity,
      {
        ...config,
        settings: { ...config.settings, antennaPowerEnabled: true },
      },
      previous,
    ),
  ).rejects.toThrow(/rejected/);
  expect(previous.details.captureSettings.antennaPowerEnabled).toBe(false);
  await transport.close();
});
