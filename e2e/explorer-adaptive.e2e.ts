import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { adaptiveHistory } from "./helpers/adaptiveHistory";

test("adaptive groups expand with stable middle, supported components and recovery/export provenance", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.setViewportSize({ width: 1686, height: 903 });
  const s = await adaptiveHistory(page);
  await writeFile(info.outputPath("adaptive-history.json"), JSON.stringify(s));
  await page
    .getByRole("button", { name: "Hide spectrum", exact: true })
    .click();
  const grouped = s.signals.find((x) => x.group!.componentCount === 2)!;
  const row = page
    .locator(".monitor-signal-table tbody tr")
    .filter({ hasText: "Group (2)" });
  const summary = row.locator("summary");
  await expect(row.locator(".monitor-frequency")).toHaveText(
    `${(grouped.frequencyHz / 1e6).toFixed(6)} MHz`,
  );
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(row.locator("details")).toHaveAttribute("open", "");
  await expect(row).toContainText("Median of 5 recent complete visits");
  await expect(row).toContainText("Observed center spread: 2,250 Hz");
  await expect(
    row.getByLabel("Latest supported components").locator("li"),
  ).toHaveCount(2);
  await expect(row).toContainText("bounded shallow notches");
  await page.getByLabel("Sort signals").selectOption("level");
  await expect(row.locator("details")).toHaveAttribute("open", "");
  await row.locator(".monitor-frequency").click();
  await expect(page.getByLabel("Selected signal details")).toContainText(
    "Stable middle",
  );
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.getByText("History & tools", { exact: true }).click();
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "History JSON", exact: true }).click();
  const json = await (await jsonDownload).createReadStream();
  let value = "";
  for await (const chunk of json!) value += chunk.toString();
  const exported = JSON.parse(value);
  expect(exported.version).toBe(4);
  expect(
    exported.signals.find((x: { id: string }) => x.id === grouped.id)
      .centerEvidence,
  ).toHaveLength(5);
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "History CSV", exact: true }).click();
  const csv = await (await csvDownload).createReadStream();
  let text = "";
  for await (const chunk of csv!) text += chunk.toString();
  expect(text).toContain('"components_json"');
  expect(text).toContain('"center_spread_hz"');
  await page.getByText("History & tools", { exact: true }).click();
  await page.screenshot({
    path: info.outputPath("adaptive-groups-desktop.png"),
  });
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(row.locator(".monitor-frequency")).toHaveText(
    `${(grouped.frequencyHz / 1e6).toFixed(6)} MHz`,
  );
  await summary.click();
  await expect(row).toContainText("Median of 5 recent complete visits");
  expect(errors).toEqual([]);
});

test("expanded group details remain reachable on a phone", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await adaptiveHistory(page);
  const row = page
    .locator(".monitor-signal-table tbody tr")
    .filter({ hasText: "Group (2)" });
  await row.locator("summary").click();
  const components = row.getByLabel("Latest supported components");
  await components.scrollIntoViewIfNeeded();
  await expect(components).toBeVisible();
  const geometry = await components.boundingBox();
  expect(geometry!.y).toBeGreaterThanOrEqual(0);
  expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(844);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("adaptive-groups-phone.png") });
});

test("collapsed adaptive groups retain eight complete desktop result rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1686, height: 903 });
  await adaptiveHistory(page, true);
  await page
    .getByRole("button", { name: "Hide spectrum", exact: true })
    .click();
  const visible = await page
    .locator(".monitor-signal-table tbody tr")
    .evaluateAll(
      (rows) =>
        rows.filter((r) => {
          const box = r.getBoundingClientRect();
          const viewport = r
            .closest(".monitor-results-scroll")!
            .getBoundingClientRect();
          return (
            box.top >= viewport.top &&
            box.bottom <= Math.min(innerHeight, viewport.bottom)
          );
        }).length,
    );
  expect(visible).toBeGreaterThanOrEqual(8);
});
