// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CenterSignalControl } from "./CenterSignalControl";
import { ReceiverController } from "../radio/receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SignalCenterResult } from "../dsp/signalCenter";
import type { SourceSessionMetadata } from "../radio/types";
let root: Root | undefined;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let metadata: SourceSessionMetadata = {
    source: "replay",
    sessionGeneration: 1,
    requestedSampleRateHz: 1_024_000,
    actualSampleRateHz: 1_024_000,
    hardwareCenterFrequencyHz: 100_000_000,
    selectedChannelFrequencyHz: 100_120_000,
    mode: "AM",
    channelBandwidthHz: 12_500,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const tune = vi.fn(
    async (frequencyHz: number) =>
      (metadata = { ...metadata, selectedChannelFrequencyHz: frequencyHz }),
  );
  const controller = new ReceiverController(() => ({
    start: async () => metadata,
    stop: async () => {},
    tune,
    setVolume: () => {},
    setGain: async () => null,
    configureMode: async () => metadata,
  }));
  await controller.start({
    source: "replay",
    channelFrequencyHz: metadata.selectedChannelFrequencyHz,
    volume: 0,
  });
  let resolve!: (result: SignalCenterResult) => void;
  const measureSignalCenter = vi.fn(
    () =>
      new Promise<SignalCenterResult>((r) => {
        resolve = r;
      }),
  );
  const cancelSignalCenter = vi.fn();
  const analysis = {
    measureSignalCenter,
    cancelSignalCenter,
  } as unknown as AnalysisPipeline;
  const host = document.createElement("div");
  root = createRoot(host);
  const accepted = vi.fn();
  const render = async (disabled = false, key = "initial") => {
    await act(async () =>
      root!.render(
        <StrictMode>
          <CenterSignalControl
            controller={controller}
            analysis={analysis}
            disabled={disabled}
            contextKey={key}
            onAccepted={accepted}
          />
        </StrictMode>,
      ),
    );
  };
  await render();
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    )!;
    await act(async () => button.click());
  };
  return {
    host,
    tune,
    accepted,
    measureSignalCenter,
    cancelSignalCenter,
    render,
    click,
    result: async (value: SignalCenterResult) => {
      await act(async () => resolve(value));
    },
  };
}
it("shows measurement, one correction and Undo under StrictMode", async () => {
  const ui = await setup();
  await ui.click("Fine-tune signal");
  expect(ui.host.textContent).toContain("Measuring");
  expect(ui.host.querySelector("button")!.disabled).toBe(true);
  await ui.result({
    kind: "estimate",
    offsetHz: 1500,
    toleranceHz: 25,
    message: "OK",
  });
  expect(ui.tune).toHaveBeenCalledTimes(1);
  expect(ui.host.textContent).toContain("Corrected +1,500 Hz");
  await ui.click("Undo fine-tune");
  expect(ui.tune).toHaveBeenCalledTimes(2);
  expect(ui.host.textContent).toContain("Previous frequency restored");
});
it("disables unsupported/blocked controls and cancels pending input changes", async () => {
  const ui = await setup();
  await ui.render(true);
  await ui.click("Fine-tune signal");
  expect(ui.measureSignalCenter).not.toHaveBeenCalled();
  await ui.render();
  await ui.click("Fine-tune signal");
  await ui.render(true, "edited");
  await ui.result({
    kind: "estimate",
    offsetHz: 1500,
    toleranceHz: 25,
    message: "OK",
  });
  expect(ui.tune).not.toHaveBeenCalled();
  expect(ui.cancelSignalCenter).toHaveBeenCalled();
  expect(ui.host.textContent).toContain("cancelled");
});
it("displays no clear signal, already centered and actionable measurement failure", async () => {
  const ui = await setup();
  for (const result of [
    { kind: "no-signal", message: "No clear signal: noise." },
    { kind: "estimate", offsetHz: 5, toleranceHz: 25, message: "OK" },
    {
      kind: "failure",
      message: "Samples interrupted; retry after reception settles.",
    },
  ] as SignalCenterResult[]) {
    await ui.click("Fine-tune signal");
    await ui.result(result);
    expect(ui.host.textContent).toContain(
      result.kind === "estimate" ? "Already centered" : result.message,
    );
  }
  expect(ui.tune).not.toHaveBeenCalled();
});
