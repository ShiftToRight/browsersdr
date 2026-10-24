import { expect, test } from "@playwright/test";

for (const unavailable of [
  "missing API",
  "null adapter",
  "request failure",
  "experimental FFT",
]) {
  test(`Canvas2D displays real synthetic spectrum after ${unavailable}`, async ({
    page,
  }) => {
    await page.addInitScript((reason) => {
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        value:
          reason === "null adapter"
            ? { requestAdapter: async () => null }
            : reason === "request failure"
              ? {
                  requestAdapter: async () => {
                    throw new Error("test adapter unavailable");
                  },
                }
              : undefined,
      });
    }, unavailable);
    await page.goto(
      unavailable === "experimental FFT" ? "/?analysis=gpu&fft=16384" : "/",
    );
    const canvas = page.getByLabel(
      "Canvas2D RF spectrum and waterfall plot; click to tune",
      { exact: true },
    );
    await expect(canvas).toBeVisible();
    await page.locator(".receiver-status-menu > summary").click();
    await expect(
      page
        .locator(".receiver-health-panel")
        .getByRole("button", { name: /^Display:/ }),
    ).toHaveAttribute("aria-label", /Available|Working/);
    await page.keyboard.press("Escape");
    await page
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption("synthetic");
    await page.getByRole("button", { name: "Start demo", exact: true }).click();
    const pixels = () =>
      canvas.evaluate((plot: HTMLCanvasElement) => {
        const ctx = plot.getContext("2d")!;
        const image = ctx.getImageData(
          0,
          Math.floor(plot.height * 0.38),
          plot.width,
          Math.floor(plot.height * 0.5),
        );
        let colored = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          if (image.data[i + 2]! > 50 && image.data[i + 1]! > 10) colored++;
        }
        return colored;
      });
    await expect.poll(pixels).toBeGreaterThan(1000);
    await expect(
      page.getByRole("button", { name: "Auto scale", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "FFT & display details", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "FFT & display details", exact: true }),
    ).toContainText("4096-point Hann FFT");
    await expect(
      page.locator(".graphics-panel .diagnostic-message"),
    ).toContainText("Canvas2D live");
    await page.keyboard.press("Escape");
    // Automatic fitting can already be exact. Deliberately choose manual
    // bounds so paused Auto scale has a meaningful correction to perform.
    await page
      .getByRole("button", { name: "Display settings", exact: true })
      .click();
    await page
      .getByRole("slider", { name: "Spectrum floor", exact: true })
      .fill("-50");
    await expect(
      page.getByRole("checkbox", {
        name: "Auto scale on tune or rate change",
        exact: true,
      }),
    ).not.toBeChecked();
    await page
      .getByRole("dialog", { name: "Display settings", exact: true })
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Pause display", exact: true })
      .click();
    const snapshot = () =>
      canvas.evaluate((plot: HTMLCanvasElement) => plot.toDataURL());
    const frozen = await snapshot();
    await expect(page.locator(".paused-label")).toBeVisible();
    await expect.poll(snapshot).toBe(frozen);
    await page.getByRole("button", { name: "Auto scale", exact: true }).click();
    await expect.poll(snapshot).not.toBe(frozen);
    await page
      .getByRole("button", { name: "Resume display", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => canvas.evaluate((plot: HTMLCanvasElement) => plot.width))
      .toBeLessThan(500);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    const previousChannel = await page
      .getByLabel("Channel frequency", { exact: true })
      .inputValue();
    const bounds = (await canvas.boundingBox())!;
    await canvas.click({
      position: { x: bounds.width * 0.65, y: bounds.height * 0.2 },
    });
    await expect(
      page.getByLabel("Channel frequency", { exact: true }),
    ).not.toHaveValue(previousChannel);
    await expect.poll(pixels).toBeGreaterThan(1000);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator(".plot-state")).toContainText("Start receiving");
    await page.getByRole("button", { name: "Start demo", exact: true }).click();
    await expect.poll(pixels).toBeGreaterThan(1000);
  });
}

test("compatibility renderer can be explicitly selected and WebGPU retried without stopping reception", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page
    .getByRole("button", { name: "Display settings", exact: true })
    .click();
  const renderer = page.getByRole("combobox", {
    name: "Display renderer",
    exact: true,
  });
  await renderer.selectOption("canvas2d");
  await expect(
    page.getByLabel("Canvas2D RF spectrum and waterfall plot; click to tune", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
  await renderer.selectOption("webgpu");
  await page
    .getByRole("dialog", { name: "Display settings", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Display settings", exact: true }),
  ).toBeHidden();
  // The runner may have no adapter; automatic fallback remains a working display.
  await page.locator(".receiver-status-menu > summary").click();
  await expect(
    page
      .locator(".receiver-health-panel")
      .getByRole("button", { name: /^Display:/ }),
  ).toHaveAttribute("aria-label", /Available|Working/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});
