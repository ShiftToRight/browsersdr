import { expect, test } from "@playwright/test";
import { openApplicationView } from "./application-navigation";

test("primary workspace keyboard navigation stays within Receiver, Decoder and Explorer", async ({
  page,
}) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "BrowserSDR views" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  const receiver = tabs.getByRole("tab", { name: "Receiver", exact: true });
  const explorer = tabs.getByRole("tab", { name: "Explorer", exact: true });
  const decoder = tabs.getByRole("tab", { name: "Decoder", exact: true });
  await receiver.focus();
  await receiver.press("ArrowRight");
  await expect(decoder).toBeFocused();
  await expect(decoder).toHaveAttribute("aria-selected", "true");
  await receiver.press("End");
  await expect(explorer).toBeFocused();
  await expect(explorer).toHaveAttribute("aria-selected", "true");
  await explorer.press("ArrowRight");
  await expect(receiver).toBeFocused();
  await receiver.press("ArrowLeft");
  await expect(explorer).toBeFocused();
  await explorer.press("Home");
  await expect(receiver).toBeFocused();
});

test("utility destinations return to the last workspace and preserve view preferences", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await openApplicationView(page, "Explorer");
  for (const [view, label] of [
    ["Settings", "Integration settings"],
    ["Help", "Help & setup"],
    ["Compatibility", "Compatibility & tests"],
    ["About", "About BrowserSDR"],
    ["Diagnostics", "Diagnostics"],
  ] as const) {
    await openApplicationView(page, view);
    await expect(
      page.getByRole("region", { name: label, exact: true }),
    ).toBeVisible();
    const back = page.getByRole("button", {
      name: "Back to Explorer",
      exact: true,
    });
    await expect(back).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Compact", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await back.click();
    await expect(
      page.getByRole("tab", { name: "Explorer", exact: true }),
    ).toBeFocused();
  }
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compact", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Compact", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Explorer", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("header utilities fit desktop and mobile, with dismissible menus and retained status", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse source panel", exact: true })
    .click();
  for (const width of [1686, 1366, 1024, 820, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    if (width >= 1024) {
      const controls = page.locator(
        '.app-topbar .view-tabs [role="tab"], .workspace-controls > button, .workspace-controls summary, .receiver-status-menu > summary',
      );
      const centers = await controls.evaluateAll((elements) =>
        elements.map((el) => {
          const box = el.getBoundingClientRect();
          return box.y + box.height / 2;
        }),
      );
      expect(centers).toHaveLength(7);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    }
    for (const name of ["Settings", "Help"] as const) {
      const trigger = page.getByLabel(name, { exact: true });
      const menu = page
        .locator(".header-utility-menu")
        .filter({ has: trigger });
      await trigger.click();
      const box = (await menu
        .locator(".header-utility-content")
        .boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expect
        .poll(() =>
          menu
            .locator(".header-utility-content button")
            .evaluateAll((buttons) =>
              buttons.every((button) => {
                const rect = button.getBoundingClientRect();
                return button.contains(
                  document.elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2,
                  ),
                );
              }),
            ),
        )
        .toBe(true);
      await trigger.press("Escape");
      await expect(menu).not.toHaveAttribute("open");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page
        .getByRole("heading", { name: "BrowserSDR", exact: true })
        .click();
      await expect(menu).not.toHaveAttribute("open");
    }
    await expect(page.locator(".receiver-status-menu > summary")).toBeVisible();
  }
});

test("touch utility targets stay at least 44 pixels and keyboard Tab dismisses a menu", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  for (const target of [
    page.getByRole("button", { name: "Compact", exact: true }),
    page.getByLabel("Settings", { exact: true }),
    page.getByLabel("Help", { exact: true }),
    page.locator(".receiver-status-menu > summary"),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const settings = page.getByLabel("Settings", { exact: true });
  await settings.click();
  await settings.press("Tab");
  const integration = page.getByRole("button", {
    name: "Integration settings",
    exact: true,
  });
  await expect(integration).toBeFocused();
  await integration.press("Tab");
  await page
    .getByRole("button", { name: "Reset view", exact: true })
    .press("Tab");
  await expect(page.getByLabel("Help", { exact: true })).toBeFocused();
  await expect(
    page.locator(".header-utility-menu").filter({ has: settings }),
  ).not.toHaveAttribute("open");
  await context.close();
});

test("Help is passive and Compatibility owns the only test report action", async ({
  page,
}, testInfo) => {
  await page.goto("/?browser-test=1");
  let reads = 0;
  await page.route("**/api/v1/compatibility-matrix**", (route) => {
    reads++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        builds: [],
        buildId: null,
        cells: [],
        engineChecks: [],
      }),
    });
  });
  await openApplicationView(page, "Help");
  const help = page.getByRole("region", { name: "Help & setup", exact: true });
  await expect(help.getByText("BrowserSDR field guide")).toHaveCount(0);
  await expect(
    help.getByRole("heading", { name: "Before connecting" }),
  ).toBeVisible();
  await expect(
    help.getByRole("heading", { name: "If it will not connect" }),
  ).toBeVisible();
  await expect(
    help.getByText("Frequently asked questions", { exact: true }),
  ).toBeVisible();
  await expect(
    help.getByRole("button", { name: "Report this test" }),
  ).toHaveCount(0);
  expect(reads).toBe(0);
  await openApplicationView(page, "Compatibility");
  const compatibility = page.getByRole("region", {
    name: "Compatibility & tests",
    exact: true,
  });
  await expect(
    compatibility.getByRole("button", {
      name: "Report this test",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    compatibility.getByRole("button", { name: "Share test result" }),
  ).toHaveCount(0);
  await expect(
    compatibility.getByRole("heading", { name: "Tested receiver setups" }),
  ).toBeVisible();
  const matrix = compatibility.getByRole("table", {
    name: "Community hardware and decoder matrix",
  });
  await expect(matrix.getByRole("rowheader", { name: /^RTL-SDR/ })).toHaveCount(
    1,
  );
  await expect(matrix.getByRole("rowheader", { name: /NESDR/ })).toHaveCount(0);
  await expect(
    matrix.locator('th[scope="row"] svg[aria-hidden="true"]'),
  ).toHaveCount(6);
  // Development StrictMode mounts, cleans up, and mounts the matrix again.
  expect(reads).toBe(testInfo.project.name === "chromium-dev" ? 2 : 1);
  await openApplicationView(page, "Help");
  await expect(help).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Report this test" }),
  ).toHaveCount(0);
});
