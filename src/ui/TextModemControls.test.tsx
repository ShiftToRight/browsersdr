// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TextModemControls } from "./TextModemControls";
import { defaultTextModemSettings } from "../textmodem/settings";

let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps incomplete signed input local, commits once and preserves invalid edits until corrected or cancelled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const applied = vi.fn();
  function Harness() {
    const [settings, setSettings] = useState(defaultTextModemSettings());
    return (
      <TextModemControls
        mode="RTTY"
        settings={settings}
        disabled={false}
        onChange={(next) => {
          applied(next);
          setSettings(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="Text modem fine tuning offset"]',
  )!;
  const edit = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (value: string) =>
    act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      );
    });
  await edit("");
  await edit("-2");
  await edit("-200");
  expect(applied).not.toHaveBeenCalled();
  expect(input.value).toBe("-200");
  await key("Enter");
  expect(applied).toHaveBeenCalledTimes(1);
  expect(applied.mock.calls[0]![0].tuningOffsetHz).toBe(-200);
  await act(async () => {
    input.focus();
    input.blur();
  });
  expect(applied).toHaveBeenCalledTimes(1);
  await edit("4000");
  await key("Enter");
  expect(input.value).toBe("4000");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(applied).toHaveBeenCalledTimes(1);
  await key("Escape");
  expect(input.value).toBe("-200");
  expect(input.getAttribute("aria-invalid")).toBe("false");
  await edit("-300");
  await act(async () => {
    input.focus();
    input.blur();
  });
  expect(applied).toHaveBeenCalledTimes(2);
  expect(applied.mock.calls[1]![0].tuningOffsetHz).toBe(-300);
});
