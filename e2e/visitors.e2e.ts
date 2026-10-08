import { openApplicationView } from "./application-navigation";
import { expect, test } from "@playwright/test";

test("About shows the optional visitor count quietly", async ({ page }) => {
  let reads = 0;
  await page.route("**/visitor-count.json", async (route) => {
    reads++;
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      json: {
        schemaVersion: 1,
        available: true,
        visitors: 71,
        updatedAt: "2026-10-05T19:30:23Z",
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".receiver-status-menu > summary")).toBeVisible();
  expect(reads).toBe(0);
  await openApplicationView(page, "About");
  await expect(page.locator(".about-visitors")).toHaveText(
    "71 visitors since launch",
  );
  await expect(page.locator(".about-visitors")).not.toHaveAttribute("title");
  await expect(page.locator("#about-privacy")).toContainText(
    "Only the total is published",
  );
});

for (const fixture of [
  { name: "unconfigured", value: { schemaVersion: 1, available: false } },
  {
    name: "invalid",
    value: {
      schemaVersion: 1,
      available: true,
      visitors: -1,
      updatedAt: "invalid",
    },
  },
  { name: "offline", value: null },
]) {
  test(`About remains usable when visitor statistics are ${fixture.name}`, async ({
    page,
  }) => {
    await page.route("**/visitor-count.json", async (route) => {
      if (fixture.value === null) await route.abort();
      else await route.fulfill({ json: fixture.value });
    });
    await page.goto("/");
    await openApplicationView(page, "About");
    await expect(
      page.getByRole("heading", { name: "Licences, privacy & provenance" }),
    ).toBeVisible();
    await expect(page.locator(".about-visitors")).toHaveCount(0);
  });
}

test("About displays a measured zero visitor count", async ({ page }) => {
  await page.route("**/visitor-count.json", async (route) => {
    await route.fulfill({
      json: {
        schemaVersion: 1,
        available: true,
        visitors: 0,
        updatedAt: "2026-10-05T19:30:23Z",
      },
    });
  });
  await page.goto("/");
  await openApplicationView(page, "About");
  await expect(page.locator(".about-visitors")).toHaveText(
    "0 visitors since launch",
  );
});
