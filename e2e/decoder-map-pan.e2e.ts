import { expect, test } from "@playwright/test";
import { targetRecordingFixture } from "../src/testing/targetRecordingFixture";

test("Decoder map pans without selecting a dragged aircraft and Fit restores framing", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  const fixture = targetRecordingFixture("ADS-B");
  await page
    .locator(".file-picker-input")
    .nth(0)
    .setInputFiles({
      name: "aircraft.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
  await page
    .locator(".file-picker-input")
    .nth(1)
    .setInputFiles({
      name: "aircraft.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.metadata)),
    });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("tab", { name: "Decoder", exact: true }).click();
  const workspace = page.locator("#decoder-view");
  await expect(workspace.locator(".decoder-state")).toHaveText(
    "Retained / idle",
  );
  await expect(workspace.locator("canvas.map-basemap")).toHaveAttribute(
    "data-state",
    "ready",
  );
  const map = workspace.locator(".map-surface");
  const overlay = workspace.locator(".map-overlay");
  const original = await overlay.getAttribute("viewBox");
  const marker = workspace.locator(".map-target").first();
  const bounds = await marker.boundingBox();
  const from = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(overlay).not.toHaveAttribute("viewBox", original!);
  await expect(workspace.locator(".decoder-inspector")).toHaveCount(0);
  await expect(workspace.locator("canvas.map-basemap")).toHaveAttribute(
    "data-state",
    "ready",
  );
  const afterDrag = await overlay.getAttribute("viewBox");
  await map.focus();
  await map.press("ArrowRight");
  await expect(overlay).not.toHaveAttribute("viewBox", afterDrag!);
  await expect(map).toBeFocused();
  await workspace
    .getByRole("button", { name: "Fit targets", exact: true })
    .click();
  await expect(overlay).toHaveAttribute("viewBox", original!);
  await marker.press("Enter");
  await expect(workspace.locator(".decoder-inspector")).toBeVisible();
  await workspace
    .getByRole("button", { name: "Close record details", exact: true })
    .click();
  await expect(marker).toBeFocused();
  await page.setViewportSize({ width: 390, height: 950 });
  await map.focus();
  const narrow = await overlay.getAttribute("viewBox");
  await map.press("ArrowDown");
  await expect(overlay).not.toHaveAttribute("viewBox", narrow!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  const detail = await workspace
    .getByRole("button", { name: "Detailed map" })
    .boundingBox();
  const fit = await workspace
    .getByRole("button", { name: "Fit targets", exact: true })
    .boundingBox();
  expect(detail!.y).toBeGreaterThanOrEqual(fit!.y + fit!.height);
  await expect(workspace).toContainText("Natural Earth 1:110m overview");
  await page.screenshot({
    path: test.info().outputPath("phone-map-controls.png"),
  });
});
