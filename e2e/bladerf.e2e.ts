import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function installBladeRfUsb(page: Page) {
  const fixtureSource = (
    await readFile("src/testing/bladerfUsbFixture.ts", "utf8")
  )
    .replace(
      /^import .*BLADERF_READ_BYTES.*\n/,
      "const BLADERF_READ_BYTES = 65_536;\n",
    )
    .replace(/^export /gm, "");
  const fixture = ts.transpileModule(fixtureSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  await page.addInitScript({
    content: `${fixture}\nwindow.__makeBladeRfUsb = () => new FakeBladeRfUsb();`,
  });
  await page.addInitScript(() => {
    const device = (
      window as unknown as {
        __makeBladeRfUsb(): {
          opened: boolean;
          fpgaConfigured: boolean;
          reads: unknown[];
          vendorRequests: number[];
          lifecycle: string[];
          deliverSamples(values: readonly number[]): void;
        };
      }
    ).__makeBladeRfUsb();
    device.fpgaConfigured = false;
    const state = { chooserCalls: 0, gesture: false, device };
    (window as unknown as { __bladerf: typeof state }).__bladerf = state;
    const usb = {
      requestDevice: () => {
        state.chooserCalls += 1;
        state.gesture = navigator.userActivation.isActive;
        return Promise.resolve(device);
      },
    };
    Object.defineProperty(navigator, "usb", { configurable: true, value: usb });
    (
      window as unknown as { __BROWSERSDR_TEST_CONFIG__: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      bladerfDependencies: { usb },
    };
    const samples = Array.from({ length: 32_768 }, (_, index) =>
      Math.round(1024 * Math.sin((2 * Math.PI * index) / 32)),
    );
    window.setInterval(() => {
      if (device.reads.length) device.deliverSamples(samples);
    }, 20);
  });
}

for (const rate of [9_600_000, 19_200_000])
  test(`bladeRF xA4 production path receives native-worker SC16 at ${rate / 1_000_000} MS/s without TX or recording`, async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installBladeRfUsb(page);
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption("bladerf");
    await expect(page.getByRole("note")).toContainText(
      "never writes SPI flash",
    );
    await page
      .getByRole("combobox", { name: "Mode", exact: true })
      .selectOption("AM");
    await page
      .getByLabel("Sample rate", { exact: false })
      .selectOption(String(rate));
    await page
      .getByRole("button", {
        name: "Connect & load FPGA if needed",
        exact: true,
      })
      .click();
    await expect(page.locator(".receiver-status")).toContainText("connected");
    await page
      .getByRole("button", { name: "Start receiving", exact: true })
      .click();
    await expect(page.locator(".receiver-status")).toContainText(
      `native ${rate.toLocaleString("en-US")} samples/s SC16 Q11`,
    );
    await expect(page.locator(".receiver-status")).toContainText("FPGA 0.15.3");
    await expect(page.locator(".receiver-status")).toContainText(
      "volatile hostedxA4 0.15.3",
    );
    await page.getByLabel("Channel frequency", { exact: false }).fill("101");
    await page.getByRole("button", { name: "Tune", exact: true }).click();
    await expect(page.locator(".receiver-status")).toContainText(
      "selected 101.000000 MHz",
    );
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    await expect(
      page.getByRole("button", { name: "Start I/Q recording" }),
    ).toBeDisabled();
    await expect(
      page.getByText(
        /Native SC16 Q11 recording and replay are intentionally deferred/,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Stop receiving", exact: true })
      .click();
    if (rate === 9_600_000) {
      const sampleRate = page.getByLabel("Sample rate", { exact: false });
      await expect(sampleRate).toBeEnabled();
      await sampleRate.selectOption("19200000");
      await page
        .getByRole("button", { name: "Start receiving", exact: true })
        .click();
      await expect(page.locator(".receiver-status")).toContainText(
        "native 19,200,000 samples/s SC16 Q11",
      );
      await page
        .getByRole("button", { name: "Stop receiving", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const state = await page.evaluate(() => {
      const current = (
        window as unknown as {
          __bladerf: {
            chooserCalls: number;
            gesture: boolean;
            device: {
              opened: boolean;
              reads: unknown[];
              vendorRequests: number[];
              lifecycle: string[];
            };
          };
        }
      ).__bladerf;
      return {
        chooserCalls: current.chooserCalls,
        gesture: current.gesture,
        opened: current.device.opened,
        reads: current.device.reads.length,
        vendorRequests: current.device.vendorRequests,
        lifecycle: current.device.lifecycle,
      };
    });
    expect(state.chooserCalls).toBe(1);
    expect(state.gesture).toBe(true);
    expect(state.opened).toBe(false);
    expect(state.reads).toBe(0);
    expect(state.vendorRequests).not.toContain(5);
    expect(state.lifecycle).toContain("fpga:begin");
    expect(state.lifecycle).toContain("fpga:write:2632660");
    const starts = state.lifecycle.filter((entry) => entry === "rx:on").length;
    const stops = state.lifecycle.filter((entry) => entry === "rx:off").length;
    expect(starts).toBe(rate === 9_600_000 ? 2 : 1);
    // Disconnect performs one final defensive RX-disable after an explicit stop.
    expect(stops).toBeGreaterThanOrEqual(starts);
    expect(errors).toEqual([]);
  });
