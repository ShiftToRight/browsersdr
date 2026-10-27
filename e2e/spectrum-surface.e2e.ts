import { expect, test, type Page, type Locator } from "@playwright/test";
import {
  openDisplaySettings,
  closeDisplaySettings,
} from "./display-settings-navigation";

// Executes real WGSL and rasterization on a software adapter in CI. This does
// not establish physical GPU performance or hardware RF/audio acceptance.
test.use({
  launchOptions: {
    // Bound Mesa's compositor threads independently of the host CPU count.
    // Real WGSL, rasterization, canvas size and pixel assertions stay intact.
    env: { ...process.env, LP_NUM_THREADS: "2" },
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-angle=vulkan",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--disable-vulkan-surface",
    ],
  },
});

// Read the complete rendered GPU canvas directly. Compositor screenshots can
// stall on software Vulkan; decoding the PNG preserves full pixel comparisons.
async function canvasPng(plot: Locator) {
  const png = await plot.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  return Buffer.from(png.split(",")[1]!, "base64");
}

async function start(page: Page, layout = "separate") {
  if (layout)
    await page.addInitScript((layout) => {
      const key = "browsersdr.spectrum-surface.v1";
      localStorage.setItem(
        key,
        JSON.stringify({
          ...JSON.parse(localStorage.getItem(key) ?? "{}"),
          layout,
        }),
      );
    }, layout);
  await page.goto("/?browser-test=1&demo=history");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "3D history", exact: true }).click();
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  // Stop the synthetic producer and drain its last real GPU submission before
  // closing the context. Otherwise the next page can inherit expensive driver
  // cleanup from a live, large-canvas test and spend its deadline in newPage.
  try {
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    if ((await stop.isVisible()) && (await stop.isEnabled())) {
      await stop.click();
      await expect(stop).toBeDisabled();
    }
    const plot = page.locator(".canvas-frame canvas");
    if (await plot.count())
      await expect(plot).not.toHaveAttribute("data-surface-pending", "true");
  } finally {
    expect(pageErrors.get(page)).toEqual([]);
  }
});

async function ready(page: Page, layout = "separate") {
  await start(page, layout);
  try {
    await expect(page.locator(".canvas-frame")).toHaveClass(/surface-active/);
  } catch (error) {
    // Preserve the original failure and deadline; expose the real fallback
    // reason so an unavailable adapter cannot look like a pixel assertion.
    try {
      await page
        .getByRole("button", { name: "FFT & display details", exact: true })
        .click({ timeout: 1000 });
      console.error(
        "3D display initialization:",
        await page
          .getByRole("dialog", { name: "FFT & display details", exact: true })
          .innerText({ timeout: 1000 }),
      );
    } catch {
      /* Keep the original assertion failure. */
    }
    throw error;
  }
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".waterfall-label").textContent())?.match(
          /([\d.]+) \/ /,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0.5);
  return page.locator(".canvas-frame canvas");
}

test("real terrain preserves paused pixels through 2D and 3D view switches", async ({
  page,
}) => {
  const plot = await ready(page);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const frozen = await canvasPng(plot);
  expect(frozen.length).toBeGreaterThan(15000);
  await expect
    .poll(async () => (await canvasPng(plot)).equals(frozen))
    .toBe(true);
  await page.getByRole("button", { name: "2D waterfall", exact: true }).click();
  await expect(page.locator(".canvas-frame")).not.toHaveClass(/surface-active/);
  await page.getByRole("button", { name: "3D history", exact: true }).click();
  await expect(page.locator(".canvas-frame")).toHaveClass(/surface-active/);
  await expect
    .poll(async () => (await canvasPng(plot)).equals(frozen))
    .toBe(true);
});

