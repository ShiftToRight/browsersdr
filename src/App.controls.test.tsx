// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReceiverApp } from "./App";
import { AnalysisPipeline } from "./dsp/analysisPipeline";
import { ReceiverController, type ReceiverBackend, type ReceiverStartOptions } from "./radio/receiverController";
import { hackrfRecordingFixture } from "./testing/hackrfRecordingFixture";
import type { SourceSessionMetadata } from "./radio/types";
vi.mock("./graphics/WebGpuSpectrum", () => ({ WebGpuSpectrum: () => null }));
vi.mock("./ui/SpectrumExplorer", () => ({ SpectrumExplorer: () => null }));
let root: Root;
let controller: ReceiverController;
let analysis: AnalysisPipeline;
let metadata: SourceSessionMetadata;
let options: ReceiverStartOptions[];
let closeFailures = 0;
let closes = 0;
let hardwareCalls = 0;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); options = []; closes = 0; closeFailures = 0; hardwareCalls = 0;
  metadata = (await hackrfRecordingFixture()).session;
  const backend: ReceiverBackend = {
    connect: async (value) => { options.push(value); return { ...metadata, hardwareCenterFrequencyHz: value.channelFrequencyHz, selectedChannelFrequencyHz: value.channelFrequencyHz }; },
    start: async (value) => { options.push(value); return metadata; },
    stop: async () => undefined,
    disconnect: async () => { closes++; if (closeFailures-- > 0) throw new Error("USB close failed"); },
    tune: async () => metadata,
    setVolume: () => undefined,
    setGain: async () => null,
    configureMode: async () => metadata,
    configureHardware: async (settings) => { hardwareCalls++; metadata = { ...metadata, hackrf: { ...metadata.hackrf!, captureSettings: { ...metadata.hackrf!.captureSettings, ...settings } } }; return metadata; },
  };
  controller = new ReceiverController(() => backend);
  analysis = new AnalysisPipeline({ postMessage() {}, terminate() {} } as unknown as Worker, "javascript");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ReceiverApp controller={controller} analysis={analysis} replayRef={{ current: undefined }} />));
});
afterEach(async () => {
  closeFailures = 0;
  await act(async () => { await controller.disconnect(); root.unmount(); });
  analysis.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
function control(label: string) {
  const element = Array.from(document.querySelectorAll("label")).find(node => node.textContent?.trim().startsWith(label))?.querySelector("input,select");
  if (!element) throw new Error(`Missing control ${label}`);
  return element as HTMLInputElement | HTMLSelectElement;
}
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function toggle(element: HTMLInputElement) {
  await act(async () => element.click());
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
it("exposes independent Pro stages, validates gain drafts before commands and shows accepted values", async () => {
  await change(control("Source"), "hackrf");
  expect(control("RX VGA gain").value).toBe("12");
  expect(document.body.textContent).not.toContain("Automatic");
  await click("Connect");
  expect(options[0]?.source).toBe("hackrf");
  expect(options[0]).not.toHaveProperty("gainDb");
  await change(control("RX VGA gain"), "3");
  await click("Apply RX settings");
  expect(hardwareCalls).toBe(0);
  expect(document.body.textContent).toContain("even integer");
  await change(control("RX LNA state"), "33");
  await change(control("RX VGA gain"), "62");
  await toggle(control("RF amplifier") as HTMLInputElement);
  await click("Apply RX settings");
  expect(hardwareCalls).toBe(1);
  expect(controller.getSnapshot().session?.hackrf?.captureSettings).toMatchObject({ rxLnaGainCode: 33, rxVgaGainDb: 62, rfAmplifierEnabled: true, antennaPowerEnabled: false });
});
it("selects a source-compatible digital rate before connect and explains disabled routes while connected", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "DAB");
  expect(control("Sample rate").value).toBe("2400000");
  await change(control("Mode"), "AM");
  await change(control("Sample rate"), "1024000");
  await click("Connect");
  const dab = document.querySelector<HTMLOptionElement>('option[value="DAB"]')!;
  expect(dab.disabled).toBe(true);
  expect(dab.textContent).toContain("compatible sample rate");
  expect(controller.getSnapshot().session?.source).toBe("hackrf");
});
it("holds source ownership on cleanup failure and restores source-specific choices after retry", async () => {
  await change(control("Source"), "hackrf");
  await change(control("RX VGA gain"), "26");
  await click("Connect");
  closeFailures = 1;
  await change(control("Source"), "synthetic");
  expect(control("Source").value).toBe("hackrf");
  expect(controller.getSnapshot().cleanupRequired).toBe(true);
  await click("Disconnect");
  await change(control("Source"), "synthetic");
  expect(closes).toBe(2);
  expect(document.body.textContent).not.toContain("RX VGA gain");
  await change(control("Source"), "hackrf");
  expect(control("RX VGA gain").value).toBe("26");
});
