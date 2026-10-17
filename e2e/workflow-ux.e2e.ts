import { expect, test } from "@playwright/test";
import { chooseReceiverMode } from "./application-navigation";
import { targetRecordingFixture } from "../src/testing/targetRecordingFixture";

test("status changes keep header utility targets still and chooser filtering keeps its frame", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  const utility = page.locator(".header-utility-menu").first();
  const before = (await utility.boundingBox())!;
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.locator(".receiver-status summary").first()).toContainText(
    "Receiving",
  );
  const receiving = (await utility.boundingBox())!;
  expect(Math.abs(before.x - receiving.x)).toBeLessThan(1);
  expect(Math.abs(before.y - receiving.y)).toBeLessThan(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "More modes…", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Choose a decoder" });
  await expect(chooser.locator(".mode-chooser-footer")).toContainText(
    "Current mode:",
  );
  await expect(chooser).toContainText("Pin adds a mode to the quick list");
  const search = chooser.getByRole("searchbox", {
    name: "Search modes or decoders",
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await search.fill("");
    const all = (await chooser.boundingBox())!;
    await search.fill("navtex");
    const filtered = (await chooser.boundingBox())!;
    expect(Math.abs(all.y - filtered.y)).toBeLessThan(1);
    expect(Math.abs(all.height - filtered.height)).toBeLessThan(1);
    expect(filtered.x).toBeGreaterThanOrEqual(0);
    expect(filtered.x + filtered.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `.local/ux-workflow-20261016/chooser-${width}-${info.project.name}.png`,
      fullPage: true,
    });
  }
});

test("mode-specific channels are explicit proposals and do not start reception", async ({
  page,
}) => {
  await page.goto("/");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("99.7");
  await chooseReceiverMode(page, "DAB");
  await expect(channel).toHaveValue("99.700");
  await page.getByRole("button", { name: "Use DAB 5C", exact: true }).click();
  await expect(channel).toHaveValue("178.352");
  await expect(
    page.getByRole("combobox", { name: "Band III channel", exact: true }),
  ).toHaveValue("5C");
  await chooseReceiverMode(page, "ACARS");
  await page
    .getByRole("button", { name: "Use 131.725 MHz", exact: true })
    .click();
  await expect(channel).toHaveValue("131.725");
  await expect(page.locator(".mode-frequency-hint")).toContainText(
    "Example European ACARS channel",
  );
  await chooseReceiverMode(page, "ADS-B");
  await expect(channel).toHaveValue("1090.000");
  await expect(page.locator(".receiver-status summary").first()).toContainText(
    "Not connected",
  );
});

test("replay shows capture RF limits, readable time precision and replay status", async ({
  page,
}) => {
  const fixture = targetRecordingFixture("ADS-B");
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("replay");
  await expect(page.locator("#frequency-help")).toContainText(
    "Load a recording",
  );
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
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
  await expect(page.locator("#frequency-help")).toContainText(
    "Recorded RF: 1088.800–1091.200 MHz",
  );
  const end = await page
    .getByLabel("Replay end seconds", { exact: true })
    .inputValue();
  expect(end).toMatch(/^\d+(?:\.\d{1,6})?$/);
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await expect(page.locator(".receiver-status summary").first()).toContainText(
    "Replaying",
  );
});
