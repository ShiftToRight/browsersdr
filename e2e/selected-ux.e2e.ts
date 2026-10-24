import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test } from "@playwright/test";
import { installHackrfUsb } from "./hackrf-usb-fixture";
import { chooseReceiverMode } from "./application-navigation";

test("HF Hz precision, signed fine offset and raw clipping warning survive the real HackRF pipeline with mocked USB", async ({
  page,
}, testInfo) => {
  await installHackrfUsb(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await chooseReceiverMode(page, "RTTY");
  await openDeviceSettings(page);
  await page
    .getByRole("combobox", { name: "Sample rate", exact: true })
    .selectOption("1024000");
  await closeDeviceSettings(page);
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("10.1008");
  await channel.blur();
  await expect(channel).toHaveValue("10.1008");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await openDeviceSettings(page);
  const lna = page.getByLabel("RX LNA state");
  expect(
    await lna.evaluate((node: HTMLSelectElement) => {
      const style = getComputedStyle(node);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = style.font;
      return (
        node.clientWidth -
        context.measureText(node.selectedOptions[0]!.text).width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      );
    }),
  ).toBeGreaterThan(20);
  await closeDeviceSettings(page);
  await expect(
    page.getByLabel("Receiver center frequency", { exact: true }),
  ).toHaveValue("10.1008");
  const offset = page.getByLabel("Text modem fine tuning offset", {
    exact: true,
  });
  await offset.fill("");
  await offset.pressSequentially("-200");
  await expect(offset).toHaveValue("-200");
  await offset.press("Enter");
  await expect(offset).toBeEnabled();
  await offset.blur();
  await expect(offset).toHaveValue("-200");
  await expect(channel).toHaveValue("10.1008");
  await expect(page.locator(".input-clipping-warning")).toHaveCount(0);
  await page.evaluate(() => {
    const device = (
      window as unknown as {
        __hackrf: { device: { deliver(bytes: Uint8Array): void } };
      }
    ).__hackrf.device;
    const deliver = device.deliver.bind(device);
    const saturated = new Uint8Array(65_536);
    for (let n = 0; n < saturated.length; n += 2) {
      saturated[n] = 127;
      saturated[n + 1] = 128;
    }
    let clipping = true;
    device.deliver = (bytes) => deliver(clipping ? saturated : bytes);
    (window as unknown as { __uxClearClipping(): void }).__uxClearClipping =
      () => {
        clipping = false;
      };
  });
  await expect(page.locator(".input-clipping-warning")).toContainText(
    "Input clipping detected",
  );
  await expect(page.locator(".input-clipping-warning")).toContainText(
    "Lower LNA/VGA gain",
  );
  await expect(offset).toHaveValue("-200");
  await page.screenshot({
    path: `.local/ux-selected-20261016/clipping-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.evaluate(() =>
    (window as unknown as { __uxClearClipping(): void }).__uxClearClipping(),
  );
  await expect(page.locator(".input-clipping-warning")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  await expect(offset).toHaveValue("-200");
  await page.reload();
  await expect(channel).toHaveValue("10.1008");
  await expect(offset).toHaveValue("-200");
});
