import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test } from "@playwright/test";
import { installHackrfUsb } from "./hackrf-usb-fixture";

test("FM reception summary stays stable and clears on retune", async ({
  page,
}, testInfo) => {
  await installHackrfUsb(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await openDeviceSettings(page);
  await page
    .getByRole("combobox", { name: "Sample rate", exact: true })
    .selectOption("1024000");
  await closeDeviceSettings(page);
  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  const summary = page.locator('[aria-label="FM stereo reception"]');
  await expect(summary).toHaveText(
    "FM stereo reception: Mono · no stable stereo pilot",
  );
  const labels = await summary.evaluate(async (element) => {
    const labels: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 2200) {
      labels.push(element.textContent!.trim());
      await new Promise((r) => setTimeout(r, 50));
    }
    return [...new Set(labels)];
  });
  expect(labels).toEqual([
    "FM stereo reception: Mono · no stable stereo pilot",
  ]);
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(page.locator(".collapsed-metadata")).toContainText(
    "FM stereo reception: Mono · no stable stereo pilot",
  );
  await page.screenshot({ path: testInfo.outputPath("stable-fm-status.png") });
  await page.getByLabel("Channel frequency", { exact: true }).fill("100.1");
  await page.getByRole("button", { name: "Tune", exact: true }).click();
  await expect(page.locator(".collapsed-metadata")).toContainText(
    "Checking stereo pilot",
  );
  await expect(page.locator(".collapsed-metadata")).toContainText(
    "Mono · no stable stereo pilot",
  );
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  await expect(page.locator(".collapsed-metadata")).toContainText(
    "Not receiving",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});
