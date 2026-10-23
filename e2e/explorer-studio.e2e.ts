import { expect, test } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

test("Spectrum studio spans the results and adjacent inspector without moving the plot on selection", async ({
  page,
}, info) => {
  await monitorHistory(page);
  const overview = page.getByRole("region", {
    name: "Band spectrum overview",
    exact: true,
  });
  const before = await overview.boundingBox();
  await page.locator(".monitor-frequency").first().click();
  const inspector = page.getByRole("complementary", {
    name: "Selected signal details",
    exact: true,
  });
  await expect(inspector).toContainText("914.750000 MHz");
  const plot = await overview.boundingBox();
  const results = await page.locator(".studio-results-main").boundingBox();
  const detail = await inspector.boundingBox();
  expect(Math.abs(plot!.width - before!.width)).toBeLessThan(1);
  expect(plot!.y + plot!.height).toBeLessThan(results!.y);
  expect(plot!.width).toBeGreaterThan(results!.width + detail!.width);
  expect(results!.x + results!.width).toBeLessThanOrEqual(detail!.x);
  await expect(page.locator(".monitor-setup-rail")).toBeVisible();
  const side = await page.locator(".monitor-setup-rail").boundingBox();
  expect(side!.x + side!.width).toBeLessThanOrEqual(plot!.x);
  await expect(
    page.getByLabel("Explorer activity", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Monitor setup", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("spectrum-studio-desktop.png"),
    fullPage: true,
  });
});

test("Spectrum studio keeps measurements in the inspector and one filter at narrow widths", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await monitorHistory(page);
  await page.locator(".monitor-frequency").first().click();
  const inspector = page.getByRole("complementary", {
    name: "Selected signal details",
    exact: true,
  });
  await expect(inspector).toBeVisible();
  await inspector.getByText("Measurements & evidence", { exact: true }).click();
  await expect(inspector).toContainText("valid observed time");
  await expect(page.getByLabel("Show signals", { exact: true })).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "914.750000 MHz", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: info.outputPath("spectrum-studio-phone.png"),
    fullPage: true,
  });
});

test("finite surveys keep a full-width spectrum above setup and candidate review", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  const surface = page.locator(".explorer-studio");
  const spectrum = surface.locator(".explorer-empty");
  const controls = page.getByRole("complementary", {
    name: "Spectrum scan controls",
    exact: true,
  });
  const chartBox = await spectrum.boundingBox();
  const controlBox = await controls.boundingBox();
  expect(chartBox!.y + chartBox!.height).toBeLessThan(controlBox!.y);
  expect(chartBox!.width).toBeGreaterThan(controlBox!.width * 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    controls.getByLabel("Explorer activity", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("monitoring drafts survive reload and mode changes in the persistent setup without acquisition", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  const sidebar = page.getByRole("complementary", {
    name: "Monitor setup",
    exact: true,
  });
  await sidebar
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await sidebar.getByLabel("Range start", { exact: true }).fill("84 MHz");
  await sidebar.getByLabel("Range end", { exact: true }).fill("108 MHz");
  await sidebar
    .getByLabel("Detection preset", { exact: true })
    .selectOption("narrow");
  await sidebar.getByLabel("Dwell milliseconds", { exact: true }).fill("750");
  await sidebar.getByLabel("Threshold decibels", { exact: true }).fill("9");
  await sidebar.getByLabel("Range end", { exact: true }).fill("109 MHz");
  await expect(
    page.getByRole("dialog", { name: "Monitoring setup", exact: true }),
  ).toHaveCount(0);
  await expect(sidebar.getByLabel("Range end", { exact: true })).toHaveValue(
    "109 MHz",
  );
  await sidebar
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("window");
  await sidebar
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await expect(sidebar.getByLabel("Range start", { exact: true })).toHaveValue(
    "84 MHz",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Explorer activity")).toHaveValue("monitor");
  await expect(
    sidebar.getByLabel("Monitor targets", { exact: true }),
  ).toHaveValue("range");
  await expect(sidebar.getByLabel("Range end", { exact: true })).toHaveValue(
    "109 MHz",
  );
  await expect(
    sidebar.getByLabel("Dwell milliseconds", { exact: true }),
  ).toHaveValue("750");
  await expect(
    sidebar.getByLabel("Threshold decibels", { exact: true }),
  ).toHaveValue("9");
  await expect(page.getByTestId("monitor-sweeps")).toHaveCount(0);
});

test("running monitoring accepts edited sidebar drafts only after deliberate apply and restart", async ({
  page,
}, info) => {
  await page.goto("/?browser-test=1");
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(1);
  const dwell = page.getByLabel("Dwell milliseconds", { exact: true });
  await expect(dwell).toBeEnabled();
  await dwell.fill("750");
  await expect(page.getByLabel("Active session settings")).not.toContainText(
    "750 ms",
  );
  await page
    .getByRole("button", { name: "Apply changed settings", exact: true })
    .click();
  await expect(page.getByLabel("Active session settings")).toContainText(
    "750 ms",
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.monitor-sidebar-status [data-testid="input-clipping-slot"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('.monitor-workspace > [data-testid="input-clipping-slot"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("studio-editable-sidebar.png"),
  });
});

test("spectrum typography stays at twelve screen pixels on wide and normal desktop layouts", async ({
  page,
}) => {
  await monitorHistory(page);
  for (const width of [2868, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    // Viewport resizing completes before ResizeObserver's React update.
    // Measure the committed layout within the existing expectation deadline.
    await expect(async () => {
      const size = await page
        .locator(".monitor-spectrum-plot > svg text")
        .first()
        .evaluate(
          (node) =>
            Number.parseFloat(getComputedStyle(node).fontSize) *
            (node as SVGTextElement).getScreenCTM()!.a,
        );
      expect(size).toBeGreaterThan(10);
      expect(size).toBeLessThan(14);
    }).toPass({ timeout: 7000 });
  }
});
