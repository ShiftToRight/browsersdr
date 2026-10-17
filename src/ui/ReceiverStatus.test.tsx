// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReceiverStatus } from "./ReceiverStatus";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("AudioContext", class {});
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render(
  overrides: Partial<ComponentProps<typeof ReceiverStatus>> = {},
) {
  await act(async () =>
    root.render(
      <ReceiverStatus
        receiver={{
          lifecycle: "running",
          message: "Receiving WBFM at 100.000 MHz",
          sessionGeneration: 1,
          audioState: "running",
        }}
        spectrum={{ kind: "ready", hasFrame: true, paused: false }}
        retained={{ status: "empty", retainedBytes: 0, downloadRequests: 0 }}
        preparing={false}
        recordingSupported
        onReceiver={() => {}}
        onSpectrum={() => {}}
        onRecording={() => {}}
        onReport={() => {}}
        {...overrides}
      >
        {null}
      </ReceiverStatus>,
    ),
  );
}

it("names replay as replay in the status and health disclosure", async () => {
  await render({ receiver: { lifecycle: "running", message: "Replaying", sessionGeneration: 1,
    session: { ...SYNTHETIC_DEMO_SESSION, source: "replay", sessionGeneration: 1 } } });
  expect(document.querySelector("summary")?.textContent).toContain("Replaying");
  expect(document.querySelector(".receiver-health-summary")?.textContent).toContain("Replaying");
});

it("keeps receiving details behind one disclosure and dismisses it with Escape or an outside pointer", async () => {
  await render();
  const menu = document.querySelector<HTMLDetailsElement>(
    ".receiver-status-menu",
  )!;
  const summary = menu.querySelector("summary")!;
  expect(summary.textContent).toBe("Receiving");
  expect(menu.open).toBe(false);
  expect(menu.textContent).toContain("Receiving WBFM at 100.000 MHz");
  expect(menu.querySelectorAll(".health-indicator")).toHaveLength(4);
  menu.open = true;
  await act(async () =>
    summary.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(summary);
  menu.open = true;
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(menu.open).toBe(false);
});

it("keeps active recording visible while reporting independent audio, spectrum and retained-file failures", async () => {
  await render({
    receiver: {
      lifecycle: "running",
      message: "Receiving",
      sessionGeneration: 1,
      audioState: "suspended",
    },
    spectrum: { kind: "unsupported", hasFrame: false, paused: false },
    recording: {
      state: "recording",
      bytes: 4096,
      maxBytes: 8192,
      sampleCount: 512,
    },
    retained: {
      status: "empty",
      retainedBytes: 0,
      downloadRequests: 0,
      error: "Storage failed",
    },
  });
  expect(document.querySelector("summary")?.textContent).toBe(
    "Recording · 3 issues",
  );
  const health = document.querySelector(".receiver-health-summary")!;
  expect(health.textContent).toContain("Receiver: ● Receiving");
  expect(health.textContent).toContain("Spectrum: Unavailable");
  expect(health.textContent).toContain("Audio: Suspended");
  expect(health.textContent).toContain("Recording: Recording");
});
