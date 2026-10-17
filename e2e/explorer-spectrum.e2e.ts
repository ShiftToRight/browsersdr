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
    .toBe(2);
  const traces = page.getByTestId("monitor-spectrum-trace");
  await expect(traces).toHaveCount(2);
  expect(
    await traces.evaluateAll((lines) =>
      lines.every((line) => {
        const points = line
          .getAttribute("points")!
          .split(" ")
          .map((p) => p.split(",").map(Number));
        return (
          points.length > 100 && new Set(points.map((p) => p[1])).size > 10
        );
      }),
    ),
  ).toBe(true);
  await expect(page.getByLabel("Band spectrum overview")).toContainText(
    "2/2 windows measured",
  );
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
  await expect(traces).toHaveCount(2);
  await page.getByText("History & tools", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use saved targets", exact: true }),
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

test("target dropdown opens a modal over stable results and retains the draft and focus", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1686, height: 903 });
  await monitorHistory(page);
  const results = page.locator(".monitor-workspace");
  const before = await results.boundingBox();
  const target = page.getByLabel("Monitor targets", { exact: true });
  await target.selectOption("frequencies");
  const dialog = page.getByRole("dialog", {
    name: "Monitoring setup",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(await results.boundingBox()).toEqual(before);
  await expect(
    page.getByRole("button", { name: "Close setup", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Back to results", exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Frequency", { exact: true }).fill("99.77 MHz");
  await dialog
    .getByLabel("Label (optional)", { exact: true })
    .fill("Popup draft");
  await dialog
    .getByRole("button", { name: "Add frequency", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("monitor-setup-popup.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(target).toBeFocused();
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  await expect(dialog.getByLabel("Label 1", { exact: true })).toHaveValue(
    "Popup draft",
  );
  await dialog
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await dialog.getByLabel("Range start", { exact: true }).fill("99.3 MHz");
  await dialog
    .getByRole("button", { name: "Close setup", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  await expect(dialog.getByLabel("Range start", { exact: true })).toHaveValue(
    "99.3 MHz",
  );
  await dialog
    .getByRole("button", { name: "Close setup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit setup", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});
