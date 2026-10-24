import type { Page } from "@playwright/test";

/** Exercise the display popup through visible controls and its native exit. */
export async function openDisplaySettings(page: Page) {
  const trigger = page.getByRole("button", {
    name: "Display settings",
    exact: true,
  });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await page
    .getByRole("dialog", { name: "Display settings", exact: true })
    .waitFor({ state: "visible" });
}

export async function closeDisplaySettings(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Display settings",
    exact: true,
  });
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
}
