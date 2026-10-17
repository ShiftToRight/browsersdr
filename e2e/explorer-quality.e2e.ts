import { expect, test } from "@playwright/test";
import { monitorHistory as history } from "./helpers/monitorHistory";

test("compact Explorer puts a useful UHF result list above the fold and keeps signal details reachable", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.setViewportSize({ width: 1686, height: 903 });
  await history(page);
  await page
    .getByRole("button", { name: "Hide spectrum", exact: true })
    .click();
  const rail = await page.locator(".explorer-controls").boundingBox();
  const table = await page.locator(".monitor-signal-table").boundingBox();
  expect(rail!.width).toBeLessThanOrEqual(310);
  expect(table!.y).toBeLessThan(400);
  expect(table!.width).toBeGreaterThan(1150);
  const toolbar = await page.locator(".monitor-toolbar").first().boundingBox();
  const metrics = await page.locator(".monitor-metrics").boundingBox();
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(metrics!.y);
  expect(metrics!.y + metrics!.height).toBeLessThan(table!.y);
  const viewportBottom = 903;
  const visibleRows = await page
    .locator(".monitor-signal-table tbody tr")
    .evaluateAll(
      (rows, bottom) =>
        rows.filter((r) => {
          const row = r.getBoundingClientRect();
          const viewport = r
            .closest(".monitor-results-scroll")!
            .getBoundingClientRect();
          return (
            row.top >= viewport.top &&
            row.bottom <= Math.min(bottom, viewport.bottom)
          );
        }).length,
      viewportBottom,
    );
  expect(visibleRows).toBeGreaterThanOrEqual(8);
  await expect(page.getByLabel("Show signals")).toHaveValue("confirmed");
  await page.getByLabel("Show signals").selectOption("all");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(17);
  await expect(page.locator(".monitor-signal-table tbody")).toContainText(
    "Tentative",
  );
  await page.getByLabel("Show signals").selectOption("history");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(16);
  await page.getByLabel("Show signals").selectOption("confirmed");
  await expect(
    page.locator(".monitor-signal-table tbody tr").first(),
  ).toContainText("914.750");
  await expect(
    page.locator(".monitor-signal-table tbody tr").first(),
  ).toContainText("Confirmed");
  await page.getByLabel("Sort signals").selectOption("level");
  await expect(
    page.locator(".monitor-signal-table tbody tr").first(),
  ).toContainText("915.200");
  await page.getByLabel("Sort signals").selectOption("frequency");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("compact-explorer-uhf.png") });
  await page.locator(".monitor-frequency").first().click();
  const inspector = page.getByRole("complementary", {
    name: "Selected signal details",
  });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("914.745");
  await expect(inspector).toContainText("914.755");
  await expect(inspector).toContainText("914.752");
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("spectrum presets and optional FM presets apply explicit editable settings", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  const preset = page.getByLabel("Detection preset", { exact: true });
  await expect(preset).toHaveValue("general");
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await page.getByLabel("Range start", { exact: true }).fill("5.75 GHz");
  await page.getByLabel("Range end", { exact: true }).fill("5.85 GHz");
  await expect(preset).toHaveValue("general");
  await page.getByText("Detector settings", { exact: true }).click();
  const dwell = page.getByRole("slider", {
    name: "Dwell per window",
    exact: true,
  });
  const threshold = page.getByRole("slider", {
    name: "Detection threshold",
    exact: true,
  });
  for (const [key, ms, db] of [
    ["fm-balanced", "350", "12"],
    ["fm-weak", "750", "8"],
    ["fm-strong", "350", "15"],
    ["narrow", "500", "10"],
    ["wide", "500", "10"],
    ["bursts", "1000", "12"],
    ["general", "350", "10"],
  ]) {
    await preset.selectOption(key!);
    await expect(dwell).toHaveValue(ms!);
    await expect(threshold).toHaveValue(db!);
  }
  await dwell.fill("600");
  await threshold.fill("9");
  await expect(preset).toHaveValue("general");
  await expect(dwell).toHaveValue("600");
  await expect(threshold).toHaveValue("9");
  await expect(page.getByTestId("monitor-sweeps")).toHaveCount(0);
});

test("compact Explorer history and inspector fit a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await history(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".monitor-frequency").first().click();
  const inspector = page.getByRole("complementary", {
    name: "Selected signal details",
  });
  await expect(inspector).toBeVisible();
  const box = await inspector.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(inspector).toHaveCount(0);
});
