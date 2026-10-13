import type { Page } from "@playwright/test";

export async function openApplicationView(
  page: Page,
  view:
    | "Receiver"
    | "Decoder"
    | "Explorer"
    | "Settings"
    | "Diagnostics"
    | "Compatibility"
    | "Help"
    | "About",
) {
  const overlay = page.locator(".utility-overlay[open]");
  if (
    view === "Settings" ||
    view === "Help" ||
    view === "Compatibility" ||
    view === "About"
  ) {
    if (await overlay.isVisible()) {
      const label =
        view === "Settings"
          ? "Settings"
          : view === "Help"
            ? "Help & setup"
            : view === "Compatibility"
              ? "Compatibility & tests"
              : "About BrowserSDR";
      await overlay.getByRole("button", { name: label, exact: true }).click();
      return;
    }
  } else if (await overlay.isVisible()) {
    await overlay
      .getByRole("button", { name: "Close utility overlay", exact: true })
      .click();
  }
  if (view === "Receiver" || view === "Decoder" || view === "Explorer") {
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
        : view === "Compatibility"
          ? "Compatibility & tests"
          : "About BrowserSDR";
  await page.getByRole("button", { name: entry, exact: true }).click();
  await overlay.waitFor({ state: "visible" });
}
