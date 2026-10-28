import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { unzipSync } from "fflate";

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const done = page.getByRole("button", { name: "Done", exact: true });
  if (await done.isVisible()) await done.click();
  await page.locator(".receiver-status-menu > summary").click();
  const details = await page.locator(".receiver-status-menu").innerText();
  console.log("Receiver failure details:", details);
  await info.attach("receiver-failure", {
    body: details,
    contentType: "text/plain",
  });
});

for (const mini of [false, true]) {
  test(`Airspy ${mini ? "Mini" : "R2"} actual workers, controls, capture, replay and restart`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = ts.transpileModule(
      (await readFile("src/testing/airspyUsbFixture.ts", "utf8")).replace(
        /^export /gm,
        "",
      ),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
        },
      },
    ).outputText;
    await page.addInitScript({
      content: `${fixture}\nconst device = new FakeAirspyUsb(); ${mini ? "device.rates = [6000000,3000000];" : ""} window.__airspy = device; Object.defineProperty(navigator, 'usb', {value: {requestDevice: async () => device, getDevices: async () => [], addEventListener() {}, removeEventListener() {}}});`,
    });
    await page.goto("/?browser-test=1");
    const source = page.getByRole("combobox", { name: "Signal source" });
    await source.selectOption("airspy");
    await openDeviceSettings(page);
    await expect(
      page.getByLabel("Bias tee · 4.5 V antenna power"),
    ).not.toBeChecked();
    await closeDeviceSettings(page);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start receiving", exact: true }),
    ).toBeEnabled();
    await openDeviceSettings(page);
    await expect(
      page.getByText(
        mini
          ? /Detected Airspy Mini rate profile/
          : /Detected Airspy R2 rate profile/,
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel("Sample rate", { exact: true }).locator("option"),
    ).toHaveCount(2);
    await page.getByLabel("Gain mode", { exact: true }).selectOption("manual");
    await page.getByLabel("LNA gain", { exact: true }).selectOption("14");
    await page.getByLabel("Mixer AGC", { exact: true }).check();
    await page.getByRole("button", { name: "Apply Airspy settings" }).click();
    await expect(page.getByLabel("Applied Airspy settings")).toContainText(
      "manual",
    );
    await closeDeviceSettings(page);
    await page
      .getByRole("button", { name: "Start receiving", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stop receiving", exact: true }),
    ).toBeEnabled();
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
    const sidecar = Object.entries(files).find(([name]) =>
      name.endsWith(".sigmf-meta"),
    )!;
    const binary = Object.entries(files).find(([name]) =>
      name.endsWith(".sigmf-data"),
    )!;
    const metadata = JSON.parse(new TextDecoder().decode(sidecar[1]));
    expect(metadata.global["core:datatype"]).toBe("ci16_le");
    expect(metadata.global["browsersdr:sample_format"].format).toBe(
      "browsersdr-airspy-ci16-v1",
    );
    expect(metadata.global["core:sample_rate"]).toBe(
      mini ? 3_000_000 : 2_500_000,
    );
    await page
      .getByRole("button", { name: "Discard prepared capture" })
      .click();
    await openDeviceSettings(page);
    await page
      .getByLabel("Sample rate", { exact: true })
      .selectOption(mini ? "6000000" : "10000000");
    await expect(page.getByLabel("Applied Airspy settings")).toContainText(
      mini ? "6.000 MS/s device" : "10.000 MS/s device",
    );
    await closeDeviceSettings(page);
    // Exercise sustained full-rate conversion, before optional decimation can
    // reduce the worker load. A one-second smoke missed the original failure.
    await page.waitForTimeout(15_000);
    const paced = await page.evaluate(() => {
      const device = (
        window as unknown as {
          __airspy: {
            deliveredComplex: number;
            startedAt: number;
            rate: number;
          };
        }
      ).__airspy;
      return (
        device.deliveredComplex /
        ((performance.now() - device.startedAt) / 1000) /
        device.rate
      );
    });
    expect(paced).toBeGreaterThan(0.95);
    await expect(
      page.getByRole("button", { name: "Stop receiving", exact: true }),
    ).toBeEnabled();
    await openDeviceSettings(page);
    await page.getByLabel("12-bit USB packing").check();
    await page
      .getByLabel("Conversion filter", { exact: true })
      .selectOption("sharp");
    await page.getByLabel("Decimation", { exact: true }).selectOption("2");
    await page.getByRole("button", { name: "Apply Airspy settings" }).click();
    await expect(page.getByLabel("Applied Airspy settings")).toContainText(
      "packing on",
    );
    await expect(page.getByLabel("Applied Airspy settings")).toContainText(
      "sharp filter",
    );
    await page
      .getByLabel("Sample rate", { exact: true })
      .selectOption(mini ? "6000000" : "10000000");
    await expect(page.getByLabel("Applied Airspy settings")).toContainText(
      mini ? "6.000 MS/s device" : "10.000 MS/s device",
    );
    await closeDeviceSettings(page);
    await expect(
      page.getByRole("button", { name: "Stop receiving", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Stop receiving", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start receiving", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stop receiving", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Stop receiving", exact: true })
      .click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await source.selectOption("replay");
    await page
      .getByLabel("Replay pair format", { exact: true })
      .selectOption("sigmf");
    await page.getByLabel("SigMF replay mode").selectOption("WBFM");
    await page.getByLabel("SigMF dataset").setInputFiles({
      name: binary[0],
      mimeType: "application/octet-stream",
      buffer: Buffer.from(binary[1]),
    });
    await page.getByLabel("SigMF metadata").setInputFiles({
      name: sidecar[0],
      mimeType: "application/json",
      buffer: Buffer.from(sidecar[1]),
    });
    await page
      .getByRole("button", { name: "Load SigMF pair", exact: true })
      .click();
    await expect(
      page.getByText(/^Loaded SigMF replay: [\d,]+ samples/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Start replay", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start replay", exact: true }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  });
}
