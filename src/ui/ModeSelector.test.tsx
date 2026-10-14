// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ModeSelector, type ModeSelectorProps } from "./ModeSelector";
import { QUICK_MODES_KEY } from "./modeQuickList";

let root: Root, host: HTMLDivElement, props: ModeSelectorProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    value: "WBFM",
    contextKey: "first",
    unavailableReason: () => undefined,
    configurationPreview: () => "Channel preview",
    onChange: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<ModeSelector {...props} />));
}
const named = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const textButton = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === name,
  )!;
async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}
async function open() {
  await click(textButton("More modes…"));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}
it("opens passively with seven quick modes and applies only the selected mode deliberately", async () => {
  await render();
  expect(host.querySelectorAll("option")).toHaveLength(7);
  await open();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Search modes or decoders",
  );
  await click(named("Select DAB / DAB+"));
  expect(props.onChange).not.toHaveBeenCalled();
  expect(host.querySelector("select")?.value).toBe("WBFM");
  await click(textButton("Use mode"));
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("DAB");
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(textButton("More modes…"));
});
it("keeps unavailable modes inspectable and prevents incompatible or blocked apply", async () => {
  props.unavailableReason = (mode) =>
    mode === "DAB" ? "Requires compatible I/Q input" : undefined;
  await render();
  await open();
  await click(named("Select DAB / DAB+"));
  expect(textButton("Use mode").disabled).toBe(true);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Requires compatible I/Q input",
  );
  await click(named("Select AM"));
  props.blockedReason = "Recording active";
  await render();
  expect(host.querySelector("select")?.disabled).toBe(true);
  expect(textButton("Use mode").disabled).toBe(true);
  expect(props.onChange).not.toHaveBeenCalled();
  await click(textButton("Cancel"));
});
it("rejects a stale selection after the source context changes", async () => {
  await render();
  await open();
  await click(named("Select AIS"));
  props.contextKey = "new-source";
  await render();
  expect(textButton("Use mode").disabled).toBe(true);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Receiver context changed",
  );
  await click(named("Select AM"));
  expect(textButton("Use mode").disabled).toBe(false);
  await click(textButton("Use mode"));
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("AM");
});
it("replaces a full pin list explicitly, persists it and keeps the current unpinned mode visible", async () => {
  props.value = "RS41";
  await render();
  expect(host.querySelectorAll("option")).toHaveLength(8);
  expect(host.querySelector("select")?.value).toBe("RS41");
  await open();
  await click(named("Pin DAB / DAB+ to quick list"));
  expect(localStorage.getItem(QUICK_MODES_KEY)).toBeNull();
  await click(textButton("Replace pin"));
  expect(JSON.parse(localStorage.getItem(QUICK_MODES_KEY)!)).toEqual([
    "DAB",
    "NBFM",
    "AM",
    "USB",
    "LSB",
    "CW",
    "OFF",
  ]);
  expect(props.onChange).not.toHaveBeenCalled();
  await click(textButton("Cancel"));
  expect(host.querySelector("select")?.value).toBe("RS41");
  await act(async () => {
    root.unmount();
    root = createRoot(host);
  });
  await render();
  expect(host.querySelector('option[value="DAB"]')).not.toBeNull();
});
it("preserves corrupt stored preferences until a deliberate pin change and handles denied writes", async () => {
  localStorage.setItem(QUICK_MODES_KEY, "{bad");
  await render();
  expect(localStorage.getItem(QUICK_MODES_KEY)).toBe("{bad");
  await open();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  await click(named("Unpin AM"));
  expect(document.querySelector("dialog")?.textContent).toContain(
    "saved for this tab only",
  );
  expect(host.querySelector('option[value="AM"]')).toBeNull();
  expect(props.onChange).not.toHaveBeenCalled();
});
