// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WebGpuSpectrum } from "./WebGpuSpectrum";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SpectrumFrame } from "../radio/types";
import { hackrfRecordingFixture } from "../testing/hackrfRecordingFixture";

afterEach(() => {
  vi.doUnmock("./gpuSpectrumSurface");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
});

it("freezes the accepted duration immediately when Pause meets a pending GPU submission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem(
    "browsersdr.spectrum-surface.v1",
    JSON.stringify({ view: "3d" }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(
    960,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(
    560,
  );
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let duration = 0;
  const accept = vi.fn((frames: readonly SpectrumFrame[]) => {
    duration = frames.at(-1)!.sampleIndex / frames.at(-1)!.sampleRateHz;
  });
  const surface = {
    accept,
    encode() {},
    dispose() {},
    reset() {},
    sceneDraws: 0,
    markerDraws: 0,
    history: { duration: () => duration, breakContinuity() {} },
  };
  vi.doMock("./gpuSpectrumSurface", () => ({
    GpuSpectrumSurface: { create: async () => surface },
  }));
  await import("./gpuSpectrumSurface");
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let released = false;
  const submit = vi.fn();
  const pass = {
    setBindGroup() {},
    setPipeline() {},
    draw() {},
    end() {},
    setViewport() {},
    setScissorRect() {},
  };
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    queue: {
      submit,
      writeBuffer() {},
      onSubmittedWorkDone: vi.fn(() =>
        released ? Promise.resolve() : pending,
      ),
    },
    lost: new Promise(() => {}),
    addEventListener() {},
    removeEventListener() {},
    destroy() {},
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createBindGroupLayout() {},
    createPipelineLayout() {},
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish() {} }),
  };
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => ({ createView() {} }),
  } as unknown as RenderingContext);
  let listener!: (
    frame: SpectrumFrame,
    frames: readonly SpectrumFrame[],
  ) => void;
  const subscribe = vi.fn((callback: typeof listener) => {
    listener = callback;
    return () => {};
  });
  const pipeline = { subscribe } as unknown as AnalysisPipeline;
  const session = {
    ...(await hackrfRecordingFixture()).session,
    sessionGeneration: 0,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WebGpuSpectrum pipeline={pipeline} session={session} active />,
      ),
    );
    expect(host.querySelector(".canvas-frame")!.className).toContain(
      "surface-active",
    );
    const frame: SpectrumFrame = {
      sessionGeneration: 0,
      sequence: 1,
      timestampMs: 0,
      sampleIndex: 7_680_000,
      hopSamples: 192512,
      sampleRateHz: 4_800_000,
      centerFrequencyHz: 118800000,
      units: "relative-dB",
      bins: new Float32Array(4096),
      droppedFramesBefore: 0,
    };
    now += 100;
    await act(async () => listener(frame, [frame]));
    const canvas = host.querySelector("canvas")!;
    expect(canvas.dataset.surfacePending).toBe("true");
    now += 40;
    const queued = { ...frame, sequence: 2, sampleIndex: 8_640_000 };
    await act(async () => listener(queued, [queued]));
    expect(host.querySelector(".waterfall-label")!.textContent).not.toBe(
      "3D history · 1.8 / 10 s · newest at front",
    );
    const submissions = submit.mock.calls.length;
    const pause = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Pause display"),
    )!;
    await act(async () => pause.click());
    expect(host.querySelector(".waterfall-label")!.textContent).toBe(
      "3D history · 1.8 / 10 s · newest at front",
    );
    expect(submit).toHaveBeenCalledTimes(submissions);
    await act(async () =>
      listener({ ...frame, sequence: 3, sampleIndex: 9_600_000 }, [
        { ...frame, sequence: 3, sampleIndex: 9_600_000 },
      ]),
    );
    expect(accept).toHaveBeenCalledTimes(2);
    await act(async () => {
      released = true;
      complete();
    });
    expect(canvas.dataset.surfacePending).toBe("false");
    expect(host.querySelector(".waterfall-label")!.textContent).toBe(
      "3D history · 1.8 / 10 s · newest at front",
    );
    expect(subscribe).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