test("flat comparison carriers and both frequency rulers align with the trace", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "browsersdr.spectrum-surface.v1",
      JSON.stringify({ perspective: false }),
    ),
  );
  const plot = await ready(page);
  await expect(page.locator(".waterfall-label")).toContainText("/ 10 s");
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const plotBounds = (await plot.boundingBox())!;
  const guideBounds = (await page
    .getByLabel("Band guide frequency uses", { exact: true })
    .boundingBox())!;
  expect(
    Math.abs(guideBounds.y - plotBounds.y - plotBounds.height * 0.3),
  ).toBeLessThan(2);
  const captionBounds = (await page.locator(".waterfall-label").boundingBox())!;
  expect(
    captionBounds.y - guideBounds.y - guideBounds.height,
  ).toBeGreaterThanOrEqual(5);
  expect(captionBounds.y - guideBounds.y - guideBounds.height).toBeLessThan(10);
  const flat = await page.locator(".frequency-rule").boundingBox();
  const terrain = await page.locator(".surface-frequency").boundingBox();
  expect(Math.abs(flat!.x - terrain!.x)).toBeLessThan(1);
  expect(Math.abs(flat!.width - terrain!.width)).toBeLessThan(1);
  const png = (
    await plot.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())
  ).split(",")[1]!;
  const peaks = await page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const image = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    image.close();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const peak = (fraction: number, top: number, bottom: number) => {
      let bestX = -1,
        bestCount = 0;
      for (
        let x = Math.round((fraction - 0.045) * canvas.width);
        x < (fraction + 0.045) * canvas.width;
        x++
      ) {
        let count = 0;
        for (
          let y = Math.round(top * canvas.height);
          y < bottom * canvas.height;
          y++
        ) {
          const offset = (y * canvas.width + x) * 4;
          if (
            data[offset]! < 180 &&
            data[offset + 1]! > 110 &&
            data[offset + 2]! > 130
          )
            count++;
        }
        if (count > bestCount) {
          bestCount = count;
          bestX = x;
        }
      }
      return { x: bestX, count: bestCount };
    };
    return [-230000, 125000].map((offset) => {
      const fraction = 0.5 + offset / 1024000;
      return {
        expected: fraction * canvas.width,
        trace: peak(fraction, 0.02, 0.35),
        terrain: peak(fraction, 0.48, 0.9),
      };
    });
  }, png);
  for (const peak of peaks) {
    expect(peak.trace.count).toBeGreaterThan(0);
    expect(peak.terrain.count).toBeGreaterThan(3);
    expect(Math.abs(peak.trace.x - peak.expected)).toBeLessThan(3);
    expect(Math.abs(peak.terrain.x - peak.trace.x)).toBeLessThan(3);
  }
});

test("depth perspective defaults on and changes the actual paused GPU projection", async ({
  page,
}) => {
  const plot = await ready(page);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const perspective = await plot.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  const clock = await page.locator(".waterfall-label").textContent();
  await openDisplaySettings(page);
  const depth = page.getByRole("switch", {
    name: "Depth perspective",
    exact: true,
  });
  await expect(depth).toBeChecked();
  await depth.uncheck();
  await closeDisplaySettings(page);
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  expect(
    await plot.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
  ).not.toBe(perspective);
  await expect(page.locator(".waterfall-label")).toHaveText(clock!);
  await expect(
    page.getByRole("button", { name: "Resume display", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});

test("empty space does not tune, while the separate flat trace uses the existing tuning path", async ({
  page,
}) => {
  const plot = await ready(page);
  const channel = page.getByLabel("Channel frequency", { exact: true });
  const original = await channel.inputValue(),
    bounds = (await plot.boundingBox())!;
  await plot.click({
    position: { x: bounds.width * 0.01, y: bounds.height * 0.5 },
  });
  await expect(channel).toHaveValue(original);
  await plot.click({
    position: { x: bounds.width * 0.7, y: bounds.height * 0.2 },
  });
  await expect(channel).not.toHaveValue(original);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".plot-state")).toContainText("Start receiving");
});

test("paused camera and history redraws preserve the source and saved preferences", async ({
  page,
}) => {
  const plot = await ready(page);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const frozen = await canvasPng(plot);
  await openDisplaySettings(page);
  await page
    .getByLabel("3D history window", { exact: true })
    .selectOption("16");
  await page
    .getByRole("slider", { name: "3D elevation", exact: true })
    .fill("55");
  await page
    .getByRole("slider", { name: "3D height exaggeration", exact: true })
    .fill("1.4");
  await closeDisplaySettings(page);
  await expect
    .poll(async () => (await canvasPng(plot)).equals(frozen))
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "Resume display", exact: true }),
  ).toBeVisible();
});

