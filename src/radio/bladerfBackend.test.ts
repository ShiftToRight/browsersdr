import { describe, expect, it, vi } from "vitest";
import { FakeBladeRfUsb } from "../testing/bladerfUsbFixture";
import { BladeRfBackend } from "./bladerfBackend";
import { DEFAULT_BLADERF_RX_SETTINGS } from "./bladerfSettings";
import type { ReceiverBackendEvents } from "./receiverController";

const samples = vi.hoisted(() => vi.fn((_bytes: Uint8Array) => true));
vi.mock("./liveReceiverPipeline", () => ({
  LiveReceiverPipeline: class {
    resume = async () => {};
    suspend = async () => {};
    close = async () => {};
    prepare = async () => {};
    requireRunning() {}
    validateRateBudget() {}
    setSampleRate() {}
    begin() {}
    reset() {}
    retune() {}
    setVolume() {}
    receiveSc16 = samples;
  },
}));

function fixture() {
  const usb = new FakeBladeRfUsb();
  const events = {
    permissionGranted: vi.fn(),
    runtimeError: vi.fn(),
    audioStateChanged: vi.fn(),
    sourceEnded: vi.fn(),
    rdsChanged: vi.fn(),
  } satisfies ReceiverBackendEvents;
  const backend = new BladeRfBackend(events);
  const options = {
    source: "bladerf" as const,
    channelFrequencyHz: 100e6,
    sampleRateHz: 4_800_000,
    volume: 0,
    bladerfSettings: { ...DEFAULT_BLADERF_RX_SETTINGS },
  };
  return { usb, events, backend, options };
}
describe("bladeRF hardware reconfiguration lifecycle", () => {
  it("applies gain stopped, switches RX while running, preserves tune, and restores defaults explicitly", async () => {
    const { usb, backend, options } = fixture();
    await backend.connectGranted(options, usb);
    const manual = {
      ...DEFAULT_BLADERF_RX_SETTINGS,
      gainMode: "manual" as const,
      manualGainDb: 20,
    };
    expect(await backend.configureBladeRf(manual, 1)).toMatchObject({
      bladerf: { rxInput: "RX1", acceptedGainDb: 20 },
    });
    expect(usb.lifecycle).not.toContain("rx:on");
    await backend.start({ ...options, bladerfSettings: manual }, 2);
    await backend.tune(100.1e6, 3);
    const accepted = await backend.configureBladeRf(
      { ...manual, rxInput: "RX2" },
      4,
    );
    expect(accepted).toMatchObject({
      hardwareCenterFrequencyHz: 100e6,
      selectedChannelFrequencyHz: 100.1e6,
      bladerf: { rxInput: "RX2", acceptedGainDb: 20 },
    });
    expect(usb.rfic.get(0x0002)).toBe(0n);
    expect(usb.rfic.get(0x0202)).toBe(1n);
    usb.deliverSamples([1024, -1024]);
    await Promise.resolve();
    expect(samples).toHaveBeenCalled();
    await backend.configureBladeRf(DEFAULT_BLADERF_RX_SETTINGS, 5);
    expect(usb.rfic.get(0x0002)).toBe(1n);
    expect(usb.rfic.get(0x0202)).toBe(0n);
    await backend.disconnect();
    expect(usb.rfic.get(0x0002)).toBe(0n);
    expect(usb.rfic.get(0x0202)).toBe(0n);
    expect(usb.opened).toBe(false);
    expect(usb.vendorRequests).not.toContain(5);
  });
  it("cancels a settings change without restarting RX or publishing the cancelled result", async () => {
    const { usb, backend, options } = fixture();
    await backend.connectGranted(options, usb);
    await backend.start(options, 1);
    const before = usb.lifecycle.filter((x) => x === "rx:on").length;
    const applying = backend.configureBladeRf(
      { ...DEFAULT_BLADERF_RX_SETTINGS, rxInput: "RX2" },
      2,
    );
    const rejected = expect(applying).rejects.toMatchObject({
      name: "AbortError",
    });
    await backend.stop();
    await rejected;
    expect(usb.lifecycle.filter((x) => x === "rx:on")).toHaveLength(before);
    await backend.disconnect();
  });
});

