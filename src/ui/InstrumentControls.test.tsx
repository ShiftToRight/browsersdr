// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InstrumentButton } from "./InstrumentButton";
import { InstrumentRange } from "./InstrumentRange";
import { setTheme } from "./themes";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setTheme("graphite-studio");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setTheme("classic");
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("keeps native button activation, refs and disabled state separate from cap travel", async () => {
  const onClick = vi.fn(),
    onKeyDown = vi.fn();
  const ref = { current: null as HTMLButtonElement | null };
  await act(async () =>
    root.render(
      <InstrumentButton ref={ref} onClick={onClick} onKeyDown={onKeyDown}>
        Tune
      </InstrumentButton>,
    ),
  );
  const button = host.querySelector("button")!;
  expect(ref.current).toBe(button);
  await act(async () =>
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    ),
  );
  expect(button.dataset.keyPressed).toBe("true");
  expect(onKeyDown).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();
  await act(async () =>
    button.dispatchEvent(
      new KeyboardEvent("keyup", { key: " ", bubbles: true }),
    ),
  );
  expect(button.dataset.keyPressed).toBeUndefined();
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      <InstrumentButton disabled onClick={onClick}>
        Tune
      </InstrumentButton>,
    ),
  );
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledOnce();
  await act(async () => setTheme("classic"));
  expect(host.querySelector("button")).toBe(button);
  expect(host.querySelector(".instrument-key-face")).toBeNull();
});
it("range decoration follows controlled values without publishing extra changes or losing native commit handlers", async () => {
  const changed = vi.fn(),
    commit = vi.fn();
  function Harness() {
    const [value, setValue] = useState(0.25);
    return (
      <InstrumentRange
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(event) => {
          changed(event.currentTarget.valueAsNumber);
          setValue(event.currentTarget.valueAsNumber);
        }}
        onPointerUp={commit}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const input = host.querySelector("input")!;
  expect(input.type).toBe("range");
  expect(input.value).toBe("0.25");
  await act(async () =>
    input.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  expect(host.querySelector("[data-gripped]")).not.toBeNull();
  await act(async () =>
    input.dispatchEvent(new Event("pointerup", { bubbles: true })),
  );
  expect(commit).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(host.querySelector("[data-gripped]")).toBeNull();
  await act(async () =>
    input.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  await act(async () => window.dispatchEvent(new Event("pointercancel")));
  expect(host.querySelector("[data-gripped]")).toBeNull();
  expect(commit).toHaveBeenCalledOnce();
  await act(async () => setTheme("field-deck"));
  expect(host.querySelector(".instrument-range")).toBeNull();
  expect(host.querySelector("input")?.value).toBe("0.25");
});
