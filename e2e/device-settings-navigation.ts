import type { Page } from "@playwright/test";

/** Use the device popup through its visible controls, including exit motion. */
export async function openDeviceSettings(page: Page) {
  const trigger = page.locator(".device-settings-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await page
    .getByRole("dialog", { name: "Device details & settings", exact: true })
    .waitFor({ state: "visible" });
}

export async function closeDeviceSettings(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Device details & settings",
    exact: true,
  });
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
}