describe("bladeRF variant backend metadata", () => {
  it.each(["xA4", "xA5", "xA9"] as const)(
    "propagates detected %s identity and profile into metadata",
    async (model) => {
      const { usb, backend, options } = fixture();
      usb.model = model;
      const metadata = await backend.connectGranted(options, usb);
      expect(metadata.bladerf).toMatchObject({
        protocolProfile: `bladerf2-${model.toLowerCase()}-fpga-rfic-35174c3-v1`,
        hardwareValidation: "pending",
        identity: {
          model,
          variantValidation:
            model === "xA4" ? "existing-xa4-profile" : "experimental",
          volatileImage: null,
        },
        rxInput: "RX1",
      });
      await backend.disconnect();
    },
  );

  it("stop from discovery status cancels the transport before provider or programming", async () => {
    const { usb, options, events } = fixture();
    usb.fpgaConfigured = false;
    const loadImage = vi.fn();
    const backend = new BladeRfBackend(
      {
        ...events,
        statusChanged: () => {
          void backend.stop();
        },
      },
      undefined,
      0,
      { loadImage },
    );
    await expect(backend.connectGranted(options, usb)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(events.permissionGranted).not.toHaveBeenCalled();
    expect(loadImage).not.toHaveBeenCalled();
    expect(usb.vendorRequests).not.toContain(2);
    expect(usb.lifecycle).not.toContain("alternate:3");
    expect(usb.niosRequests).toHaveLength(0);
    await backend.disconnect();
  });
});

it("drains cleanup acquired by a canceled pending open before disconnect completes, and retries failed drain", async () => {
  const { usb, backend, options } = fixture();
  let reached!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const open = usb.open.bind(usb);
  usb.open = async () => {
    await open();
    reached();
    await gate;
  };
  const close = usb.close.bind(usb);
  usb.close = vi
    .fn()
    .mockRejectedValueOnce(
      new DOMException("opening cleanup rejected", "NetworkError"),
    )
    .mockRejectedValueOnce(
      new DOMException("disconnect drain rejected", "NetworkError"),
    )
    .mockImplementation(close);
  const connecting = expect(
    backend.connectGranted(options, usb),
  ).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  const disconnecting = expect(backend.disconnect()).rejects.toThrow(
    /disconnect drain/,
  );
  resume();
  await connecting;
  await disconnecting;
  expect(usb.opened).toBe(true);
  expect(usb.close).toHaveBeenCalledTimes(2);
  await backend.disconnect();
  expect(usb.close).toHaveBeenCalledTimes(3);
  expect(usb.opened).toBe(false);
});

// Disconnect retries the actual device after a rejected close.
it("retries rejected disconnect against the still-open USB device", async () => {
  const { usb, backend, options } = fixture();
  const close = usb.close.bind(usb);
  usb.close = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("close rejected", "NetworkError"))
    .mockImplementation(close);
  await backend.connectGranted(options, usb);
  await expect(backend.disconnect()).rejects.toThrow();
  expect(usb.opened).toBe(true);
  await backend.disconnect();
  expect(usb.close).toHaveBeenCalledTimes(2);
  expect(usb.opened).toBe(false);
});

