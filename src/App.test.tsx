// @vitest-environment jsdom

import { StrictMode, act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppResourceOwner, selectAuthorizedUsbDevice, usbDeviceMatchesSource, waitForCaptureDelay, waitForRecordingCompletion } from "./App";
import { AnalysisPipeline } from "./dsp/analysisPipeline";
import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "./dsp/spectrumProtocol";

class InstrumentedWorker {
  onmessage: ((event: MessageEvent<AnalysisWorkerOutput>) => void) | null = null;
  readonly sent: AnalysisWorkerInput[] = [];
  readonly terminate = vi.fn();

  postMessage(message: AnalysisWorkerInput): void {
    this.sent.push(message);
    if (message.type === "samples") {
      this.onmessage?.({ data: {
        type: "samples-ack",
        sessionGeneration: message.sessionGeneration,
        processingTimeMs: 0.25,
        backend: "JavaScript reference",
        backendStartupMs: 0.1,
        I: message.I,
        Q: message.Q,
      } } as unknown as MessageEvent<AnalysisWorkerOutput>);
    }
  }
}

const METADATA = {
  source: "synthetic" as const,
  sessionGeneration: 1,
  requestedSampleRateHz: 48_000,
  actualSampleRateHz: 48_000,
  hardwareCenterFrequencyHz: 10_000_000,
  selectedChannelFrequencyHz: 10_000_000,
  mode: "AM" as const,
  channelBandwidthHz: 8_000,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("matches authorized B205 reconnects only to the frozen VID/PID", () => {
  expect(
    usbDeviceMatchesSource(
      { vendorId: 0x2500, productId: 0x0022 } as USBDevice,
      "usrp-b205",
    ),
  ).toBe(true);
  expect(
    usbDeviceMatchesSource(
      { vendorId: 0x2500, productId: 0x0021 } as USBDevice,
      "usrp-b205",
    ),
  ).toBe(false);
  expect(
    usbDeviceMatchesSource(
      { vendorId: 0x2500, productId: 0x0022 } as USBDevice,
      "rtl-sdr",
    ),
  ).toBe(false);
});

it("prefers the re-enumerated B205 runtime identity over a retained bootloader permission", () => {
  const configuration = (interfaces: number[]) => ({
    configurationValue: 1,
    interfaces: interfaces.map((interfaceNumber) => ({ interfaceNumber })),
  }) as unknown as USBConfiguration;
  const bootloader = {
    vendorId: 0x2500,
    productId: 0x0022,
    serialNumber: "0000000004BE",
    configurations: [configuration([0])],
  } as unknown as USBDevice;
  const runtime = {
    vendorId: 0x2500,
    productId: 0x0022,
    serialNumber: "34BC216",
    configurations: [configuration([0, 1, 2, 3, 4])],
  } as unknown as USBDevice;

  expect(selectAuthorizedUsbDevice([bootloader, runtime], "usrp-b205")).toBe(runtime);
  expect(selectAuthorizedUsbDevice([bootloader], "usrp-b205")).toBe(bootloader);
});

it("recreates the analysis worker across a real StrictMode cleanup and leaves none after unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workers: InstrumentedWorker[] = [];
  const processed: number[] = [];
  const createAnalysis = () => {
    const worker = new InstrumentedWorker();
    workers.push(worker);
    return new AnalysisPipeline(worker as unknown as Worker, "javascript");
  };
  const Probe = ({ pipeline }: { pipeline: AnalysisPipeline }) => {
    useEffect(() => {
      const receiver = pipeline.begin(METADATA);
      receiver.receiveSamples({ I: new Float32Array(16), Q: new Float32Array(16), frequency: 10_000_000 });
      processed.push(pipeline.getDiagnostics().processedBlocks);
      return () => pipeline.stop(METADATA.sessionGeneration);
    }, [pipeline]);
    return null;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      <StrictMode>
        <AppResourceOwner createAnalysis={createAnalysis}>
          {({ analysis }) => <Probe pipeline={analysis} />}
        </AppResourceOwner>
      </StrictMode>,
    );
  });

  expect(workers).toHaveLength(2);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(workers[1]!.sent.some((message) => message.type === "samples")).toBe(true);
  expect(processed.at(-1)).toBe(1);

  await act(async () => { root.unmount(); });
  await vi.waitFor(() => expect(workers[1]!.terminate).toHaveBeenCalledOnce());
  expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
});

it("cancels delayed survey capture timers without phantom completion", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const completed = vi.fn();
  const pending = waitForCaptureDelay(10_000, abort.signal).then(completed);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.runAllTimersAsync();
  expect(completed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("ends a survey capture wait promptly when the source fails", async () => {
  vi.useFakeTimers();
  let lifecycle = "running" as "running" | "error";
  const controller = {
    getSnapshot: () => ({ lifecycle }),
    getRecordingStatus: () => lifecycle === "running" ? { state: "recording" as const, bytes: 2, maxBytes: 64, sampleCount: 1 } : undefined,
  };
  const completed = vi.fn();
  const pending = waitForRecordingCompletion(controller as never, 10_000, new AbortController().signal).then(completed);
  await vi.advanceTimersByTimeAsync(100);
  lifecycle = "error";
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(completed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
