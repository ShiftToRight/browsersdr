import type { Page } from "@playwright/test";
import { MODE_DESCRIPTIONS } from "../src/ui/modeCatalog";
import type { ReceiverMode } from "../src/radio/receiverConfig";

/** Exercise specialist selection through the same chooser as the user. */
export async function chooseReceiverMode(page: Page, mode: ReceiverMode) {
  const quick = page.getByRole("combobox", { name: "Mode", exact: true });
  if (await quick.locator(`option[value="${mode}"]`).count()) {
    await quick.selectOption(mode);
  } else {
    await page
      .getByRole("button", { name: "More modes…", exact: true })
      .click();
    const chooser = page.getByRole("dialog", { name: "Choose a decoder" });
    await chooser
      .getByRole("button", {
        name: `Select ${MODE_DESCRIPTIONS[mode].label}`,
        exact: true,
      })
      .click();
    await chooser
      .getByRole("button", { name: "Use mode", exact: true })
      .click();
    await chooser.waitFor({ state: "hidden" });
  }
}

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
