// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("../assets/natural-earth-10m-places.json", () => ({ default: [] }));
import { PositionMap } from "./PositionMap";

it("ignores a stale raster and reuses the current bitmap across resize and target updates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draw = vi.fn();
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      drawImage: draw,
    } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      text: async () =>
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L720 360"/></svg>',
    })),
  );
  const createDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const revokeDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:map"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  let resize: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const images: { src: string; finish: () => void }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      finish!: () => void;
      constructor() {
        images.push(this);
      }
      decode() {
        return new Promise<void>((resolve) => {
          this.finish = resolve;
        });
      }
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (frame: string, latitude: number, selectedKey?: string) =>
    root.render(
      <PositionMap
        pannable
        label="Positions"
        framingKey={frame}
        selectedKey={selectedKey}
        points={[{ key: "a", latitude, longitude: 13, label: "Aircraft" }]}
      />,
    );
  try {
    await act(async () => render("old", 52));
    expect(images).toHaveLength(1);
    await act(async () => render("new", 48));
    expect(images).toHaveLength(2);
    expect(images[0]!.src).toBe("");
    await act(async () => images[0]!.finish());
    expect(draw).not.toHaveBeenCalled();
    await act(async () => images[1]!.finish());
    expect(container.querySelector("canvas")?.getAttribute("data-state")).toBe(
      "ready",
    );
    const rasterDraws = draw.mock.calls.filter(
      (call) => call[0] instanceof Image,
    ).length;
    expect(rasterDraws).toBe(1);
    const backing = draw.mock.calls.find((call) => call[0] instanceof Image)!;
    expect(backing[3] * backing[4] * 4).toBeLessThanOrEqual(8 * 1024 * 1024);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width * canvas.height * 4).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    const previousBox = container
      .querySelector(".map-overlay")
      ?.getAttribute("viewBox");
    await act(async () => {
      resize!(
        [{ contentRect: { width: 800, height: 360 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(
      container.querySelector(".map-overlay")?.getAttribute("viewBox"),
    ).not.toBe(previousBox);
    await act(async () => render("new", 48.01, "a"));
    const navigation = container.querySelector<HTMLElement>(".map-surface")!;
    const fittedBox = container
      .querySelector(".map-overlay")
      ?.getAttribute("viewBox");
    await act(async () =>
      navigation.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    const pannedBox = container
      .querySelector(".map-overlay")
      ?.getAttribute("viewBox");
    expect(pannedBox).not.toBe(fittedBox);
    await act(async () => render("new", 48.02, "a"));
    expect(
      container.querySelector(".map-overlay")?.getAttribute("viewBox"),
    ).toBe(pannedBox);
    expect(images).toHaveLength(2);
    expect(
      draw.mock.calls.filter((call) => call[0] instanceof Image),
    ).toHaveLength(1);
    expect(container.querySelector("canvas")?.getAttribute("data-state")).toBe(
      "ready",
    );
    await act(async () => render("reset", 48.02));
    expect(
      container.querySelector(".map-overlay")?.getAttribute("viewBox"),
    ).not.toBe(pannedBox);
    expect(images).toHaveLength(2);
    const beforeZoom = container
      .querySelector(".map-overlay")
      ?.getAttribute("viewBox");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
        .click(),
    );
    expect(
      container.querySelector(".map-overlay")?.getAttribute("viewBox"),
    ).not.toBe(beforeZoom);
    expect(container.querySelector("canvas")?.getAttribute("data-state")).toBe(
      "loading",
    );
    expect(images).toHaveLength(3);
    await act(async () => images[2]!.finish());
    expect(container.querySelector("canvas")?.getAttribute("data-state")).toBe(
      "ready",
    );
    await act(async () => render("fit-reset", 48.02));
    expect(
      container.querySelector(".map-overlay")?.getAttribute("viewBox"),
    ).toBe(beforeZoom);
    expect(container.textContent).not.toContain("Detailed map");
    expect(container.textContent).toContain("Natural Earth 1:10m");
    await act(async () => images[3]!.finish());
    let wheelFrame: FrameRequestCallback | undefined;
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      wheelFrame = callback;
      return 42;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", schedule);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const navigationAfterFit =
      container.querySelector<HTMLElement>(".map-surface")!;
    const wheelUp = () =>
      new WheelEvent("wheel", {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      });
    await act(async () => {
      expect(navigationAfterFit.dispatchEvent(wheelUp())).toBe(false);
      expect(navigationAfterFit.dispatchEvent(wheelUp())).toBe(false);
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    await act(async () => wheelFrame!(0));
    const wheelWidth = Number(
      container
        .querySelector(".map-overlay")!
        .getAttribute("viewBox")!
        .split(" ")[2],
    );
    expect(wheelWidth).toBeCloseTo(Number(beforeZoom!.split(" ")[2]) / 2);
    const pinch = new WheelEvent("wheel", {
      deltaY: -240,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(navigationAfterFit.dispatchEvent(pinch)).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
    await act(async () => {
      navigationAfterFit.dispatchEvent(wheelUp());
    });
    await act(async () => render("new-source", 48.02));
    expect(cancel).toHaveBeenCalledWith(42);
    expect(
      container.querySelector(".map-overlay")!.getAttribute("viewBox"),
    ).toBe(beforeZoom);
  } finally {
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalled();
    container.remove();
    context.mockRestore();
    if (createDescriptor)
      Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeDescriptor)
      Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    vi.unstubAllGlobals();
  }
});
