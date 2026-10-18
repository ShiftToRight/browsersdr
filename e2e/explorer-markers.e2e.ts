import { expect, test, type Page } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

async function chooseMarker(page: Page, frequency: string) {
  const direct = page.getByRole("button", {
    name: new RegExp(
      `^Select detection at ${frequency.replaceAll(".", "\\.")}`,
    ),
  });
  if (await direct.count()) await direct.click();
  else {
    const group = page
      .getByTestId("monitor-detection-marker")
      .filter({ hasText: "signals" })
      .last();
    await group.click();
    const chooser = page.getByRole("dialog", {
      name: "Nearby detections",
      exact: true,
    });
    await chooser
      .getByRole("searchbox", { name: "Filter frequencies" })
      .fill(frequency);
    await chooser
      .getByRole("button", {
        name: new RegExp(frequency.replaceAll(".", "\\.")),
      })
      .click();
  }
}

test("detection marker selects and reveals the matching row without tuning, including hidden tentative results", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.setViewportSize({ width: 1686, height: 1000 });
  await monitorHistory(page);
  const markers = page.getByTestId("monitor-detection-marker");
  await expect(markers).not.toHaveCount(0);
  const first = page.getByRole("button", {
    name: /^Select detection at 914\.750000 MHz/,
  });
  await first.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "10,000 Hz measured width",
  );
  await expect(first).toHaveClass(/is-older/);
  await first.click();
  await expect(
    page.locator('.monitor-signal-table tr[aria-selected="true"]'),
  ).toContainText("914.750000 MHz");
  await expect(
    page.getByRole("complementary", { name: "Selected signal details" }),
  ).toContainText("914.750000 MHz");
  await page.getByLabel("Sort signals", { exact: true }).selectOption("level");
  await expect(
    page.locator('.monitor-signal-table tr[aria-selected="true"]'),
  ).toContainText("914.750000 MHz");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(first).toBeFocused();
  await page.getByRole("tab", { name: /^Targets/ }).click();
  await chooseMarker(page, "915.240000 MHz");
  await expect(page.getByRole("tab", { name: /^Signals/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Show signals", { exact: true })).toHaveValue(
    "all",
  );
  const selected = page.locator(
    '.monitor-signal-table tr[aria-selected="true"]',
  );
  await expect(selected).toContainText("915.240000 MHz");
  await expect(selected).toContainText("Tentative");
  const fullyVisible = await selected.evaluate((row) => {
    const box = row.getBoundingClientRect(),
      parent = row.closest(".monitor-results-scroll")!.getBoundingClientRect();
    return box.top >= parent.top && box.bottom <= parent.bottom;
  });
  expect(fullyVisible).toBe(true);
  await expect(
    page.locator(".monitor-detection-support.is-selected"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("spectrum-detection-selection.png"),
  });
  expect(errors).toEqual([]);
});

test("phone clusters keep every detection accessible with keyboard selection and dismissal", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await monitorHistory(page);
  const groups = page.getByTestId("monitor-detection-marker");
  expect(
    await groups.evaluateAll((buttons) =>
      buttons.reduce((n, b) => n + Number(b.getAttribute("data-count")), 0),
    ),
  ).toBe(17);
  const cluster = groups.filter({ hasText: "signals" }).first();
  await expect(cluster).toBeVisible();
  const before = await page.getByTestId("monitor-sweeps").textContent();
  await cluster.focus();
  await page.keyboard.press("Enter");
  const chooser = page.getByRole("dialog", {
    name: "Nearby detections",
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await expect(
    chooser.getByRole("searchbox", { name: "Filter frequencies" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  await expect(cluster).toBeFocused();
  await page.keyboard.press("Space");
  await expect(chooser).toBeVisible();
  const option = chooser.locator(".monitor-marker-options button").first();
  const frequency = await option.locator("strong").textContent();
  await page.screenshot({
    path: info.outputPath("spectrum-marker-chooser-phone.png"),
  });
  await option.click();
  await expect(chooser).toBeHidden();
  await expect(
    page.locator('.monitor-signal-table tr[aria-selected="true"]'),
  ).toContainText(frequency!);
  const closeDetails = page.getByRole("button", {
    name: "Close details",
    exact: true,
  });
  await expect(closeDetails).toBeInViewport();
  expect(
    await closeDetails.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return (
        document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest("button") === button
      );
    }),
  ).toBe(true);
  await closeDetails.click();
  await expect(
    page.getByRole("complementary", { name: "Selected signal details" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(before!);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("marker hit targets follow resized plots and support keyboard activation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1686, height: 1000 });
  await monitorHistory(page);
  const button = page.getByRole("button", {
    name: /^Select detection at 914\.750000 MHz/,
  });
  await expect(button).toBeVisible();
  const id = await button.getAttribute("data-signal-id");
  await expect
    .poll(async () => {
      const box = await button.boundingBox();
      const line = await page
        .locator(`.monitor-detection-support[data-signal-id="${id}"] line`)
        .boundingBox();
      return Math.abs(box!.x + box!.width / 2 - line!.x);
    })
    .toBeLessThan(1);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator('.monitor-signal-table tr[aria-selected="true"]'),
  ).toContainText("914.750000 MHz");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  const markers = page.getByTestId("monitor-detection-marker");
  await expect.poll(() => markers.count()).toBeLessThan(17);
  expect(
    await markers.evaluateAll((buttons) =>
      buttons.every((button) => {
        const b = button.getBoundingClientRect();
        return (
          b.width >= 44 &&
          b.height >= 44 &&
          b.left >= 0 &&
          b.right <= innerWidth
        );
      }),
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Hide spectrum", exact: true })
    .click();
  await expect(markers).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show spectrum", exact: true })
    .click();
  await expect(markers).not.toHaveCount(0);
});

test("live synthetic detections stay linked to their row across scan updates and pause/resume", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1686, height: 1000 });
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
    .toBeGreaterThanOrEqual(3);
  const marker = page.getByTestId("monitor-detection-marker").first();
  await marker.click();
  const chooser = page.getByRole("dialog", {
    name: "Nearby detections",
    exact: true,
  });
  if (await chooser.isVisible())
    await chooser.locator(".monitor-marker-options button").first().click();
  const row = page.locator('.monitor-signal-table tr[aria-selected="true"]');
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-signal-id");
  const sweeps = Number(await page.getByTestId("monitor-sweeps").textContent());
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThan(sweeps);
  await expect(row).toHaveAttribute("data-signal-id", id!);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("monitor-spectrum-trace")).not.toHaveCount(0);
  await expect(
    page.locator(".monitor-detection-support.is-selected"),
  ).toHaveAttribute("data-signal-id", id!);
  await page.screenshot({
    path: info.outputPath("live-spectrum-selected-detection.png"),
  });
  await page
    .getByRole("button", { name: "Resume monitoring", exact: true })
    .click();
  await expect(row).toHaveAttribute("data-signal-id", id!);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
});
