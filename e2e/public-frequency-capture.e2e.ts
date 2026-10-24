import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { installHackrfUsb } from "./hackrf-usb-fixture";
import { chooseReceiverMode } from "./application-navigation";
const allProfiles = JSON.parse(
  readFileSync(
    new URL("../src/radio/shared-frequency-guides.json", import.meta.url),
    "utf8",
  ),
);
const metadata = JSON.parse(
  readFileSync(
    new URL("../src/radio/shared-frequency-snapshot.json", import.meta.url),
    "utf8",
  ),
);
const test = base.extend<object, { isolatedCatalogThroughputWorker: boolean }>({
  isolatedCatalogThroughputWorker: [true, { scope: "worker", auto: true }],
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page
      .getByLabel(/^Receiver status:/)
      .click({ timeout: 1000 })
      .catch(() => {});
    await info.attach("receiver-failure-context", {
      body: await page.locator("body").innerText(),
      contentType: "text/plain",
    });
  }
});

test("19.2 MS/s capture preserves five seconds while a complete live frequency catalog is validated and saved", async ({
  page,
}, testInfo) => {
  // Also exercise the transfer of a changed publication from the worker to the UI.
  const updated = allProfiles.map(
    (profile: Record<string, unknown>, index: number) =>
      index === 0
        ? {
            ...profile,
            notes: `${profile.notes} Synthetic public update for this capture check.`,
          }
        : profile,
  );
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`
        : JSON.stringify(value);
  const snapshot = {
    ...metadata,
    revision: createHash("sha256").update(canonical(updated)).digest("hex"),
    profiles: updated,
  };
  await page
    .context()
    .route("**/api/v2/public/frequencies", (route) =>
      route.fulfill({ json: snapshot }),
    );
  await installHackrfUsb(page, false, false, 19_200_000);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await chooseReceiverMode(page, "DAB");
  if (testInfo.project.name === "chromium-dev") {
    // Compile Vite's lazy Search modules before measuring RF throughput.
    // Built/stamped projects still exercise the first Search open during capture.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("searchbox", {
        name: "Search text, frequency or DAB block",
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Search", exact: true })
      .first()
      .click();
  }
  await openDeviceSettings(page);
  await page
    .getByRole("combobox", { name: "Sample rate", exact: true })
    .selectOption("19200000");
  await closeDeviceSettings(page);
  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByLabel("Capture current channel only").check();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page.getByLabel("Timed capture seconds").fill("5");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  // Open Search during actual capture, after asynchronous storage preparation
  // has committed its controls, rather than clicking through that transition.
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search text, frequency or DAB block" })
    .fill("5C");
  await expect(
    page.getByRole("status").filter({ hasText: "Live Atlas public catalog" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Close Search", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Download ZIP", exact: true }),
  ).toBeEnabled({ timeout: 12000 });
  expect(
    await page.evaluate(async () => {
      const response = await (
        await caches.open("browsersdr-public-frequency-catalog-v1")
      ).match("/api/v2/public/frequencies");
      return (await response!.json()).snapshot.profiles.length;
    }),
  ).toBe(1359);
  await expect(page.locator(".recording-state")).not.toContainText(
    "stopped early",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const zip = unzipSync(await readFile((await (await pending).path())!));
  const meta = JSON.parse(
    new TextDecoder().decode(
      Object.entries(zip).find(([name]) => name.endsWith(".sigmf-meta"))![1],
    ),
  );
  const data = Object.entries(zip).find(([name]) =>
    name.endsWith(".sigmf-data"),
  )![1];
  await testInfo.attach("channel-capture-metadata", {
    body: JSON.stringify(meta, null, 2),
    contentType: "application/json",
  });
  expect(meta.global["core:sample_rate"]).toBe(2_400_000);
  expect(data.byteLength / 2 / 2_400_000).toBeGreaterThan(4.65);
  expect(data.byteLength / 2 / 2_400_000).toBeLessThan(5.3);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});
