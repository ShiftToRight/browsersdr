// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppResourceOwner } from "./AppResourceOwner";

it("keeps the default analysis factory stable across state and parent rerenders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "Worker",
    class {
      terminate = vi.fn();
      postMessage() {}
      constructor() {
        // Fail promptly if effect setup loops instead of allocating indefinitely.
        if (workers.length >= 2)
          throw new Error("Unexpected analysis recreation");
        workers.push(this);
      }
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (text: string) =>
    root.render(
      <StrictMode>
        <AppResourceOwner>{() => <span>{text}</span>}</AppResourceOwner>
      </StrictMode>,
    );
  try {
    await act(async () => render("First"));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    await act(async () => render("Updated"));
    expect(host.textContent).toBe("Updated");
    expect(workers).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
});
