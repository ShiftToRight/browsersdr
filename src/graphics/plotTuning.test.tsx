// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WebGpuSpectrum } from "./WebGpuSpectrum";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([145_000_000, 10_000_000, 99_700_000])("plot center uses source frequency %i without the old FM clamp", async (center) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  const tune = vi.fn();
  const pipeline = { subscribe: () => () => {} } as unknown as AnalysisPipeline;
  try {
    await act(async () => root.render(<WebGpuSpectrum pipeline={pipeline} session={{ ...SYNTHETIC_DEMO_SESSION, hardwareCenterFrequencyHz: center, selectedChannelFrequencyHz: center - 100_000 }} onTune={tune} />));
    const canvas = element.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000 } as DOMRect);
    await act(async () => canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 600 })));
    expect(tune).toHaveBeenCalledExactlyOnceWith(center);
    await act(async () => root.render(<WebGpuSpectrum pipeline={pipeline} session={{ ...SYNTHETIC_DEMO_SESSION, hardwareCenterFrequencyHz: center, selectedChannelFrequencyHz: center }} onTune={tune} />));
    await act(async () => canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 600 })));
    expect(tune).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); element.remove();
  }
});
