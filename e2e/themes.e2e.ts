import { expect, test, type Page } from "@playwright/test";

async function chooseTheme(page: Page, value: string) {
  const menu = page
    .locator(".header-utility-menu")
    .filter({ has: page.getByLabel("Settings", { exact: true }) });
  if (!(await menu.evaluate((element) => element.hasAttribute("open"))))
    await page.getByLabel("Settings", { exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption(value);
  await page.getByLabel("Theme", { exact: true }).press("Escape");
}

test("appearance switches while receiving, preserves paused pixels/history, and survives reload", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/?browser-test=1");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  await page.locator(".display-settings > summary").click();
  await page.getByLabel("Display renderer").selectOption("canvas2d");
  await expect
    .poll(() =>
      page
        .locator(".canvas-frame canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL().length),
    )
    .toBeGreaterThan(20000);
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
  await page.locator(".display-settings > summary").click();
  const plot = page.locator(".canvas-frame canvas");
  // Closing Display settings changes the plot height; await its backing size.
  await expect
    .poll(() =>
      plot.evaluate((canvas: HTMLCanvasElement) => {
        const box = canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        return (
          canvas.width === Math.round(box.width * ratio) &&
          canvas.height === Math.round(box.height * ratio)
        );
      }),
    )
    .toBe(true);
  const original = await plot.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  const node = await plot.elementHandle();
  for (const theme of ["field-deck", "vice-afterglow", "classic"]) {
    await chooseTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.getByRole("button", { name: "Resume display", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".receiver-status")).toContainText(
      "Synthetic RF demo running",
    );
    expect(await plot.evaluate((canvas, old) => canvas === old, node)).toBe(
      true,
    );
    if (theme !== "classic") {
      await expect
        .poll(() =>
          plot.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
        )
        .not.toBe(original);
    } else
      await expect
        .poll(() =>
          plot.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
        )
        .toBe(original);
    if (process.env.BSD_THEME_SCREENSHOT_DIR && theme !== "classic") {
      await page.screenshot({
        path: `${process.env.BSD_THEME_SCREENSHOT_DIR}/${theme}-${test.info().project.name}.png`,
      });
    }
    if (theme === "vice-afterglow") {
      await expect(page.locator(".theme-source-art")).toBeVisible();
      expect(
        await page
          .locator(".theme-source-art")
          .evaluate((el) => getComputedStyle(el).backgroundImage),
      ).toContain("vice-mockup-sprite");
    }
  }
  await chooseTheme(page, "field-deck");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "field-deck",
  );
  expect(errors).toEqual([]);
});

test("both themes fit narrow screens and keyboard menus, with readable auxiliary surfaces", async ({
  page,
}) => {
  await page.goto("/");
  for (const theme of ["field-deck", "vice-afterglow"]) {
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await chooseTheme(page, theme);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByLabel("Theme", { exact: true })).toBeVisible();
      const box = (await page
        .getByLabel("Theme", { exact: true })
        .boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.getByLabel("Theme", { exact: true }).press("Escape");
    }
    await page.getByLabel("Help", { exact: true }).click();
    await page
      .getByRole("button", { name: "Help & setup", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Help & setup", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to Receiver", exact: true })
      .click();
  }
});
