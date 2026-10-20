import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SharedFrequencyGuide } from "../src/radio/sharedFrequencyGuides";
const profiles = JSON.parse(
  readFileSync(
    new URL("../src/radio/shared-frequency-guides.json", import.meta.url),
    "utf8",
  ),
) as SharedFrequencyGuide[];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function liveSnapshot(name = "Atlas live frequency example") {
  const rows = [
    {
      ...profiles[0]!,
      family: "new-atlas-family",
      name,
      aliases: ["liveexample"],
    },
  ];
  return {
    schema_version: "public-frequency-catalog-v1",
    revision: createHash("sha256").update(canonical(rows)).digest("hex"),
    published_at: "2026-10-20T12:00:00Z",
    profiles: rows,
  };
}
test("public frequency modes retain a verified live snapshot and make outages explicit", async ({
  page,
}) => {
  const snapshot = liveSnapshot();
  await page
    .context()
    .addCookies([
      { name: "personal", value: "invented-session", url: "http://127.0.0.1" },
    ]);

  let offline = false;
  const requests: Record<string, string>[] = [];
  await page.context().route("**/api/v2/public/frequencies", async (route) => {
    requests.push(await route.request().allHeaders());
    if (offline) return route.abort("internetdisconnected");
    return route.fulfill({
      json: snapshot,
      headers: { ETag: `"${snapshot.revision}"` },
    });
  });
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(
    dialog.getByRole("status").filter({ hasText: "Live Atlas public catalog" }),
  ).toBeVisible();
  await dialog.getByRole("searchbox").fill("liveexample");
  await expect(
    dialog.getByRole("article", { name: "Atlas live frequency example" }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.authorization).toBeUndefined();
  expect(requests[0]!.cookie).toBeUndefined();
  offline = true;
  await dialog
    .getByRole("button", { name: "Refresh frequency catalog" })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "using saved public catalog" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", { name: "Atlas live frequency example" }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Frequency catalog", exact: true })
    .selectOption("live");
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Live Atlas catalog unavailable" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", { name: "Atlas live frequency example" }),
  ).toHaveCount(0);
  await expect(dialog.getByText(/^No matching shared frequency/)).toHaveCount(
    0,
  );
  const before = requests.length;
  await dialog
    .getByRole("combobox", { name: "Frequency catalog", exact: true })
    .selectOption("saved");
  await expect(
    dialog.getByRole("status").filter({ hasText: "offline copy" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", { name: "Atlas live frequency example" }),
  ).toBeVisible();
  expect(requests).toHaveLength(before);
  await page.reload();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Frequency catalog", exact: true }),
  ).toHaveValue("saved");
  await dialog.getByRole("searchbox").fill("liveexample");
  await expect(
    dialog.getByRole("article", { name: "Atlas live frequency example" }),
  ).toBeVisible();
  expect(requests).toHaveLength(before);
});
test("public catalog refresh replaces publications and invalid payloads retain saved data", async ({
  page,
}) => {
  let snapshot = liveSnapshot("Atlas first publication");
  let malformed = false;
  await page.context().route("**/api/v2/public/frequencies", (route) =>
    route.fulfill({
      json: malformed ? { ...snapshot, profiles: [] } : snapshot,
    }),
  );
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(
    dialog.getByRole("status").filter({ hasText: "Live Atlas public catalog" }),
  ).toBeVisible();
  await dialog.getByRole("searchbox").fill("liveexample");
  await dialog
    .getByRole("article", { name: "Atlas first publication" })
    .getByRole("button", { name: /^Preview/ })
    .click();
  snapshot = liveSnapshot("Atlas newer publication");
  await dialog
    .getByRole("button", { name: "Refresh frequency catalog" })
    .click();
  await expect(
    dialog.getByRole("article", { name: "Atlas newer publication" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", { name: "Atlas first publication" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Apply to receiver" }),
  ).toHaveCount(0);
  malformed = true;
  await dialog
    .getByRole("button", { name: "Refresh frequency catalog" })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "using saved public catalog" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", { name: "Atlas newer publication" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});
test("multi-chunk publications become visible as one complete catalog", async ({
  page,
}) => {
  const rows = profiles.map((profile) => ({
    ...profile,
    notes: profile.notes + " Synthetic complete-publication update.",
  }));
  const snapshot = {
    schema_version: "public-frequency-catalog-v1",
    revision: createHash("sha256").update(canonical(rows)).digest("hex"),
    published_at: "2026-10-20T12:00:00Z",
    profiles: rows,
  };
  await page
    .context()
    .route("**/api/v2/public/frequencies", (route) =>
      route.fulfill({ json: snapshot }),
    );
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(
    dialog.getByRole("status").filter({ hasText: "Live Atlas public catalog" }),
  ).toBeVisible();
  for (const index of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    const profile = rows[index]!;
    await dialog
      .getByRole("searchbox")
      .fill(`${profile.frequencyHz / 1e6} MHz`);
    await expect(
      dialog.getByRole("article", { name: profile.name, exact: true }),
    ).toContainText("Synthetic complete-publication update.");
  }
  expect(
    await page.evaluate(async () => {
      const response = await (
        await caches.open("browsersdr-public-frequency-catalog-v1")
      ).match("/api/v2/public/frequencies");
      return (await response!.json()).snapshot.profiles.length;
    }),
  ).toBe(1359);
  await expect(
    page.getByRole("spinbutton", { name: "Channel frequency", exact: true }),
  ).toHaveValue("100.000");
});
