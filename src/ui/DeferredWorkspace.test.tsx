// @vitest-environment jsdom
import { act, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeferredWorkspace, useWorkspaceVisited } from "./DeferredWorkspace";

async function withRoot(
  check: (
    host: HTMLDivElement,
    root: ReturnType<typeof createRoot>,
  ) => Promise<void>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await check(host, root);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

it("does not evaluate deferred JSX before first use and retains child state and fresh props afterward", async () => {
  const mount = vi.fn(),
    unmount = vi.fn();
  function Draft({ label }: { label: string }) {
    const [count, setCount] = useState(0);
    useEffect(() => {
      mount();
      return unmount;
    }, []);
    return (
      <button onClick={() => setCount(count + 1)}>
        {label}:{count}
      </button>
    );
  }
  await withRoot(async (host, root) => {
    const factory = vi.fn(() => <Draft label="first" />);
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false}>{factory}</DeferredWorkspace>,
      ),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<DeferredWorkspace active>{factory}</DeferredWorkspace>),
    );
    await act(async () => host.querySelector("button")!.click());
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false}>
          {() => <Draft label="updated" />}
        </DeferredWorkspace>,
      ),
    );
    expect(host.textContent).toBe("updated:1");
    expect(mount).toHaveBeenCalledTimes(1);
    expect(unmount).not.toHaveBeenCalled();
  });
  expect(unmount).toHaveBeenCalledTimes(1);
});

it("preserves the existing ReactNode child contract", async () => {
  const mount = vi.fn();
  function Child() {
    useEffect(mount, []);
    return <p>retained</p>;
  }
  await withRoot(async (host, root) => {
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false}>
          <Child />
        </DeferredWorkspace>,
      ),
    );
    expect(host.textContent).toBe("");
    await act(async () =>
      root.render(
        <DeferredWorkspace active>
          <Child />
        </DeferredWorkspace>,
      ),
    );
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false}>
          <Child />
        </DeferredWorkspace>,
      ),
    );
    expect(host.textContent).toBe("retained");
    expect(mount).toHaveBeenCalledTimes(1);
  });
});

it("can freeze an inactive factory without losing state and refreshes its props on reopening", async () => {
  function Draft({ label }: { label: string }) {
    const [count, setCount] = useState(0);
    return (
      <button onClick={() => setCount(count + 1)}>
        {label}:{count}
      </button>
    );
  }
  await withRoot(async (host, root) => {
    await act(async () =>
      root.render(
        <DeferredWorkspace active freezeWhenInactive>
          {() => <Draft label="first" />}
        </DeferredWorkspace>,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    const latest = vi.fn(() => <Draft label="latest" />);
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false} freezeWhenInactive>
          {latest}
        </DeferredWorkspace>,
      ),
    );
    expect(latest).not.toHaveBeenCalled();
    expect(host.textContent).toBe("first:1");
    await act(async () =>
      root.render(
        <DeferredWorkspace active freezeWhenInactive>
          {latest}
        </DeferredWorkspace>,
      ),
    );
    expect(latest).toHaveBeenCalled();
    expect(host.textContent).toBe("latest:1");
  });
});

it("retains Suspense loading for factory children without starting their import early", async () => {
  let resolve!: (value: { default: () => React.ReactNode }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ default: () => React.ReactNode }>((done) => {
        resolve = done;
      }),
  );
  const Child = lazy(load);
  await withRoot(async (host, root) => {
    await act(async () =>
      root.render(
        <DeferredWorkspace active={false}>{() => <Child />}</DeferredWorkspace>,
      ),
    );
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <DeferredWorkspace active>{() => <Child />}</DeferredWorkspace>,
      ),
    );
    expect(host.textContent).toContain("Opening workspace…");
    await act(async () => resolve({ default: () => <p>loaded</p> }));
    expect(host.textContent).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

it("can defer a panel's JSX while its background diagnostics stay mounted", async () => {
  const monitor = vi.fn(),
    release = vi.fn();
  function Panel({ active }: { active: boolean }) {
    const visited = useWorkspaceVisited(active);
    useEffect(() => {
      monitor();
      return release;
    }, []);
    return visited ? <input aria-label="draft" defaultValue="initial" /> : null;
  }
  await withRoot(async (host, root) => {
    await act(async () => root.render(<Panel active={false} />));
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(host.querySelector("input")).toBeNull();
    await act(async () => root.render(<Panel active />));
    host.querySelector("input")!.value = "unsent draft";
    await act(async () => root.render(<Panel active={false} />));
    expect(host.querySelector("input")!.value).toBe("unsent draft");
    expect(release).not.toHaveBeenCalled();
  });
  expect(release).toHaveBeenCalledTimes(1);
});
