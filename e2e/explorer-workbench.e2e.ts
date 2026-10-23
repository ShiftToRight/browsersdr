import { expect, test } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

test("guided monitoring separates the draft from retained settings and keeps quiet targets visible", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(
    page.getByRole("heading", { name: "1 What to watch" }),
  ).toBeVisible();
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("frequencies");
  const editor = page.getByRole("region", {
    name: "Custom monitor targets",
    exact: true,
  });
  for (const [frequency, label] of [
    ["100.125 MHz", "Demo carrier"],
    ["99.63 MHz", "Quiet target"],
  ]) {
    await editor.getByLabel("Frequency", { exact: true }).fill(frequency!);
    await editor.getByLabel("Label (optional)", { exact: true }).fill(label!);
    await editor
      .getByRole("button", { name: "Add frequency", exact: true })
      .click();
  }
  // The persistent desktop sidebar edits targets directly beside the results.

  await page.getByRole("tab", { name: /^Targets/ }).click();
  await expect(page.locator(".monitor-target-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Not yet observed",
  );
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect(page.locator(".monitor-shell")).toHaveAttribute(
    "data-guided",
    "false",
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  const resume = page.getByRole("button", {
    name: "Resume monitoring",
    exact: true,
  });
  await expect(resume).toBeEnabled();
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Activity detected",
  );
  await expect(page.locator(".monitor-target-table")).toContainText(
    "No activity during last valid visit",
  );
  await expect(page.getByLabel("Active session settings")).toContainText(
    "350 ms per window",
  );
  await page.getByLabel("Dwell milliseconds", { exact: true }).fill("500");
  await expect(page.getByLabel("Active session settings")).toContainText(
    "350 ms per window",
  );
  await expect(page.getByLabel("Active session settings")).toContainText(
    "Setup differs",
  );
  await expect(resume).toBeDisabled();
  await page.getByLabel("Dwell milliseconds", { exact: true }).fill("350");
  await expect(resume).toBeEnabled();
  await expect(page.getByRole("tab", { name: /^Targets/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("workbench overview and inspector preserve selected identity and keyboard focus", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.setViewportSize({ width: 1686, height: 903 });
  await monitorHistory(page);
  await expect(
    page.getByRole("img", {
      name: "Latest measured band power spectrum in relative dB",
    }),
  ).toBeVisible();
  await expect(page.locator(".monitor-overview")).toContainText(
    "recovered signal history contains no saved spectrum samples",
  );
  await expect(page.getByTestId("monitor-spectrum-trace")).toHaveCount(0);
  await page.locator(".monitor-frequency").first().click();
  const inspector = page.getByRole("complementary", {
    name: "Selected signal details",
  });
  await expect(inspector).toContainText("914.750000 MHz");
  await expect(inspector).toContainText("Latest 4 valid visits");
  await page.getByLabel("Sort signals", { exact: true }).selectOption("level");
  await expect(inspector).toContainText("914.750000 MHz");
  const table = await page.locator(".monitor-signal-table").boundingBox();
  const detail = await inspector.boundingBox();
  expect(table!.x + table!.width).toBeLessThanOrEqual(detail!.x + 1);
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "914.750000 MHz", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath("workbench-desktop.png") });
  expect(errors).toEqual([]);
});

test("phone workbench exposes setup and targets without page overflow", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await monitorHistory(page);
  await expect(
    page.getByRole("complementary", { name: "Monitor setup", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Targets/ }).click();
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Custom UHF range",
  );
  await expect(
    page.getByLabel("Monitor targets", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const rail = page.getByRole("complementary", {
    name: "Monitor setup",
    exact: true,
  });
  const railBox = await rail.boundingBox();
  expect(railBox!.x).toBeGreaterThanOrEqual(0);
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("dialog", { name: "Monitoring setup", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("setup-inline-phone.png") });
  await page.getByRole("tab", { name: /^Signals/ }).click();
  await page.locator(".monitor-frequency").first().click();
  const detail = page.getByRole("complementary", {
    name: "Selected signal details",
  });
  const box = await detail.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("workbench-phone.png") });
});
