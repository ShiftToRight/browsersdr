import { expect, test } from "@playwright/test";

test("Acquire keeps the compact hardware checklist usable across viewport sizes", async ({
  page,
}) => {
  await page.goto("/");
  const acquire = page.locator(".acquire-stage");
  for (const source of ["rtl-sdr", "hackrf", "bladerf", "usrp-b205"]) {
    await page
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption(source);
    await expect(acquire.locator(".advanced-settings")).not.toHaveAttribute(
      "open",
    );
    await expect(
      acquire.getByRole("button", { name: "Start receiving", exact: true }),
    ).toBeDisabled();
    await expect(
      acquire.getByRole("button", { name: "Connect", exact: true }),
    ).toBeVisible();
    if (source === "usrp-b205") {
      await expect(
        acquire.getByRole("button", { name: "Connect", exact: true }),
      ).toBeDisabled();
      await expect(acquire.locator('input[type="file"]')).toHaveCount(2);
    } else if (source === "bladerf") {
      await expect(
        acquire.getByRole("button", { name: "Connect", exact: true }),
      ).toBeEnabled();
      await expect(acquire.locator('input[type="file"]')).toHaveCount(1);
    } else {
      await expect(acquire.locator(".setup-checklist")).toHaveCount(0);
    }
    for (const width of [1440, 980, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await acquire.evaluate(
          (panel) => panel.scrollWidth <= panel.clientWidth + 1,
        ),
        `${source} fits at ${width}px`,
      ).toBe(true);
    }
  }
});
