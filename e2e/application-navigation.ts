import type { Page } from "@playwright/test";

export async function openApplicationView(
  page: Page,
  view: "Receiver" | "Explorer" | "Settings" | "Diagnostics" | "Help" | "About",
) {
  if (view === "Receiver" || view === "Explorer") {
    await page.getByRole("tab", { name: view, exact: true }).click();
    return;
  }
  if (view === "Diagnostics") {
    await page.locator(".receiver-status-menu > summary").click();
    await page
      .getByRole("button", { name: "Open diagnostics", exact: true })
      .click();
    return;
  }
  await page
    .getByLabel(view === "Settings" ? "Settings" : "Help", { exact: true })
    .click();
  const entry =
    view === "Settings"
      ? "Integration settings"
      : view === "Help"
        ? "Help & setup"
        : "About BrowserSDR";
  await page.getByRole("button", { name: entry, exact: true }).click();
}
