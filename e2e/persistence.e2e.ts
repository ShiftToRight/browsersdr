import { expect, test, type Page } from "@playwright/test";
import {
  openDisplaySettings,
  closeDisplaySettings,
} from "./display-settings-navigation";

async function start(page: Page, missingGpu = false) {
  await page.addInitScript((missing) => {
    localStorage.setItem(
      "browsersdr.spectrum-surface.v1",
      JSON.stringify({ view: "persistence" }),
    );
    if (missing)
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        value: undefined,
      });
  }, missingGpu);
  await page.goto("/?browser-test=1&demo=history");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  const canvas = page.getByLabel(
    "Canvas2D live spectrum and persistence density; click frequency to tune",
    { exact: true },
  );
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute("data-persistence-frames")),
    )
    .toBeGreaterThan(5);
  return canvas;
}

for (const missing of [false, true])
  test(`persistence paints observed density and a live trace; missing GPU ${missing}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const canvas = await start(page, missing);
    await expect(canvas).toHaveAttribute(
      "data-persistence-colour-ceiling",
      "0.5",
    );
    await expect(
      page.getByRole("button", { name: "Persistence", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".persistence-key")).toContainText(
      "Colour = observed occurrence",
    );
    await expect(page.locator(".persistence-key")).toContainText("≥50%");
    const pixels = () =>
      canvas.evaluate((plot: HTMLCanvasElement) => {
        const data = plot
          .getContext("2d")!
          .getImageData(
            0,
            Math.floor(plot.height * 0.5),
            plot.width,
            Math.floor(plot.height * 0.25),
          ).data;
        let warm = 0,
          cool = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! > 180 && data[i + 1]! < 180 && data[i + 2]! < 100)
            warm++;
          if (data[i + 2]! > 130 && data[i]! < 100 && data[i + 1]! > 20) cool++;
        }
        return { warm, cool };
      });
    await expect.poll(async () => (await pixels()).warm).toBeGreaterThan(0);
    await expect.poll(async () => (await pixels()).cool).toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "FFT & display details", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "FFT & display details", exact: true }),
    ).toContainText("not transmitter airtime");
    expect(errors).toEqual([]);
  });

test("pause, histogram inspection, clear and scale change preserve the current trace and receiver", async ({
  page,
}) => {
  const canvas = await start(page, true);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const count = await canvas.getAttribute("data-persistence-frames");
  const top = () =>
    canvas.evaluate(async (c: HTMLCanvasElement) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            c
              .getContext("2d")!
              .getImageData(0, 0, c.width, Math.floor(c.height * 0.37)).data,
          ),
        ),
      ),
    );
  const trace = await top();
  const box = (await canvas.boundingBox())!;
  await canvas.hover({
    position: { x: box.width * 0.62, y: box.height * 0.65 },
  });
  await expect(page.locator(".persistence-hover")).toContainText(
    "observed spectra",
  );
  const line = page.locator(".spectrum-hover-line");
  await expect(line).toBeVisible();
  const firstLine = (await line.boundingBox())!;
  await expect(page.locator(".spectrum-hover-readout")).toHaveCount(0);
  await canvas.hover({
    position: { x: box.width * 0.75, y: box.height * 0.65 },
  });
  await expect
    .poll(async () => (await line.boundingBox())!.x - firstLine.x)
    .toBeCloseTo(box.width * 0.13, 0);
  await canvas.hover({
    position: { x: box.width * 0.75, y: box.height * 0.2 },
  });
  await expect(page.locator(".spectrum-hover-readout")).toBeVisible();
  await expect(page.locator(".persistence-hover")).toHaveCount(0);
  await canvas.hover({
    position: { x: box.width * 0.75, y: box.height * 0.65 },
  });
  await expect(line).toBeVisible();
  await expect(canvas).toHaveAttribute("data-persistence-frames", count!);
  const density = () =>
    canvas.evaluate(async (c: HTMLCanvasElement) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            c
              .getContext("2d")!
              .getImageData(
                0,
                Math.floor(c.height * 0.5),
                c.width,
                Math.floor(c.height * 0.25),
              ).data,
          ),
        ),
      ),
    );
  const originalDensity = await density();
  await openDisplaySettings(page);
  await page
    .getByRole("combobox", {
      name: "Persistence colour saturation",
      exact: true,
    })
    .selectOption("100");
  await closeDisplaySettings(page);
  await expect(canvas).toHaveAttribute("data-persistence-colour-ceiling", "1");
  await expect(page.locator(".persistence-key")).toContainText("≥100%");
  await expect
    .poll(
      async () =>
        JSON.stringify(await density()) !== JSON.stringify(originalDensity),
    )
    .toBe(true);
  await expect(canvas).toHaveAttribute("data-persistence-frames", count!);
  expect(await top()).toEqual(trace);
  await openDisplaySettings(page);
  await page
    .getByRole("button", { name: "Clear persistence", exact: true })
    .click();
  await closeDisplaySettings(page);
  await expect(canvas).toHaveAttribute("data-persistence-frames", "0");
  expect(await top()).toEqual(trace);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Receiver center frequency", { exact: true }),
  ).toHaveValue("100.000");
  await page
    .getByRole("button", { name: "Resume display", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute("data-persistence-frames")),
    )
    .toBeGreaterThan(4);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const frozen = await canvas.getAttribute("data-persistence-frames");
  await openDisplaySettings(page);
  await page
    .getByRole("slider", { name: "Spectrum floor", exact: true })
    .fill("-80");
  await closeDisplaySettings(page);
  await expect(canvas).toHaveAttribute("data-persistence-frames", frozen!);
  await expect(page.locator(".persistence-axis")).toContainText("-80");
});

test("view and window preferences persist without starting acquisition; ordinary 2D returns", async ({
  page,
}) => {
  const canvas = await start(page, true);
  await expect(
    page.getByRole("combobox", {
      name: "Persistence history window",
      exact: true,
    }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Clear persistence", exact: true }),
  ).toBeHidden();
  await openDisplaySettings(page);
  await page
    .getByRole("combobox", { name: "Persistence history window", exact: true })
    .selectOption("60");
  await page
    .getByRole("combobox", {
      name: "Persistence colour saturation",
      exact: true,
    })
    .selectOption("25");
  await closeDisplaySettings(page);
  await expect(page.locator(".persistence-summary")).toContainText(
    "1 min window",
  );
  await page.getByRole("button", { name: "2D waterfall", exact: true }).click();
  await expect(
    page.getByLabel("Canvas2D RF spectrum and waterfall plot; click to tune", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Persistence", exact: true }).click();
  await expect(canvas).toBeVisible();
  await openDisplaySettings(page);
  await expect(
    page.getByRole("combobox", {
      name: "Persistence history window",
      exact: true,
    }),
  ).toHaveValue("60");
  await expect(
    page.getByRole("combobox", {
      name: "Persistence colour saturation",
      exact: true,
    }),
  ).toHaveValue("25");
  await closeDisplaySettings(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Persistence", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await openDisplaySettings(page);
  await expect(
    page.getByRole("combobox", {
      name: "Persistence history window",
      exact: true,
    }),
  ).toHaveValue("60");
  await closeDisplaySettings(page);
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeDisabled();
});

test("channel-only tuning preserves the canvas, frozen density and continuing observations", async ({
  page,
}) => {
  const canvas = await start(page, true);
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute("data-persistence-frames")),
    )
    .toBeGreaterThan(20);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const before = Number(await canvas.getAttribute("data-persistence-frames"));
  const node = (await canvas.elementHandle())!;
  const pixels = () =>
    canvas.evaluate(async (c: HTMLCanvasElement) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data,
          ),
        ),
      ),
    );
  const frozen = await pixels();
  const box = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: box.width * 0.7, y: box.height * 0.22 },
  });
  await expect(
    page.getByLabel("Channel frequency", { exact: true }),
  ).toHaveValue("100.200");
  await expect(
    page.getByLabel("Receiver center frequency", { exact: true }),
  ).toHaveValue("100.000");
  expect(await node.evaluate((el) => el.isConnected)).toBe(true);
  await expect(canvas).toHaveAttribute(
    "data-persistence-frames",
    String(before),
  );
  expect(await pixels()).toEqual(frozen);
  await expect(page.locator(".persistence-summary")).toContainText(
    "gaps excluded",
  );
  await page
    .getByRole("button", { name: "Resume display", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute("data-persistence-frames")),
    )
    .toBeGreaterThan(before);
  expect(await node.evaluate((el) => el.isConnected)).toBe(true);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await page
    .getByLabel("Receiver center frequency", { exact: true })
    .fill("100.1");
  await page
    .locator(".spectrum-toolbar")
    .getByRole("button", { name: "Set", exact: true })
    .click();
  await expect(canvas).toHaveAttribute("data-persistence-frames", "0");
});

test("all themes and narrow layouts keep density axes, legend and controls readable", async ({
  page,
}) => {
  const canvas = await start(page, true);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const count = await canvas.getAttribute("data-persistence-frames");
  for (const theme of [
    "classic",
    "field-deck",
    "vice-afterglow",
    "graphite-studio",
  ]) {
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await page.getByLabel("Settings", { exact: true }).click();
    await expect(canvas).toHaveAttribute("data-persistence-frames", count!);
  }
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await openDisplaySettings(page);
    const controls = page.locator(".persistence-settings-row");
    await expect(
      controls.getByRole("button", { name: "Clear persistence", exact: true }),
    ).toBeVisible();
    await expect(
      controls.getByRole("combobox", {
        name: "Persistence history window",
        exact: true,
      }),
    ).toBeVisible();
    const bounds = await controls.evaluate((root) =>
      Array.from(root.querySelectorAll("select, button"), (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          height: r.height,
          width: r.width,
        };
      }),
    );
    for (const r of bounds) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(width);
      expect(r.height).toBeLessThanOrEqual(36);
      expect(r.width).toBeLessThan(200);
    }
    await closeDisplaySettings(page);
    const metrics = await page.locator(".canvas-frame").evaluate((root) => {
      const a = root
        .querySelector(".persistence-frequency")!
        .getBoundingClientRect();
      const b = root.querySelector(".persistence-key")!.getBoundingClientRect();
      const c = root.querySelector(".plot-metadata")!.getBoundingClientRect();
      const paused = root
        .querySelector(".paused-label")!
        .getBoundingClientRect();
      const density = root
        .querySelector(".waterfall-label")!
        .getBoundingClientRect();
      const latest = root
        .querySelector(".spectrum-label")!
        .getBoundingClientRect();
      const channel = root
        .querySelector(".marker-label")!
        .getBoundingClientRect();
      return {
        plotHeight: root.getBoundingClientRect().height,
        canvasHeight: root.querySelector("canvas")!.getBoundingClientRect()
          .height,
        pausedBottom: paused.bottom,
        densityTop: density.top,
        latestBottom: latest.bottom,
        channelTop: channel.top,
        oldAxisHidden:
          getComputedStyle(root.querySelector(".frequency-rule")!).display ===
          "none",
        axisBottom: a.bottom,
        keyTop: b.top,
        keyBottom: b.bottom,
        metadataTop: c.top,
        scroll: document.documentElement.scrollWidth,
        width: document.documentElement.clientWidth,
      };
    });
    expect(metrics.scroll).toBe(metrics.width);
    expect(metrics.plotHeight).toBeGreaterThanOrEqual(480);
    expect(
      Math.abs(metrics.plotHeight - metrics.canvasHeight),
    ).toBeLessThanOrEqual(1);
    expect(metrics.oldAxisHidden).toBe(true);
    expect(metrics.pausedBottom).toBeLessThanOrEqual(metrics.densityTop);
    expect(metrics.latestBottom).toBeLessThanOrEqual(metrics.channelTop);
    expect(metrics.axisBottom).toBeLessThanOrEqual(metrics.keyTop);
    expect(metrics.keyBottom).toBeLessThanOrEqual(metrics.metadataTop);
  }
});

test("experimental GPU FFT never presents CPU reference spectra as persistence", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.goto("/?browser-test=1&analysis=gpu&fft=16384");
  await page.getByRole("button", { name: "Persistence", exact: true }).click();
  await expect(page.locator(".surface-notice")).toContainText(
    "Persistence unavailable with experimental GPU FFT",
  );
  await expect(page.locator(".persistence-active")).toHaveCount(0);
});
