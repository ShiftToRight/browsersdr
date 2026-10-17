import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const startButton = (page: Page) =>
  page.getByRole("button", { name: "Start monitoring", exact: true });
async function setup(
  page: Page,
  mode = "frequencies",
  receive = true,
  configureDetector = true,
) {
  await page.goto("/?browser-test=1");
  if (receive) {
    await page
      .locator('select[aria-label="Signal source"]')
      .selectOption("synthetic");
    await page.getByRole("button", { name: "Start demo", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page.getByLabel("Monitor targets", { exact: true }).selectOption(mode);
  if (receive && configureDetector) {
    await page.getByText("Detector settings", { exact: true }).click();
    await page
      .getByRole("slider", { name: "Dwell per window", exact: true })
      .fill("150");
  }
}
async function add(page: Page, f: string, label: string, width = "25 kHz") {
  const editor = page.getByRole("region", {
    name: "Custom monitor targets",
    exact: true,
  });
  await editor.getByLabel("Frequency", { exact: true }).fill(f);
  await editor.getByLabel("Watch width", { exact: true }).fill(width);
  await editor.getByLabel("Label (optional)", { exact: true }).fill(label);
  await editor
    .getByRole("button", { name: "Add frequency", exact: true })
    .click();
}
async function sweep(page: Page) {
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(1);
}

test("custom targets share windows, retain quiet targets and export their definitions", async ({
  page,
}, info) => {
  await setup(page);
  await expect(startButton(page)).toBeDisabled();
  // Both watches fit the existing 100 MHz acquisition. The quiet target is outside the synthetic sweep.
  await add(page, "100.125 MHz", "Demo carrier", "25 kHz");
  await add(page, "99.63 MHz", "Quiet channel", "25 kHz");
  await expect(page.locator(".monitor-plan")).toContainText(
    "1 shared measurement window",
  );
  await startButton(page).click();
  await sweep(page);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await page
    .getByText("Targets & observation coverage", { exact: true })
    .click();
  await expect(page.locator(".monitor-target-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Demo carrier",
  );
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Activity detected",
  );
  await expect(page.locator(".monitor-target-table")).toContainText(
    "No activity during last valid visit",
  );
  await page.getByText("History & tools", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "History JSON", exact: true }).click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.version).toBe(4);
  expect(saved.analysis).toEqual({ version: 2, preset: "general" });
  expect(saved.targets).toHaveLength(2);
  expect(
    saved.signals.some((s: { targetIds: string[] }) => s.targetIds.length > 0),
  ).toBe(true);
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  await page.getByLabel("Watch width 1", { exact: true }).fill("50 kHz");
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to results", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use saved targets", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("custom-monitor-preview.png"),
    fullPage: true,
  });
});

test("watchlists save and reload explicitly without starting acquisition", async ({
  page,
}) => {
  await setup(page, "frequencies", false);
  await add(page, "99.77 MHz", "Local channel");
  await page.getByText("Watchlists", { exact: true }).click();
  await page
    .getByLabel("Watchlist name", { exact: true })
    .fill("My local watchlist");
  await page
    .getByRole("button", { name: "Save new watchlist", exact: true })
    .click();
  await expect(
    page.getByLabel("Saved watchlist", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Remove frequency 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load watchlist", exact: true })
    .click();
  await expect(page.getByLabel("Label 1", { exact: true })).toHaveValue(
    "Local channel",
  );
  await expect(page.getByTestId("monitor-sweeps")).toHaveCount(0);
});

test("custom range checkpoints versioned targets for manual recovery", async ({
  page,
}) => {
  // Start with the same 150 ms detector settings; their UI editing is covered by the frequency test.
  await page.addInitScript(() =>
    localStorage.setItem(
      "browsersdr.surveyProfile.v1",
      JSON.stringify({
        version: 1,
        name: "Range fixture",
        site: { label: "Test site" },
        bands: [
          {
            id: "test",
            name: "Test",
            startFrequencyHz: 99.2e6,
            endFrequencyHz: 100.6e6,
            dwellMs: 150,
            thresholdDb: 10,
            detector: "average",
            captureSeconds: 10,
          },
        ],
      }),
    ),
  );
  await setup(page, "range", true, false);
  await expect(page.locator(".monitor-plan")).toContainText(
    "2 sequential measurement windows",
  );
  await startButton(page).click();
  await sweep(page);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(page.locator(".monitor-storage")).toContainText(
    "Checkpoint saved",
  );
  const before = Number(await page.getByTestId("monitor-sweeps").textContent());
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(String(before));
  await expect(page.locator(".monitor-target-table")).toContainText(
    "Custom range",
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});

test("phone custom editor accepts explicit-unit paste and rejects duplicate targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, "frequencies", false);
  await page
    .getByText("Paste frequencies or add favorites", { exact: true })
    .click();
  await page
    .getByLabel("Frequencies, one per line", { exact: true })
    .fill("99.77 MHz\n100.125 MHz");
  await page
    .getByRole("button", { name: "Add pasted frequencies", exact: true })
    .click();
  await expect(page.getByLabel("Frequency 2", { exact: true })).toHaveValue(
    "100125000 Hz",
  );
  await page
    .getByLabel("Frequencies, one per line", { exact: true })
    .fill("99.77 MHz");
  await page
    .getByRole("button", { name: "Add pasted frequencies", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Duplicate target");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
