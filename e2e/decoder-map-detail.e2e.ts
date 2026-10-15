import { expect, test } from "@playwright/test";
import { targetRecordingFixture } from "../src/testing/targetRecordingFixture";

for (const mode of ["ADS-B", "AIS"] as const) {
  test(`${mode} maps start detailed, zoom without decoding changes, and retain bounded sharp pixels`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const mapRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("natural-earth"))
        mapRequests.push(request.url());
    });
    await page.goto("/?browser-test=1");
    // Geography stays deferred until there are decoded positions to display.
    expect(mapRequests).toHaveLength(0);
    await page
      .getByRole("combobox", { name: "Signal source" })
      .selectOption("replay");
    await page
      .getByRole("tab", { name: "Capture & replay", exact: true })
      .click();
    const fixture = targetRecordingFixture(mode);
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
    await page
      .getByRole("button", { name: "Start replay", exact: true })
      .click();
    await page.getByRole("tab", { name: "Decoder", exact: true }).click();
    const workspace = page.locator("#decoder-view");
    const background = workspace.locator("canvas.map-basemap");
    const map = workspace.locator(".map-surface");
    const overlay = workspace.locator(".map-overlay");
    await expect(workspace.locator(".decoder-state")).toHaveText(
      "Retained / idle",
    );
    await expect(background).toHaveAttribute("data-state", "ready");
    await expect(
      workspace.getByRole("button", { name: "Detailed map" }),
    ).toHaveCount(0);
    await expect(workspace).toContainText("Natural Earth 1:10m");
    await expect(workspace.locator(".map-place").first()).toBeVisible();
    expect(mapRequests.some((url) => url.includes("10m-base"))).toBe(true);
    expect(mapRequests.some((url) => url.includes("110m"))).toBe(false);
    const sampling = await background.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const display = canvas.getBoundingClientRect();
      const [, , regionWidth] = canvas.dataset
        .rasterViewbox!.split(" ")
        .map(Number);
      const [, , visibleWidth] = canvas
        .parentElement!.querySelector("svg")!
        .getAttribute("viewBox")!
        .split(" ")
        .map(Number);
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let visibleLand = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 36 && pixels[i + 1] === 74 && pixels[i + 2] === 88)
          visibleLand++;
      return {
        frontBytes: canvas.width * canvas.height * 4,
        rasterBytes:
          Number(canvas.dataset.rasterWidth) *
          Number(canvas.dataset.rasterHeight) *
          4,
        sourcePixelsPerCssPixel:
          (Number(canvas.dataset.rasterWidth) * visibleWidth!) /
          regionWidth! /
          display.width,
        visibleLand,
      };
    });
    expect(sampling.frontBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(sampling.rasterBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(sampling.sourcePixelsPerCssPixel).toBeGreaterThanOrEqual(0.9);
    expect(sampling.visibleLand).toBeGreaterThan(100);
    const fitted = await overlay.getAttribute("viewBox");
    const positions = await workspace.locator(".map-target").count();
    await workspace
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    const close = await overlay.getAttribute("viewBox");
    expect(Number(close!.split(" ")[2])).toBeCloseTo(
      Number(fitted!.split(" ")[2]) / 2,
    );
    await expect(background).toHaveAttribute("data-state", "ready");
    await map.focus();
    await map.press("-");
    await expect(overlay).toHaveAttribute("viewBox", fitted!);
    await map.press("+");
    await workspace
      .getByRole("button", { name: "Fit targets", exact: true })
      .click();
    await expect(overlay).toHaveAttribute("viewBox", fitted!);
    await expect(workspace.locator(".map-target")).toHaveCount(positions);
    await workspace
      .getByRole("group", { name: "Result presentation" })
      .getByRole("button", { name: "Results", exact: true })
      .click();
    await workspace
      .getByRole("button", { name: "Map & results", exact: true })
      .click();
    await expect(background).toHaveAttribute("data-state", "ready");
    await expect(workspace.locator(".map-place").first()).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`${mode}-detailed-map.png`),
    });
    expect(errors).toEqual([]);
  });
}

test("a failed detailed-map fetch leaves targets usable and Retry map loads the fine geography", async ({
  page,
}) => {
  let mapAvailable = false;
  await page.route("**/natural-earth-10m-base*", (route) => {
    // Vite also serves an import module at this path; fail only the SVG fetch.
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (!mapAvailable)
      return route.fulfill({ status: 503, body: "Unavailable" });
    return route.continue();
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
  await expect(
    workspace.getByRole("button", { name: "Retry map", exact: true }),
  ).toBeVisible();
  await expect(workspace.locator(".map-target").first()).toBeVisible();
  mapAvailable = true;
  await workspace
    .getByRole("button", { name: "Retry map", exact: true })
    .click();
  await expect(workspace.locator("canvas.map-basemap")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(
    workspace.getByRole("button", { name: "Retry map", exact: true }),
  ).toHaveCount(0);
});
