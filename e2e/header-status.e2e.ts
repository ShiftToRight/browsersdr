import { openApplicationView } from "./application-navigation";
import { expect, test } from "@playwright/test";

test("header keeps receiver, spectrum, and recording states independent across views", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.addInitScript(() =>
    Reflect.deleteProperty(Navigator.prototype, "gpu"),
  );
  await page.goto("/?browser-test=1");
  const status = page.locator(".app-topbar > .receiver-status");
  await expect(status.locator("summary").first()).toBeVisible();
  await expect(page.locator("#receiver-view .receiver-status")).toHaveCount(0);
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(status).toContainText("Synthetic RF demo running");
  await expect(page.locator(".operational-rail")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Auto scale", exact: true }),
  ).toBeEnabled();
  await expect(status.locator("summary").first()).toContainText("Receiving");
  await expect(status.locator("summary").first()).not.toContainText("issue");
  await status.locator("summary").first().click();
  await expect(
    status.getByRole("button", { name: /^Spectrum:/ }),
  ).toContainText("Working");
  await expect(status.getByRole("button", { name: /^Audio:/ })).toContainText(
    "Not used",
  );
  await status.getByRole("button", { name: /^Recording:/ }).click();
  const record = page.getByRole("button", {
    name: "Start I/Q recording",
    exact: true,
  });
  await expect(record).toBeVisible();
  await expect(record.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  await record.click();
  await expect(status.locator("summary").first()).toContainText("Recording");
  await status.locator("summary").first().click();
  await expect(
    status.getByRole("button", { name: /^Recording:/ }),
  ).toContainText("Recording: Recording");
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await status.locator("summary").first().click();
  await expect(
    status.getByRole("button", { name: /^Recording:/ }),
  ).toContainText("Ready to download");
  await status.getByRole("button", { name: /^Spectrum:/ }).click();
  await expect(
    page.getByRole("region", { name: "Diagnostics", exact: true }),
  ).toBeVisible();
  await expect(status.locator("summary").first()).toBeVisible();
  await expect(status).toContainText("Synthetic RF demo running");
  await expect(status).toContainText("Ready to download");
  expect(errors).toEqual([]);
});

test("quiet header keeps details hidden and its health panel usable at phone widths", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Reflect.deleteProperty(Navigator.prototype, "gpu"),
  );
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  const menu = page.locator(".receiver-status-menu");
  const summary = menu.locator("summary");
  const panel = menu.locator(".receiver-health-panel");
  await expect(summary).toContainText("Receiving");
  await expect(summary).not.toContainText(/MHz|WBFM|Audio:/);
  await expect(panel).toBeHidden();
  await expect(page.locator(".receiver-notice")).toHaveCount(0);
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    await summary.click();
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expect(
      panel.getByRole("button", { name: /^Receiver:/ }),
    ).toContainText("Receiving");
    await summary.press("Escape");
    await expect(panel).toBeHidden();
    await expect(summary).toBeFocused();
  }
  await summary.click();
  await page.getByRole("heading", { name: "BrowserSDR", exact: true }).click();
  await expect(panel).toBeHidden();
});

test("header recovery wraps on small screens and remains usable outside the receiver view", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "usb", { configurable: true, value: {} });
    (
      window as Window & { __BROWSERSDR_TEST_CONFIG__?: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      rtlDependencies: {
        createSourceProvider: () => ({
          get: async () => {
            throw new DOMException("Unable to claimInterface", "NetworkError");
          },
        }),
      },
    };
  });
  await page.goto("/?browser-test=1");
  const headerHeight = (await page.locator(".app-topbar").boundingBox())!
    .height;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect((await page.locator(".app-topbar").boundingBox())!.height).toBe(
    headerHeight,
  );
  const status = page.locator(".app-topbar > .receiver-status");
  await expect(status.locator(".receiver-notice")).toHaveAttribute(
    "role",
    "alert",
  );
  await expect(status).toContainText("system driver may be using it");
  await expect(status.locator(".receiver-notice")).toBeHidden();
  await openApplicationView(page, "Help");
  await status.locator(".receiver-status-menu > summary").click();
  await expect(status.locator(".receiver-notice")).toBeVisible();
  await expect(status.getByRole("button", { name: /^Receiver:/ })).toHaveClass(
    /needs-attention/,
  );
  expect(
    await status
      .getByRole("button", { name: /^Receiver:/ })
      .evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(
    await status
      .getByRole("button", { name: /^Audio:/ })
      .evaluate((element) => getComputedStyle(element).color),
  );
  await status.getByText("Show recovery steps", { exact: true }).click();
  await expect(status.getByLabel("Instructions for")).toBeVisible();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    expect(
      await status.locator(".receiver-status-message").evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.whiteSpace !== "nowrap" &&
          element.scrollWidth <= element.clientWidth
        );
      }),
    ).toBe(true);
    expect(
      await page.locator('.view-tabs [role="tab"]').evaluateAll((buttons) =>
        buttons.every((button) => {
          const label = button
            .querySelector(".icon-label")!
            .getBoundingClientRect();
          const target = button.getBoundingClientRect();
          return label.left >= target.left && label.right <= target.right;
        }),
      ),
    ).toBe(true);
  }
  await expect(
    status.getByRole("button", { name: "Retry connection", exact: true }),
  ).toBeVisible();
});
