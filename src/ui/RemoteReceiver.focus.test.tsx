// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteReceiver } from "./RemoteReceiver";
import { DEFAULT_WORKSPACE, WorkspaceControls } from "./WorkspaceLayout";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLInputElement.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = {
  active: true,
  layout: DEFAULT_WORKSPACE,
  onLayoutChange: vi.fn(),
  onSource: vi.fn(),
  onStatus: vi.fn(),
};

it("keeps Help open when the deferred remote receiver finishes mounting", async () => {
  let resolve!: (module: { default: typeof RemoteReceiver }) => void;
  const DeferredRemote = lazy(
    () =>
      new Promise<{ default: typeof RemoteReceiver }>((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(
      <>
        <WorkspaceControls
          layout={DEFAULT_WORKSPACE}
          onChange={vi.fn()}
          onSettings={vi.fn()}
          onHelp={vi.fn()}
          onCompatibility={vi.fn()}
          onAbout={vi.fn()}
          activeView="remote"
        />
        <Suspense fallback={null}>
          <DeferredRemote {...props} />
        </Suspense>
      </>,
    ),
  );
  const summary = host.querySelector<HTMLElement>(
    'summary[aria-label="Help"]',
  )!;
  const menu = summary.closest("details")!;
  await act(async () => {
    summary.focus();
    summary.click();
  });
  expect(menu.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  await act(async () => resolve({ default: RemoteReceiver }));
  expect(host.querySelector(".remote-address input")).not.toBeNull();
  expect(document.activeElement).toBe(summary);
  expect(menu.open).toBe(true);
});

it.each(["body", "source selector"])(
  "focuses the receiver address on ordinary entry from %s",
  async (origin) => {
    const select =
      origin === "source selector"
        ? document.createElement("select")
        : undefined;
    if (select) {
      select.setAttribute("aria-label", "Signal source");
      // Keep this existing entry control outside React's root during the mount.
      document.body.insertBefore(select, host);
      select.focus();
      expect(document.activeElement).toBe(select);
    }
    try {
      await act(async () => root.render(<RemoteReceiver {...props} />));
      expect(document.activeElement).toBe(
        host.querySelector(".remote-address input"),
      );
    } finally {
      select?.remove();
    }
  },
);