describe("bladeRF native recording lifecycle", () => {
  it.each(["xA4", "xA5", "xA9"] as const)(
    "captures unchanged %s Q11 words before a DSP consumer can mutate the borrowed block",
    async (model) => {
      const { usb, backend, options } = fixture();
      usb.model = model;
      usb.sampleRateReadbackOffset = -1;
      usb.frequencyReadbackOffset = 10;
      expect(() => backend.startRecording()).toThrow(/receiving/);
      await backend.connectGranted(options, usb);
      await backend.start(options, 1);
      expect(backend.startRecording()).toMatchObject({
        state: "recording",
        sampleCount: 0,
      });
      samples.mockImplementationOnce((bytes: Uint8Array) => {
        bytes.fill(0);
        return true;
      });
      usb.deliverSamples([1024, -1024, 2047, -2048]);
      await Promise.resolve();
      expect(backend.getRecordingStatus()?.sampleCount).toBe(2);
      const recording = backend.stopRecording()!;
      const view = new DataView(
        recording.data.buffer,
        recording.data.byteOffset,
        recording.data.byteLength,
      );
      expect(
        Array.from({ length: 4 }, (_, n) => view.getInt16(n * 2, true)),
      ).toEqual([1024, -1024, 2047, -2048]);
      expect(recording.metadata).toMatchObject({
        source: "bladerf",
        format: "browsersdr-bladerf-sc16-q11-v1",
        sampleRateHz: 4_799_999,
        centerFrequencyHz: 100_000_010,
        nativeSampleRateHz: 4_800_000,
        hardware: { identity: { model } },
        stopReason: "user",
      });
      await backend.disconnect();
    },
  );

  it.each(["stop", "disconnect", "tune", "controls", "error"] as const)(
    "finalizes the original capture on %s",
    async (operation) => {
      const { usb, backend, options } = fixture();
      await backend.connectGranted(options, usb);
      await backend.start(options, 1);
      backend.startRecording();
      usb.deliverSamples([1024, -1024]);
      await Promise.resolve();
      if (operation === "tune") await backend.tune(100.1e6, 2);
      else if (operation === "controls")
        await backend.configureBladeRf(
          { ...DEFAULT_BLADERF_RX_SETTINGS, rxInput: "RX2" },
          2,
        );
      else if (operation === "error") {
        usb.deliverSamples([1024]); // Incomplete complex word pair: transport failure.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      } else await backend[operation]();
      expect(backend.getRecordingStatus()).toBeUndefined();
      const recording = backend.stopRecording()!;
      expect(recording.metadata).toMatchObject({
        selectedChannelFrequencyHz: 100e6,
        hardware: { rxInput: "RX1" },
        stopReason:
          operation === "tune" || operation === "controls"
            ? "metadata-change"
            : "source-stop",
      });
      if (operation === "error")
        expect(recording.metadata.knownGaps).toEqual([
          expect.objectContaining({ afterSample: 1, missingSamples: null }),
        ]);
      if (operation !== "disconnect") await backend.disconnect();
    },
  );

  it("rejects stale original transport generations before recording or DSP delivery", async () => {
    const { bladeRfRecordingFixture } =
      await import("../testing/bladerfRecordingFixture");
    const { details } = await bladeRfRecordingFixture();
    let callback!: (
      block: import("./bladerfTransport").BladeRfNativeBlock,
    ) => void;
    let session!: import("./bladerfTransport").BladeRfConfiguredSession;
    const transport = {
      diagnostics: { state: "configured" },
      open: async () => details.identity,
      requestAndOpen: async () => details.identity,
      configure: async (_settings: unknown, generation: number) =>
        (session = {
          generation,
          hardwareCenterFrequencyHz: details.acceptedCenterFrequencyHz,
          details,
        }),
      startRx: async (
        receive: typeof callback,
        ready: (value: typeof session) => void,
      ) => {
        callback = receive;
        ready(session);
      },
      stopRx: async () => {},
      close: async () => {},
    };
    const { events, options } = fixture();
    const backend = new BladeRfBackend(events, undefined, 99, {
      createTransport: () =>
        transport as unknown as import("./bladerfBackend").BladeRfTransportPort,
    });
    await backend.start({ ...options, sampleRateHz: 2_400_000 }, 99);
    backend.startRecording();
    const block = {
      bytes: Uint8Array.of(0, 4, 0, 252),
      encoding: "ci16_le_sc11" as const,
      sampleOrder: "interleaved-iq" as const,
      bytesPerComplexSample: 4 as const,
      complexSampleCount: 1,
      nativeSampleRateHz: 2_400_000,
      generation: session.generation - 1,
      sequence: 0,
      firstSampleIndex: 0,
      receivedAtMonotonicMs: 0,
    };
    callback(block);
    expect(backend.getRecordingStatus()?.sampleCount).toBe(0);
    callback({ ...block, generation: session.generation });
    expect(backend.getRecordingStatus()?.sampleCount).toBe(1);
    expect(backend.stopRecording()!.data).toEqual(block.bytes);
    await backend.disconnect();
  });
});

it.each(["xA4", "xA5", "xA9"] as const)("captures a reduced %s channel with RFIC readback timing", async (model) => {
  const { usb, backend, options, events } = fixture();
  usb.model = model;
  usb.sampleRateReadbackOffset = -1;
  await backend.connectGranted({ ...options, modeSettings: { mode: "AM", bandwidthHz: 15_000, squelch: 0 } }, usb);
  await backend.start({ ...options, modeSettings: { mode: "AM", bandwidthHz: 15_000, squelch: 0 } }, 1);
  backend.startRecording(undefined, { captureCurrentChannel: true });
  usb.deliverSamples(Array.from({ length: 8192 }, () => 512));
  await Promise.resolve();
  const recording = backend.stopRecording()!;
  expect(recording.metadata).toMatchObject({ format: "browsersdr-channel-iq-v1", source: "bladerf", sampleEncoding: "signed-16-bit-little-endian", channelCapture: { inputSampleRateHz: 4_799_999, dspSampleRateHz: 75_000 } });
  expect(recording.metadata.sampleCount).toBe(64);
  expect(recording.metadata.sampleRateHz).toBe(4_799_999 / 64);
  expect(events.runtimeError).not.toHaveBeenCalled();
  await backend.disconnect();
});
