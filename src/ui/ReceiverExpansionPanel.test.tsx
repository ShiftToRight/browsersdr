// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReceiverExpansionPanel from "./ReceiverExpansionPanel";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";
import { DEFAULT_RTL_INPUT } from "../radio/rtlInput";
import { DEFAULT_HACKRF_RX_SETTINGS } from "../radio/sourceCapabilities";
import { runGainSetup } from "../radio/gainSetup";
vi.mock("../radio/gainSetup", () => ({ runGainSetup: vi.fn() }));

let root: Root;
let snapshot: ReceiverSnapshot;
let listeners: Set<() => void>;
let controller: ReceiverController;
let props: ComponentProps<typeof ReceiverExpansionPanel>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  snapshot = {
    lifecycle: "running",
    message: "Receiving",
    sessionGeneration: 1,
    session: {
      ...SYNTHETIC_DEMO_SESSION,
      source: "rtl-sdr",
      mode: "WBFM",
      sessionGeneration: 1,
    },
  };
  listeners = new Set();
  controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ReceiverController;
  props = {
    active: true,
    vfoTarget: null,
    watchTarget: null,
    controller,
    pipeline: {
      getInputLevel: () => undefined,
      setInputLevelEnabled: vi.fn(),
    } as unknown as AnalysisPipeline,
    receiver: snapshot,
    source: "rtl-sdr",
    input: { ...DEFAULT_RTL_INPUT },
    onInput: vi.fn(),
    hardware: { ...DEFAULT_HACKRF_RX_SETTINGS },
    onHardware: vi.fn(),
    favorites: [],
    volume: 0.5,
    blocked: false,
    onOperationChange: vi.fn(),
    recordings: [],
    onRecordings: vi.fn(),
  };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function click(text: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((el) => el.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it("health follows passive decoder publications even when App's lifecycle snapshot is unchanged", async () => {
  const staleAppSnapshot = props.receiver;
  await act(async () => root.render(<ReceiverExpansionPanel {...props} />));
  expect(listeners.size).toBe(0);
  expect(props.pipeline.setInputLevelEnabled).toHaveBeenLastCalledWith(false);
  await click("Reception health");
  expect(props.pipeline.setInputLevelEnabled).toHaveBeenLastCalledWith(true);
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "No checked RDS groups yet",
  );
  snapshot = {
    ...snapshot,
    rds: {
      validGroups: 1358,
      pi: "D431",
      programmeService: "Test FM",
      radioText: null,
    },
  };
  await act(async () => listeners.forEach((listener) => listener()));
  expect(props.receiver).toBe(staleAppSnapshot);
  expect(props.receiver.rds).toBeUndefined();
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "1,358 validated RDS groups",
  );
  expect(document.querySelector("dialog[open]")?.textContent).not.toContain(
    "No checked RDS groups yet",
  );
  await click("Done");
  expect(listeners.size).toBe(0);
  expect(props.pipeline.setInputLevelEnabled).toHaveBeenLastCalledWith(false);
  snapshot = { ...snapshot, rds: { ...snapshot.rds!, validGroups: 1400 } };
  await click("Reception health");
  expect(document.querySelector("dialog[open]")?.textContent).toContain(
    "1,400 validated RDS groups",
  );
  expect(props.onInput).not.toHaveBeenCalled();
  expect(props.onHardware).not.toHaveBeenCalled();
});
it("closing health cancels guided gain and releases operation ownership", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(runGainSetup).mockImplementation(
    async (_controller, _level, cancellation) => {
      signal = cancellation;
      await new Promise<void>((resolve) =>
        cancellation.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  await act(async () => root.render(<ReceiverExpansionPanel {...props} />));
  await click("Reception health");
  const toggle = document.querySelector<HTMLInputElement>(
    "dialog[open] input[type=checkbox]",
  )!;
  await act(async () => toggle.click());
  await click("Set input headroom");
  expect(signal?.aborted).toBe(false);
  await click("Done");
  expect(signal?.aborted).toBe(true);
  expect(props.onOperationChange).toHaveBeenLastCalledWith(false);
});
