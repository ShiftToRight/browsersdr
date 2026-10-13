import { expect, test } from "@playwright/test";
import { openApplicationView } from "./application-navigation";

test("framed utilities retain workspace and settings drafts, contain focus and dismiss independently of nested reports", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await openApplicationView(page, "Decoder");
  await openApplicationView(page, "Settings");
  const overlay = page.locator(".utility-overlay");
  await expect(overlay).toHaveJSProperty("open", true);
  await expect(page.locator("#decoder-tab")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#decoder-view")).toBeVisible();
  const draft = overlay.getByLabel("Settings SigIntAtlas user token");
  await draft.fill("LOCAL-UNSAVED-DRAFT");
  await openApplicationView(page, "Help");
  await openApplicationView(page, "Settings");
  await expect(draft).toHaveValue("LOCAL-UNSAVED-DRAFT");
  const back = overlay.getByRole("button", {
    name: "Back to Decoder",
    exact: true,
  });
  const close = overlay.getByRole("button", {
    name: "Close utility overlay",
    exact: true,
  });
  await back.focus();
  await back.press("Tab");
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(back).toBeFocused();
  await openApplicationView(page, "Compatibility");
  await overlay
    .getByRole("button", { name: "Withdraw report", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Withdraw a report", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Withdraw a report", exact: true }),
  ).toHaveCount(0);
  await expect(overlay).toHaveJSProperty("open", true);
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(page.locator("#decoder-tab")).toBeFocused();
  await openApplicationView(page, "Help");
  const bounds = (await overlay.boundingBox())!;
  await page.mouse.move(bounds.x + 80, bounds.y + 35);
  await page.mouse.down();
  await page.mouse.move(2, Math.max(2, bounds.y - 4));
  await page.mouse.up();
  await expect(overlay).toBeVisible();
  await page.mouse.click(2, Math.max(2, bounds.y - 4));
  await expect(overlay).toBeHidden();
  await expect(page.locator("#decoder-tab")).toBeFocused();
});

test("opening Help preserves ongoing acquisition and sample capture", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByLabel("Timed capture seconds").fill("0");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await expect(page.locator(".receiver-status-menu > summary")).toContainText(
    "Recording",
  );
  const storedSamples = () =>
    page.locator(".recording-state span").textContent();
  const before = await storedSamples();
  await openApplicationView(page, "Help");
  await expect(page.locator("#receiver-tab")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".receiver-status-menu > summary")).toContainText(
    "Recording",
  );
  await expect.poll(storedSamples).not.toBe(before);
  await page
    .getByRole("button", { name: "Back to Receiver", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Ready to download",
  );
});

for (const width of [1440, 1024, 390, 320]) {
  test(`framed utility actions and internal scrolling fit ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await openApplicationView(page, "Help");
    const overlay = page.locator(".utility-overlay");
    {
      await page.setViewportSize({ width, height: 700 });
      for (const view of [
        "Help",
        "Settings",
        "Compatibility",
        "About",
      ] as const) {
        await openApplicationView(page, view);
        const bounds = (await overlay.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
        expect(
          await overlay.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await expect(
          overlay.getByRole("button", {
            name: "Close utility overlay",
            exact: true,
          }),
        ).toBeInViewport();
        await expect(
          overlay.getByRole("button", {
            name: "Back to Receiver",
            exact: true,
          }),
        ).toBeInViewport();
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApplicationView(page, "Help");
    await overlay.screenshot({ path: testInfo.outputPath("framed-help.png") });
  });
}
