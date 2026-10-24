import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { packetRecordingFixture } from "../src/testing/packetRecordingFixture";

async function installRtl(page: Page) {
  await page.addInitScript(() => {
    const state = {
      opens: 0,
      rates: [] as number[],
      reads: [] as number[],
      closes: 0,
    };
    (
      window as Window & { __rtlExperimentalState?: typeof state }
    ).__rtlExperimentalState = state;
    Object.defineProperty(navigator, "usb", { configurable: true, value: {} });
    let rate = 1_024_000,
      frequency = 100e6,
      nextAt = 0;
    (
      window as Window & { __BROWSERSDR_TEST_CONFIG__?: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      rtlDependencies: {
        createSourceProvider: (
          permission: () => void,
          capture: (data: ArrayBuffer) => void,
        ) => ({
          get: async () => {
            state.opens++;
            permission();
            return {
              setSampleRate: async (value: number) => {
                rate = value;
                state.rates.push(value);
                return value;
              },
              setCenterFrequency: async (value: number) => {
                frequency = value;
                return value;
              },
              setParameter: async <V>(_parameter: string, value: V) => value,
              startReceiving: async () => {
                nextAt = performance.now();
              },
              readSamples: (count: number) => {
                state.reads.push(count);
                if (state.reads.length > 64) state.reads.shift();
                const center = frequency;
                nextAt =
                  Math.max(nextAt, performance.now()) + (count / rate) * 1000;
                return new Promise((resolve) =>
                  setTimeout(
                    () => {
                      const bytes = new Uint8Array(count * 2).fill(128);
                      capture(bytes.buffer);
                      resolve({
                        I: new Float32Array(count).fill(0.00390625),
                        Q: new Float32Array(count).fill(0.00390625),
                        frequency: center,
                      });
                    },
                    Math.max(0, nextAt - performance.now()),
                  ),
                );
              },
              close: async () => {
                state.closes++;
              },
            };
          },
        }),
        createDemodulator: () => ({
          sharesWbfmMultiplex: true,
          setMode() {},
          setVolume() {},
          setSampleRate() {},
          setFrequencyOffset() {},
          expectFrequencyAndSetOffset() {},
          receiveSamples() {},
        }),
      },
    };
  });
}

test("RTL experimental rate persists, switches all rates on one USB owner and leaves other devices unchanged", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await installRtl(page);
  await page.goto("/?browser-test=1");
  await openDeviceSettings(page);
  const rate = page.getByLabel("Sample rate", { exact: true });
  await expect(rate).toHaveValue("1024000");
  await expect(rate.locator('option[value="3200000"]')).toHaveText(
    "3.200 MS/s (experimental)",
  );
  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await openDeviceSettings(page);
  for (const value of [
    "3200000",
    "2400000",
    "3200000",
    "1024000",
    "2400000",
    "1024000",
    "3200000",
  ]) {
    await rate.selectOption(value);
    await expect(rate).toBeEnabled();
    await expect(rate).toHaveValue(value);
    await expect(page.locator(".receiver-status")).toContainText(
      "Receiving WBFM",
    );
  }
  await expect(
    page.getByText(/Experimental 3.2 MS\/s: samples may be lost/).first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __rtlExperimentalState?: { reads: number[] } }
        ).__rtlExperimentalState?.reads.at(-1),
      ),
    )
    .toBe(160_256);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __rtlExperimentalState?: { opens: number } })
          .__rtlExperimentalState?.opens,
    ),
  ).toBe(1);
  await closeDeviceSettings(page);
  await expect(
    page.getByText(/Experimental 3.2 MS\/s: samples may be lost/).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.reload();
  await expect(
    page.getByText(/Experimental 3.2 MS\/s: samples may be lost/).first(),
  ).toBeVisible();
  await openDeviceSettings(page);
  await expect(rate).toHaveValue("3200000");
  await expect(
    page.getByText(/Experimental 3.2 MS\/s: samples may be lost/).first(),
  ).toBeVisible();
  await closeDeviceSettings(page);
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await expect(
    page.locator('select[aria-label="Sample rate"] option[value="3200000"]'),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a live rate change finalizes native experimental CU8 with its original rate and loss caveat", async ({
  page,
}) => {
  await installRtl(page);
  await page.goto("/?browser-test=1");
  await openDeviceSettings(page);
  await page.getByLabel("Sample rate", { exact: true }).selectOption("3200000");
  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByLabel("Recording export format").selectOption("browsersdr");
  await page.getByLabel("Capture current channel only").uncheck();
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".recording-state").textContent())?.match(
          /([0-9.]+) \/ (?:32|2048) MiB/,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await openDeviceSettings(page);
  await page.getByLabel("Sample rate", { exact: true }).selectOption("2400000");
  await closeDeviceSettings(page);
  await expect(page.locator(".recording-state")).toContainText(
    "Recording ready",
  );
  const downloads: import("@playwright/test").Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.getByText("More options", { exact: true }).click();
  await page
    .getByRole("button", { name: "Download separate files", exact: true })
    .click();
  await expect.poll(() => downloads.length).toBe(2);
  const meta = downloads.find((download) =>
    download.suggestedFilename().endsWith(".json"),
  )!;
  const data = downloads.find(
    (download) => !download.suggestedFilename().endsWith(".json"),
  )!;
  const metadata = JSON.parse(await readFile((await meta.path())!, "utf8"));
  const bytes = await readFile((await data.path())!);
  expect(metadata).toMatchObject({
    sampleRateHz: 3_200_000,
    format: "browsersdr-cu8-v1",
    stopReason: "metadata-change",
  });
  expect(metadata.provenance).toContain("Hardware sample loss is unobservable");
  expect(bytes.length).toBe(metadata.sampleCount * 2);
  expect(bytes.every((value) => value === 128)).toBe(true);
});

for (const mode of ["APRS", "RS41"] as const)
  test(`${mode} native 3.2 MS/s CU8 worker replay reaches EOF with expected data`, async ({
    page,
  }) => {
    const recording = packetRecordingFixture(mode, 3_200_000);
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption("replay");
    await page
      .getByRole("tab", { name: "Capture & replay", exact: true })
      .click();
    const inputs = page.locator(".file-picker-input");
    await inputs.nth(0).setInputFiles({
      name: "generated.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(recording.data),
    });
    await inputs.nth(1).setInputFiles({
      name: "generated.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(recording.metadata)),
    });
    await page.getByRole("button", { name: "Load files", exact: true }).click();
    await expect(page.locator(".file-message")).toContainText("Loaded");
    await page
      .getByRole("button", { name: "Start replay", exact: true })
      .click();
    await page
      .getByRole("tab", { name: "Audio & decode", exact: true })
      .click();
    await expect(page.locator(".packet-decode-panel table")).toContainText(
      mode === "APRS" ? "N0CALL-1" : "K1930293",
    );
    await page.locator(".receiver-status-menu > summary").click();
    await expect(
      page.getByText("Replay reached end of file. Final spectrum retained.", {
        exact: true,
      }),
    ).toBeVisible();
  });
