// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InputClippingWarning } from "./InputClippingWarning";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

it("keeps the compact warning slot through warning onset, clearing and source changes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host);
  const session = { ...SYNTHETIC_DEMO_SESSION, source: "rtl-sdr" as const };
  let clipped = false;
  const pipeline = {
    getInputClipping: () =>
      clipped ? { clippedFraction: 0.03, sampledComponents: 1024 } : undefined,
  };
  try {
    await act(async () =>
      root.render(
        <InputClippingWarning
          pipeline={pipeline}
          session={session}
          running
          compact
        />,
      ),
    );
    const slot = host.querySelector(".input-clipping-slot");
    expect(slot).not.toBeNull();
    expect(host.querySelector("details")).toBeNull();
    clipped = true;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector(".input-clipping-slot")).toBe(slot);
    expect(host.querySelector("summary")?.textContent).toContain("3.0%");
    expect(host.querySelector("p")?.textContent).toContain("Reduce RF gain");
    await act(async () =>
      root.render(
        <InputClippingWarning
          pipeline={pipeline}
          session={{ ...session, sessionGeneration: 2 }}
          running
          compact
        />,
      ),
    );
    expect(host.querySelector("details")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector("details")).not.toBeNull();
    clipped = false;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(host.querySelector(".input-clipping-slot")).toBe(slot);
    expect(host.querySelector("details")).toBeNull();
    await act(async () =>
      root.render(
        <InputClippingWarning
          pipeline={pipeline}
          session={session}
          running={false}
          compact
        />,
      ),
    );
    expect(host.querySelector(".input-clipping-slot")).toBe(slot);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
