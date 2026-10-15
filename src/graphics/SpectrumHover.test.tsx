// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpectrumHover } from "./SpectrumHover";
import type { HoverSpectrumFrame } from "./spectrumHoverMath";

it("refreshes a stationary cursor, labels stale data and clears on coordinate changes, touch and teardown", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  const host = document.createElement("div"), canvas = document.createElement("canvas");
  document.body.append(host, canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 960, height: 560 } as DOMRect);
  const frame: { current: HoverSpectrumFrame | undefined } = { current: {
    center: 100e6, rate: 1e6, bins: new Float32Array([-50, -50]), columns: 2, floor: -100, range: 100,
  } };
  const root = createRoot(host);
  const flush = async () => act(async () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(0)); });
  const move = async (pointerType = "mouse") => act(async () => {
    const event = new MouseEvent("pointermove", { clientX: 480, clientY: 300 });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    canvas.dispatchEvent(event);
  });
  try {
    await act(async () => root.render(<SpectrumHover canvas={{ current: canvas }} frame={frame} guideGap={20} selectedHz={100e6} paused={false} stalled />));
    await move(); await flush();
    expect(host.textContent).toContain("Latest spectrum level-50 dB rel.");
    expect(host.textContent).toContain("Stale");
    frame.current = { ...frame.current!, bins: new Float32Array([-30, -30]) };
    await flush();
    expect(host.textContent).toContain("-30 dB rel.");
    frame.current = { ...frame.current!, center: 101e6 };
    await flush();
    expect(host.textContent).toBe("");
    expect(callbacks.size).toBe(0);
    await move(); await flush();
    expect(host.textContent).toContain("101.000 MHz");
    await move("touch");
    expect(host.textContent).toBe("");
    expect(callbacks.size).toBe(0);
    await move(); await flush();
    frame.current = undefined;
    await flush();
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    expect(callbacks.size).toBe(0);
    host.remove(); canvas.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
