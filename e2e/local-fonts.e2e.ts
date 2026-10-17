import { expect, test } from "@playwright/test";

test("real UI fonts load locally with external font services unavailable", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  const localFonts: string[] = [];
  await page.route(
    /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,
    (route) => {
      externalRequests.push(route.request().url());
      return route.abort();
    },
  );
  page.on("request", (request) => {
    if (request.resourceType() === "font") localFonts.push(request.url());
  });
  await page.goto("/");
  const loaded = await page.evaluate(async () => {
    const styles = [
      '400 16px "Manrope"',
      '500 16px "Manrope"',
      '600 16px "Manrope"',
      '700 16px "Manrope"',
      '400 16px "IBM Plex Mono"',
      '500 16px "IBM Plex Mono"',
    ];
    const faces = await Promise.all(
      styles.map((style) => document.fonts.load(style, "BrowserSDR ŽЙế")),
    );
    await document.fonts.ready;
    return faces.map(
      (group) =>
        group.length > 0 && group.every((face) => face.status === "loaded"),
    );
  });
  expect(loaded).toEqual([true, true, true, true, true, true]);
  expect(externalRequests).toEqual([]);
  expect(localFonts.length).toBeGreaterThan(0);
  expect(
    localFonts.every(
      (url) => new URL(url).origin === new URL(page.url()).origin,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("heading", { name: "BrowserSDR", exact: true }),
  ).toBeVisible();
});
