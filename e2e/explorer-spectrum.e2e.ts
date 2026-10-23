import { expect, test } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

test("band spectrum follows real synthetic measurements and the active tuning window", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.addInitScript(() =>
    localStorage.setItem(
      "browsersdr.surveyProfile.v1",
      JSON.stringify({
        version: 1,
        name: "Spectrum preview",
        site: { label: "Synthetic test" },
        bands: [
          {
            id: "test",
            name: "Synthetic band",
            startFrequencyHz: 99.2e6,
            endFrequencyHz: 100.6e6,
            dwellMs: 600,
            thresholdDb: 6,
            detector: "max-hold",
            captureSeconds: 2,
          },
        ],
      }),
    ),
  );
  await page.goto("/?browser-test=1");
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("band-plan");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  const active = page.getByTestId("monitor-active-window");
  const seen = new Set<string>();
  await expect
    .poll(async () => {
      const index = await active.getAttribute("data-window-index");
      if (index !== null) seen.add(index);
      return seen.size;
    })
    .toBeGreaterThanOrEqual(2);
  const traces = page.getByTestId("monitor-spectrum-trace");
  // Both grids cover the band, but the shifted grid has a third endpoint visit.
  // A quiet endpoint need not contain the signal variation of an interior trace.
  await expect
    .poll(async () => {
      const values = await traces.evaluateAll((lines) =>
        lines.map((line) => {
          const points = line
            .getAttribute("points")!
            .split(" ")
            .map((p) => p.split(",").map(Number));
          return {
            count: points.length,
            levels: new Set(points.map((p) => p[1])).size,
          };
        }),
      );
      return (
        values.length >= 2 &&
        values.length <= 5 &&
        values.every((p) => p.count > 100) &&
        values.some((p) => p.levels > 10)
      );
    })
    .toBe(true);
  await expect(
    page.getByRole("img", {
      name: "Latest measured band power spectrum in relative dB",
    }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("band-spectrum-running.png") });
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await expect(active).toHaveCount(0);
  await expect(page.getByTestId("monitor-last-window")).toHaveCount(1);
  expect(await traces.count()).toBeGreaterThanOrEqual(2);
  expect(await traces.count()).toBeLessThanOrEqual(5);
  await page.getByText("History & tools", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore active settings", exact: true }),
  ).toHaveCount(0);
  await page.getByText("History & tools", { exact: true }).click();
  await expect(page.getByLabel("Band spectrum overview")).toContainText(
    "Paused",
  );
  await page
    .getByRole("button", { name: "Resume monitoring", exact: true })
    .click();
  await expect(active).toHaveCount(1);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  expect(errors).toEqual([]);
});

test("inline setup preserves result geometry and drafts without a modal", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1686, height: 903 });
  await monitorHistory(page);
  const results = page.locator(".monitor-workspace");
  const before = await results.boundingBox();
  const setup = page.getByRole("complementary", {
    name: "Monitor setup",
    exact: true,
  });
  await setup
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("frequencies");
  await setup.getByLabel("Frequency", { exact: true }).fill("99.77 MHz");
  await setup
    .getByLabel("Label (optional)", { exact: true })
    .fill("Sidebar draft");
  await setup
    .getByRole("button", { name: "Add frequency", exact: true })
    .click();
  await setup
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await setup.getByLabel("Range start", { exact: true }).fill("99.3 MHz");
  await setup
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("frequencies");
  await expect(setup.getByLabel("Label 1", { exact: true })).toHaveValue(
    "Sidebar draft",
  );
  await expect(
    page.getByRole("dialog", { name: "Monitoring setup", exact: true }),
  ).toHaveCount(0);
  const after = await results.boundingBox();
  expect(after!.x).toEqual(before!.x);
  expect(after!.y).toEqual(before!.y);
  expect(after!.width).toEqual(before!.width);
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("monitor-inline-setup.png") });
});

test("band spectrum fills a wide workspace and keeps markers aligned when resized", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 2868, height: 1440 });
  await monitorHistory(page);
  const plot = page.getByRole("img", {
    name: "Latest measured band power spectrum in relative dB",
    exact: true,
  });
  const geometry = () =>
    plot.evaluate((node) => {
      const svg = node as SVGSVGElement;
      const box = svg.getBoundingClientRect(),
        matrix = svg.getScreenCTM()!;
      const start = new DOMPoint(0, 0).matrixTransform(matrix),
        end = new DOMPoint(1200, 184).matrixTransform(matrix);
      return {
        width: box.width,
        height: box.height,
        drawnWidth: end.x - start.x,
        leftInset: start.x - box.left,
      };
    });
  const wide = await geometry();
  expect(wide.width).toBeGreaterThan(2000);
  expect(wide.height).toBe(240);
  expect(wide.height).toBeLessThan(500);
  expect(Math.abs(wide.drawnWidth - wide.width)).toBeLessThan(1);
  expect(Math.abs(wide.leftInset)).toBeLessThan(1);
  const marker = page.getByRole("button", {
    name: /^Select detection at 914\.750000 MHz/,
  });
  await expect(marker).toBeVisible();
  const expectedX = await plot.evaluate(
    (node) =>
      new DOMPoint(52 + (0.05 / 0.6) * 1128, 18).matrixTransform(
        (node as SVGSVGElement).getScreenCTM()!,
      ).x,
  );
  await expect
    .poll(async () => {
      const box = await marker.boundingBox();
      return Math.abs(box!.x + box!.width / 2 - expectedX);
    })
    .toBeLessThan(1);
  await page.screenshot({ path: info.outputPath("wide-band-spectrum.png") });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () => {
        const current = await geometry();
        return Math.abs(current.drawnWidth - current.width);
      })
      .toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
