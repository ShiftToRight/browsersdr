import { expect, test } from "@playwright/test";
import { targetRecordingFixture } from "../src/testing/targetRecordingFixture";

test("wheel zooms the map in both directions and keeps page scrolling outside the map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 950 });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
      name: "targets.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
  await page
    .locator(".file-picker-input")
    .nth(1)
    .setInputFiles({
      name: "targets.json",
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
  const map = workspace.locator(".map-surface");
  const overlay = workspace.locator(".map-overlay");
  const width = async () =>
    Number((await overlay.getAttribute("viewBox"))!.split(" ")[2]);
  await expect(workspace.locator("canvas.map-basemap")).toHaveAttribute(
    "data-state",
    "ready",
  );
  const fitted = await width();
  await map.hover();
  const top = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, -240);
  await expect.poll(width).toBeCloseTo(fitted / 2);
  expect(await page.evaluate(() => window.scrollY)).toBe(top);
  await page.mouse.wheel(0, 240);
  await expect.poll(width).toBeCloseTo(fitted);
  expect(await page.evaluate(() => window.scrollY)).toBe(top);
  // A pending wheel frame must still reset through the existing Fit action.
  await page.mouse.wheel(0, -240);
  await expect.poll(width).toBeCloseTo(fitted / 2);
  await workspace
    .getByRole("button", { name: "Fit targets", exact: true })
    .click();
  await expect.poll(width).toBeCloseTo(fitted);
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(top);
  expect(await width()).toBeCloseTo(fitted);
  expect(
    errors.filter((message) => /passive|preventDefault/.test(message)),
  ).toEqual([]);
});
