import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test } from "@playwright/test";
import { installHackrfUsb } from "./hackrf-usb-fixture";
import { openApplicationView } from "./application-navigation";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

test("shared HackRF selector detects One, runs paced CI8, exports/replays and restarts", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installHackrfUsb(page, false, true);
  await page.goto("/?browser-test=1");
  const source = page.getByRole("combobox", { name: "Signal source" });
  await expect(source.locator('option[value="hackrf"]')).toHaveText(
    "HackRF One / Pro device",
  );
  await expect(source.locator('option[value="hackrf"]')).toHaveCount(1);
  await source.selectOption("hackrf");
  await page
    .getByRole("combobox", { name: "Mode", exact: true })
    .selectOption("AM");
  await openDeviceSettings(page);
  await expect(page.getByRole("combobox", { name: "Sample rate" })).toHaveValue(
    "9600000",
  );

  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openDeviceSettings(page);
  await expect(page.getByLabel("RX IF gain (dB)")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Sample rate" }).locator("option"),
  ).toHaveCount(1);
  await expect(
    page.getByText(/HackRF One · experimental, physical reception unverified/),
  ).toBeVisible();
  await page.getByLabel("RX IF gain (dB)").selectOption("40");
  await closeDeviceSettings(page);
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(page.locator(".receiver-session-details")).toContainText(
    "native 9,600,000 samples/s CI8",
  );
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByRole("button", { name: "Start I/Q recording" }).click();
  await expect(page.locator(".recording-state")).toContainText(
    /(?:[1-9]\d*\.\d{2}) \/ (?:32|2048) MiB/,
  );
  await page.getByRole("button", { name: "Stop recording" }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP" }).click();
  const download = await pending;
  const files = unzipSync(await readFile((await download.path())!));
  const sidecar = JSON.parse(
    new TextDecoder().decode(
      Object.entries(files).find(([name]) => name.endsWith(".json"))![1],
    ),
  );
  expect(sidecar).toMatchObject({
    hardware: {
      kind: "hackrf-one",
      protocolProfile: "hackrf-one-stable-2026-v1",
      standardImageIndex: null,
      formatEvidence: "firmware-standard-ci8",
    },
    nativeSampleRateHz: 9_600_000,
    effectiveSampleRateHz: 2_400_000,
    fpgaDecimationFactor: 1,
    captureSettings: { rxLnaGainCode: 40, appliedRateFixed36: null },
  });
  await page.getByRole("button", { name: "Discard prepared capture" }).click();
  await openApplicationView(page, "Compatibility");
  await page.getByRole("button", { name: "Report this test" }).click();
  await expect(
    page.getByRole("combobox", { name: /^Tested receiver/ }),
  ).toHaveValue("hackrf-one");
  await page
    .getByRole("button", { name: /Cancel|Close/, exact: true })
    .last()
    .click();
  await openApplicationView(page, "Receiver");
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(page.locator(".receiver-session-details")).toContainText(
    "native 9,600,000 samples/s CI8",
  );
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __hackrf: { device: { calls: { setup: { request: number } }[] } };
        }
      ).__hackrf.device.calls.some((c) =>
        [49, 50, 54, 59, 60].includes(c.setup.request),
      ),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  await source.selectOption("replay");
  const binary = Object.entries(files).find(([name]) => name.endsWith(".ci8"))!;
  const metadata = Object.entries(files).find(([name]) =>
    name.endsWith(".json"),
  )!;
  await page.getByLabel("BrowserSDR I/Q binary").setInputFiles({
    name: binary[0],
    mimeType: "application/octet-stream",
    buffer: Buffer.from(binary[1]),
  });
  await page.getByLabel("BrowserSDR JSON sidecar").setInputFiles({
    name: metadata[0],
    mimeType: "application/json",
    buffer: Buffer.from(metadata[1]),
  });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(page.getByText(/^Loaded [\d,]+ samples/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start replay", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await openApplicationView(page, "Diagnostics");
  await expect(
    page
      .locator(".diagnostics-grid > div")
      .filter({ has: page.locator("dt", { hasText: /^Complex samples$/ }) })
      .locator("dd"),
  ).toHaveText(sidecar.sampleCount.toLocaleString("en-US"));
  expect(errors).toEqual([]);
});
