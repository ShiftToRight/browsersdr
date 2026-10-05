import { expect, test } from "@playwright/test";

const guides = [
  "/getting-started/",
  "/supported-devices/",
  "/guides/rtl-sdr/",
  "/guides/recording-and-replay/",
  "/about/",
];

test("SEO metadata leaves the receiver workspace at the root URL", async ({
  page,
}) => {
  await page.route("**/api/v1/diagnostic-reports", (route) => route.abort());
  await page.goto("/");
  await expect(page).toHaveTitle(
    "BrowserSDR — Software-Defined Radio in Your Browser",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://browsersdr.com/",
  );
  await expect(page.getByRole("tab", { name: /Receiver/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "BrowserSDR", exact: true }),
  ).toBeVisible();
});

test("all public guides work without JavaScript on desktop and mobile", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of guides) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator("article")).toBeVisible();
        await expect(page.locator("script")).toHaveCount(0);
        await expect(
          page.locator('nav a[aria-current="page"]'),
        ).toHaveAttribute("href", path);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          `https://browsersdr.com${path}`,
        );
        const hasPageOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(hasPageOverflow, `${path} at ${width}px`).toBe(false);
      }
    }
    await page
      .getByRole("link", { name: "Getting started", exact: true })
      .click();
    await expect(page).toHaveURL(`${baseURL}/getting-started/`);
    await page
      .getByRole("link", { name: "Supported devices", exact: true })
      .click();
    await expect(page).toHaveURL(`${baseURL}/supported-devices/`);
    await page
      .getByRole("link", { name: "Open receiver", exact: false })
      .first()
      .click();
    await expect(page).toHaveURL(`${baseURL}/`);
  } finally {
    await context.close();
  }
});

test("sitemap and robots publish the canonical public routes", async ({
  request,
}) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml.match(/<loc>/g)).toHaveLength(6);
  for (const path of ["/", ...guides]) {
    expect(xml).toContain(`<loc>https://browsersdr.com${path}</loc>`);
  }
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain(
    "Sitemap: https://browsersdr.com/sitemap.xml",
  );
});
