import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function setup(page: Page, configureDetector = true) {
  await page.goto("/?browser-test=1");
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo" }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  if (configureDetector) {
    await page.getByText("Detector settings", { exact: true }).click();
    await page
      .getByRole("slider", { name: "Dwell per window", exact: true })
      .fill("150");
    await page
      .getByRole("slider", { name: "Detection threshold", exact: true })
      .fill("6");
  }
  await expect(
    page.getByRole("button", { name: "Start monitoring", exact: true }),
  ).toBeEnabled();
}
const monitor = (page: Page) =>
  page.getByRole("region", { name: "Continuous monitoring", exact: true });
async function waitSweeps(page: Page, count = 3) {
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(count);
}

test("monitor holds a fixed center, retains stable signals and resumes the same history", async ({
  page,
}, testInfo) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await setup(page);
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await waitSweeps(page);
  await expect(monitor(page)).toContainText("Fixed window");
  await expect(page.locator(".monitor-signal-table tbody tr")).not.toHaveCount(
    0,
  );
  await page.getByText("History & tools", { exact: true }).click();
  await page.locator(".monitor-signal-table tbody button").first().click();
  await expect(
    page.getByRole("complementary", { name: "Selected signal details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Investigate in Receiver" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Pause monitoring" }).click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring" }),
  ).toBeEnabled();
  await expect(page.locator(".monitor-signal-table tbody")).toContainText(
    "new",
  );
  await page.screenshot({
    path: testInfo.outputPath("monitor-preview.png"),
    fullPage: true,
  });
  const before = Number(await page.getByTestId("monitor-sweeps").textContent());
  const exportPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "History JSON" }).click();
  const exported = JSON.parse(
    await readFile((await (await exportPromise).path())!, "utf8"),
  );
  expect(exported.status).toBe("paused");
  await page
    .getByRole("button", { name: "Set comparison baseline", exact: true })
    .click();
  await expect(page.locator(".monitor-signal-table tbody")).toContainText(
    "known",
  );
  expect(
    exported.signals.some((s: { detections: number }) => s.detections >= 3),
  ).toBe(true);
  await page.getByRole("button", { name: "Resume monitoring" }).click();
  await waitSweeps(page, before + 2);
  await expect(
    page.getByRole("complementary", { name: "Selected signal details" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop monitoring" }).click();
  await expect(monitor(page)).toContainText("Monitoring stopped");
  expect(errors).toEqual([]);
});

test("monitor sweeps enabled bands with measured coverage and retains history across reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "browsersdr.surveyProfile.v1",
      JSON.stringify({
        version: 1,
        name: "Sweep test",
        site: { label: "Test site" },
        bands: [
          {
            id: "test-band",
            name: "Synthetic band",
            // Two meaningful tuning windows: 99.77 MHz and 100.125 MHz carriers.
            startFrequencyHz: 99.2e6,
            endFrequencyHz: 100.6e6,
            dwellMs: 150,
            thresholdDb: 6,
            detector: "max-hold",
            captureSeconds: 2,
          },
        ],
      }),
    );
  });
  await setup(page, false);
  await page.getByLabel("Monitor targets").selectOption("band-plan");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  // Verify the initial complete pass, then a repeated complete pass.
  await waitSweeps(page, 1);
  await waitSweeps(page, 2);
  await expect(monitor(page)).toContainText("2 sequential windows");
  await page
    .getByText("Targets & observation coverage", { exact: true })
    .click();
  await page.getByText("Coverage & revisit times", { exact: true }).click();
  await expect(page.locator(".monitor-coverage tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Pause monitoring" }).click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring" }),
  ).toBeEnabled();
  await expect(page.locator(".monitor-storage")).toContainText(
    "Checkpoint saved",
  );
  const before = Number(await page.getByTestId("monitor-sweeps").textContent());
  const count = await page.locator(".monitor-signal-table tbody tr").count();
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(String(before));
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(
    count,
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring" }),
  ).toHaveCount(0);
  await page.getByText("History & tools", { exact: true }).click();
  await expect(monitor(page)).toContainText(
    "gaps and failed visits are unobserved",
  );
});

test("monitor checkpoint quota failure leaves in-memory history exportable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "sessions")
        throw new DOMException("Test quota failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await setup(page);
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await waitSweeps(page);
  await page.getByRole("button", { name: "Pause monitoring" }).click();
  await expect(page.locator(".monitor-storage")).toContainText("Not saved:");
  await page.getByText("History & tools", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "History CSV" }).click();
  expect(await readFile((await (await download).path())!, "utf8")).toContain(
    "frequency_hz",
  );
  await expect(
    page.getByRole("button", { name: "Resume monitoring" }),
  ).toBeEnabled();
});

test("monitor freezes preserve history and require manual resume", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await waitSweeps(page);
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await expect(
    page.getByRole("button", { name: "Resume monitoring" }),
  ).toBeEnabled();
  const count = await page.getByTestId("monitor-sweeps").textContent();
  await page.evaluate(() => document.dispatchEvent(new Event("resume")));
  await expect(
    page.getByRole("button", { name: "Pause monitoring" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(count!);
});

test("monitor phone layout and investigation keep controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await waitSweeps(page);
  await page.getByRole("button", { name: "Pause monitoring" }).click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator(".monitor-signal-table tbody button").first().click();
  await page.getByRole("button", { name: "Investigate in Receiver" }).click();
  await expect(
    page.getByRole("tab", { name: "Receiver", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause monitoring" }),
  ).toHaveCount(0);
  await expect(page.locator(".monitor-signal-table tbody tr")).not.toHaveCount(
    0,
  );
});