test("3D view and camera preferences restore without starting acquisition", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "3D history", exact: true }).click();
  await openDisplaySettings(page);
  await expect(page.getByLabel("3D layout", { exact: true })).toHaveValue(
    "combined",
  );
  await page.getByLabel("3D layout", { exact: true }).selectOption("separate");
  await page
    .getByLabel("3D history window", { exact: true })
    .selectOption("10");
  await page
    .getByRole("slider", { name: "3D elevation", exact: true })
    .fill("55");
  await page
    .getByRole("slider", { name: "3D height exaggeration", exact: true })
    .fill("1.4");
  await expect(
    page.getByRole("switch", { name: "Depth perspective", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("switch", { name: "Depth perspective", exact: true })
    .uncheck();
  await closeDisplaySettings(page);
  await expect(page.locator(".canvas-frame canvas")).not.toHaveAttribute(
    "data-surface-pending",
    "true",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "3D history", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await openDisplaySettings(page);
  await expect(page.getByLabel("3D layout", { exact: true })).toHaveValue(
    "separate",
  );
  await expect(
    page.getByLabel("3D history window", { exact: true }),
  ).toHaveValue("10");
  await expect(
    page.getByRole("slider", { name: "3D elevation", exact: true }),
  ).toHaveValue("55");
  await expect(
    page.getByRole("slider", { name: "3D height exaggeration", exact: true }),
  ).toHaveValue("1.4");
  await expect(
    page.getByRole("switch", { name: "Depth perspective", exact: true }),
  ).not.toBeChecked();
  await expect(page.locator(".plot-state")).toContainText("Start receiving");
});

for (const theme of [
  "field-deck",
  "vice-afterglow",
  "graphite-studio",
  "classic",
]) {
  test(`palette ${theme} recolours the retained paused GPU terrain`, async ({
    page,
  }) => {
    if (theme === "classic")
      await page.addInitScript(() =>
        localStorage.setItem("browsersdr.theme.v1", "field-deck"),
      );
    const plot = await ready(page);
    await page
      .getByRole("button", { name: "Pause display", exact: true })
      .click();
    await expect(plot).toHaveAttribute("data-surface-pending", "false");
    const settingsMenu = page
      .locator(".header-utility-menu")
      .filter({ has: page.getByLabel("Settings", { exact: true }) });
    {
      const before = await canvasPng(plot);
      if (!(await settingsMenu.evaluate((e) => e.hasAttribute("open"))))
        await page.getByLabel("Settings", { exact: true }).click();
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await page.getByLabel("Theme", { exact: true }).press("Escape");
      await expect
        .poll(async () => (await canvasPng(plot)).equals(before))
        .toBe(false);
      await expect(page.locator(".canvas-frame")).toHaveClass(/surface-active/);
    }
  });
}

test("3D stays bounded and reachable on narrow layouts and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(width);
    await expect(page.locator(".canvas-frame")).toHaveClass(/surface-active/);
    const canvas = page.locator(".canvas-frame canvas");
    expect(
      await canvas.evaluate((c: HTMLCanvasElement) =>
        Math.max(c.width, c.height),
      ),
    ).toBeLessThanOrEqual(4096);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.BSD_SURFACE_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.BSD_SURFACE_SCREENSHOT_DIR}/surface-${test.info().project.name}.png`,
      fullPage: true,
    });
});

test("large 3D canvases retain native detail and proportional bounded backing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2880, height: 1440 });
  const plot = await ready(page);
  await expect
    .poll(() => plot.evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBeGreaterThan(2048);
  const dimensions = await plot.evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      cssRatio: rect.width / rect.height,
    };
  });
  expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(
    4096,
  );
  expect(dimensions.width / dimensions.height).toBeCloseTo(
    dimensions.cssRatio,
    2,
  );
});

test("combined default draws the full-resolution live front spectrum on the GPU", async ({
  page,
}) => {
  await start(page, "");
  const frame = page.locator(".canvas-frame");
  await expect(frame).toHaveClass(/surface-combined/);
  await expect(
    page.getByRole("slider", {
      name: "Front-row frequency tuning",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".spectrum-label")).toBeHidden();
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".waterfall-label").textContent())?.match(
          /([\d.]+) \/ /,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0.5);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const plot = frame.locator("canvas");
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const png = await plot.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  const peaks = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return [-230000, 125000].map((offset) => {
      const expected = (0.5 + offset / 1024000) * canvas.width;
      let count = 0;
      for (let x = Math.floor(expected) - 3; x <= Math.ceil(expected) + 3; x++)
        for (
          let y = Math.floor(canvas.height * 0.4);
          y < canvas.height * 0.86;
          y++
        ) {
          const i = (y * canvas.width + x) * 4;
          // Bright lavender live ribbon differs from cyan terrain/markers.
          if (data[i]! > 225 && data[i + 1]! > 190 && data[i + 2]! > 240)
            count++;
        }
      return count;
    });
  }, png);
  for (const count of peaks) expect(count).toBeGreaterThan(2);
});

test("combined front strip preserves snapping, free tuning and keyboard access", async ({
  page,
}) => {
  await start(page, "");
  const frame = page.locator(".canvas-frame"),
    strip = page.getByRole("slider", {
      name: "Front-row frequency tuning",
      exact: true,
    });
  await expect(frame).toHaveClass(/surface-combined/);
  const original = Number(await strip.getAttribute("aria-valuenow"));
  const plot = frame.locator("canvas"),
    bounds = (await plot.boundingBox())!;
  await plot.click({
    position: { x: bounds.width * 0.01, y: bounds.height * 0.2 },
  });
  await expect(strip).toHaveAttribute("aria-valuenow", String(original));
  const box = (await strip.boundingBox())!;
  await strip.click({ position: { x: box.width * 0.7, y: box.height / 2 } });
  await expect(strip).toHaveAttribute("aria-valuenow", "100200000");
  await strip.press("ArrowRight");
  await expect(strip).toHaveAttribute("aria-valuenow", "100201000");
  await strip.press("Shift+ArrowLeft");
  await expect(strip).toHaveAttribute("aria-valuenow", "100191000");
  await strip.click({
    position: { x: box.width * 0.63, y: box.height / 2 },
    modifiers: ["Alt"],
  });
  await expect
    .poll(async () =>
      Math.abs(Number(await strip.getAttribute("aria-valuenow")) - 100133120),
    )
    .toBeLessThan(1200);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});

test("combined layout switches without restarting paused history and fits phone tuning targets", async ({
  page,
}) => {
  await start(page, "");
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".waterfall-label").textContent())?.match(
          /([\d.]+) \/ /,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0.5);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  const clock = await page.locator(".waterfall-label").textContent();
  await openDisplaySettings(page);
  await page.getByLabel("3D layout", { exact: true }).selectOption("separate");
  await closeDisplaySettings(page);
  await expect(page.locator(".canvas-frame")).not.toHaveClass(
    /surface-combined/,
  );
  await expect(page.locator(".spectrum-label")).toBeVisible();
  await expect(page.locator(".waterfall-label")).toHaveText(clock!);
  await openDisplaySettings(page);
  await page.getByLabel("3D layout", { exact: true }).selectOption("combined");
  await closeDisplaySettings(page);
  await expect(page.locator(".waterfall-label")).toHaveText(clock!);
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(width);
    const strip = await page.locator(".surface-tuning").boundingBox();
    expect(strip!.height).toBeGreaterThanOrEqual(44);
    const overlaps = await page.evaluate(() => {
      const a = document
        .querySelector(".surface-live-caption")!
        .getBoundingClientRect();
      const b = document
        .querySelector(".surface-live-selected")!
        .getBoundingClientRect();
      return a.right > b.left;
    });
    expect(overlaps).toBe(false);
    const metadata = (await page.locator(".plot-metadata").boundingBox())!;
    const info = (await page
      .getByRole("button", { name: "FFT & display details", exact: true })
      .boundingBox())!;
    expect(metadata.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
    expect(info.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
  }
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});

async function countDevices(page: Page) {
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function (descriptor) {
      document.documentElement.dataset.testGpuDevices = String(
        Number(document.documentElement.dataset.testGpuDevices ?? 0) + 1,
      );
      return request.call(this, descriptor);
    };
  });
}

for (const reduced of [false, true])
  test(`projected grid tunes without a black frame or terrain redraw; reduced motion ${reduced}`, async ({
    page,
  }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
    await countDevices(page);
    const plot = await ready(page, "");
    await page
      .getByRole("button", { name: "Pause display", exact: true })
      .click();
    await expect(plot).toHaveAttribute("data-surface-pending", "false");
    const clock = await page.locator(".waterfall-label").textContent(),
      scene = await plot.getAttribute("data-surface-scenes");
    const devices = await page
      .locator("html")
      .getAttribute("data-test-gpu-devices");
    await page.evaluate(() => {
      const plot = document.querySelector(".canvas-frame canvas")!,
        samples: string[] = [];
      document.body.dataset.testBlank = "0";
      new MutationObserver(() => {
        if (
          !plot.isConnected ||
          !document.querySelector(".surface-combined") ||
          document.querySelector(".plot-state")
        )
          document.body.dataset.testBlank = "1";
        samples.push(plot.getAttribute("data-surface-marker-x") ?? "");
        document.body.dataset.testMarkerSamples = JSON.stringify(samples);
      }).observe(document.querySelector(".graphics-panel")!, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    });
    const box = (await plot.boundingBox())!,
      guide = (await page.locator(".band-guide-strip").boundingBox())!;
    // Point on the empty rear floor: 70% of RF width, 80% of the selected time axis.
    const age = 0.8,
      w = 1 + age * 0.428571,
      depth = 0.5 + ((38 - 22) / 38) * 0.17;
    const ny = (-0.68 + age * (2 * depth * 1.428571 - 0.68 * 0.428571)) / w;
    const top = guide.y + guide.height - box.y,
      height = box.height - top - Math.min((box.height - top) * 0.3, 112);
    await plot.click({
      position: {
        x: ((1 + 0.4 / w) * box.width) / 2,
        y: top + ((1 - ny) * height) / 2,
      },
    });
    const strip = page.getByRole("slider", {
      name: "Front-row frequency tuning",
      exact: true,
    });
    await expect(strip).toHaveAttribute("aria-valuenow", "100200000");
    await expect
      .poll(async () =>
        Math.abs(
          Number(await plot.getAttribute("data-surface-marker-x")) -
            (0.5 + 200000 / 1024000),
        ),
      )
      .toBeLessThan(0.00001);
    await expect(page.locator(".waterfall-label")).toHaveText(clock!);
    await expect(plot).toHaveAttribute("data-surface-scenes", scene!);
    await expect(page.locator("html")).toHaveAttribute(
      "data-test-gpu-devices",
      devices!,
    );
    await expect(page.locator("body")).toHaveAttribute("data-test-blank", "0");
    const samples = JSON.parse(
      (await page.locator("body").getAttribute("data-test-marker-samples")) ??
        "[]",
    ).map(Number) as number[];
    if (!reduced)
      expect(samples.some((x) => x > 0.50001 && x < 0.6953)).toBe(true);
    else
      expect(
        samples.every(
          (x) => x === 0.5 || Math.abs(x - (0.5 + 200000 / 1024000)) < 0.00001,
        ),
      ).toBe(true);
    // Repeating the same frequency is a true no-op, including the receiver generation.
    const markers = await plot.getAttribute("data-surface-markers");
    await plot.click({
      position: {
        x: ((1 + 0.4 / w) * box.width) / 2,
        y: top + ((1 - ny) * height) / 2,
      },
    });
    await expect(plot).toHaveAttribute("data-surface-markers", markers!);
    await page
      .getByRole("button", { name: "Resume display", exact: true })
      .click();
    await expect
      .poll(async () =>
        Number(
          (await page.locator(".waterfall-label").textContent())?.match(
            /([\d.]+) \/ /,
          )?.[1] ?? 0,
        ),
      )
      .toBeGreaterThan(Number(clock!.match(/([\d.]+) \/ /)![1]) + 0.1);
  });

test("actual moving front-row pixels tune to their full-resolution frequency", async ({
  page,
}) => {
  const plot = await ready(page, "");
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const png = await plot.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const point = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const expected = (0.5 + 125000 / 1024000) * canvas.width;
    for (let y = Math.floor(canvas.height * 0.4); y < canvas.height * 0.86; y++)
      for (
        let x = Math.floor(expected) - 2;
        x <= Math.ceil(expected) + 2;
        x++
      ) {
        const i = (y * canvas.width + x) * 4;
        if (data[i]! > 225 && data[i + 1]! > 190 && data[i + 2]! > 240)
          return { x: (x + 0.5) / canvas.width, y: (y + 0.5) / canvas.height };
      }
    return null;
  }, png);
  expect(point).not.toBeNull();
  const box = (await plot.boundingBox())!;
  await plot.click({
    position: { x: point!.x * box.width, y: point!.y * box.height },
  });
  await expect(
    page.getByRole("slider", {
      name: "Front-row frequency tuning",
      exact: true,
    }),
  ).toHaveAttribute("aria-valuenow", "100100000");
  await expect(
    page.getByLabel("Receiver center frequency", { exact: true }),
  ).toHaveValue("100.000");
});

test("wide-screen channel markers retain a thin antialiased pixel width", async ({
  page,
}) => {
  // Read the actual final GPU texture, not the cached terrain or a mock. This
  // test-only COPY_SRC usage avoids compositor/font/screenshot stalls at 2880px.
  await page.addInitScript(() => {
    let device: GPUDevice | undefined,
      texture: GPUTexture | undefined,
      format: GPUTextureFormat;
    const configure = GPUCanvasContext.prototype.configure,
      getTexture = GPUCanvasContext.prototype.getCurrentTexture,
      submit = GPUQueue.prototype.submit;
    GPUCanvasContext.prototype.configure = function (config) {
      device = config.device;
      format = config.format;
      configure.call(this, {
        ...config,
        usage: (config.usage ?? 0x10) | 0x1,
      });
    };
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      texture = getTexture.call(this);
      return texture;
    };
    GPUQueue.prototype.submit = function (commands) {
      submit.call(this, commands);
      const request = document.documentElement.dataset.testReadLine;
      if (!request || !device || !texture || this !== device.queue) return;
      delete document.documentElement.dataset.testReadLine;
      const { x, y } = JSON.parse(request) as { x: number; y: number };
      const buffer = device.createBuffer({
        size: 256,
        usage: 0x8 | 0x1,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture, origin: { x, y } },
        { buffer, bytesPerRow: 256 },
        [24, 1],
      );
      submit.call(this, [encoder.finish()]);
      void buffer
        .mapAsync(0x1)
        .then(() => {
          const pixels = Array.from(
            new Uint8Array(buffer.getMappedRange()).slice(0, 96),
          );
          if (format.startsWith("bgra"))
            for (let i = 0; i < pixels.length; i += 4)
              [pixels[i], pixels[i + 2]] = [pixels[i + 2]!, pixels[i]!];
          document.documentElement.dataset.testLinePixels =
            JSON.stringify(pixels);
          buffer.unmap();
          buffer.destroy();
        })
        .catch((error) => {
          document.documentElement.dataset.testLineError = String(error);
          buffer.destroy();
        });
    };
  });
  await page.setViewportSize({ width: 2880, height: 1440 });
  const plot = await ready(page, "");
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-surface-pending", "false");
  const box = (await plot.boundingBox())!,
    guide = (await page.locator(".band-guide-strip").boundingBox())!;
  const age = 0.8,
    w = 1 + age * 0.428571,
    depth = 0.5 + ((38 - 22) / 38) * 0.17,
    ny = (-0.68 + age * (2 * depth * 1.428571 - 0.68 * 0.428571)) / w;
  const top = guide.y + guide.height - box.y,
    height = box.height - top - Math.min((box.height - top) * 0.3, 112);
  const row = box.y + top + ((1 - ny) * height) / 2;
  const read = await plot.evaluate((canvas: HTMLCanvasElement, row) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.floor(canvas.width / 2) - 12,
      y: Math.round(((row - bounds.y) * canvas.height) / bounds.height),
      ratio: canvas.width / bounds.width,
    };
  }, row);
  await page.evaluate((read) => {
    document.documentElement.dataset.testReadLine = JSON.stringify(read);
  }, read);
  await page
    .getByRole("slider", { name: "Front-row frequency tuning", exact: true })
    .press("ArrowRight");
  await expect
    .poll(() => page.locator("html").getAttribute("data-test-line-pixels"))
    .not.toBeNull();
  expect(
    await page.locator("html").getAttribute("data-test-line-error"),
  ).toBeNull();
  const pixels = JSON.parse(
    (await page.locator("html").getAttribute("data-test-line-pixels"))!,
  ) as number[];
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i]! > 45 && pixels[i + 1]! > 150 && pixels[i + 2]! > 190)
      count++;
  const width = count / read.ratio;
  expect(width).toBeGreaterThan(0.4);
  expect(width).toBeLessThanOrEqual(2.5);
});

// Keep deliberate adapter/shader/device failure injection after normal GPU
// rendering so a destroyed driver device cannot delay the next live fixture.
test("a saved 3D request safely resolves to real Canvas2D when WebGPU is absent", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    }),
  );
  await start(page);
  await expect(page.locator(".surface-notice")).toContainText(
    "3D unavailable — showing 2D",
  );
  await expect(page.locator(".canvas-frame")).not.toHaveClass(/surface-active/);
  const canvas = page.getByLabel(
    "Canvas2D RF spectrum and waterfall plot; click to tune",
    { exact: true },
  );
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL().length))
    .toBeGreaterThan(20000);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});

test("a rejected terrain shader leaves the existing 2D GPU display working", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const create = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      return create.call(
        this,
        descriptor.label === "3D spectrum history WGSL"
          ? { ...descriptor, code: "invalid terrain shader" }
          : descriptor,
      );
    };
  });
  await start(page);
  await expect(page.locator(".surface-notice")).toContainText(
    "3D unavailable — showing 2D",
  );
  await expect(
    page.getByLabel("WebGPU RF spectrum and waterfall plot; click to tune", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
});

test("a lost GPU device returns 3D to Canvas2D without stopping the source", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (descriptor) {
      const device = await request.call(this, descriptor);
      (
        window as unknown as { surfaceTestDevice: GPUDevice }
      ).surfaceTestDevice = device;
      return device;
    };
  });
  await ready(page);
  await page.evaluate(() =>
    (
      window as unknown as { surfaceTestDevice: GPUDevice }
    ).surfaceTestDevice.destroy(),
  );
  await expect(page.locator(".surface-notice")).toContainText(
    "3D unavailable — showing 2D",
  );
  await expect(
    page.getByLabel("Canvas2D RF spectrum and waterfall plot; click to tune", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
});
