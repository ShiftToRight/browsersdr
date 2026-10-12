import { expect, test } from "@playwright/test";
import { createDeterministicRecordingFixture } from "../src/testing/recordingFixture";

test("Receiver volume has a stable accessible name, keyboard value and visible focus", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  const volume = page.getByRole("slider", { name: "Volume", exact: true });
  await expect(volume).toBeVisible();
  const value = Number(await volume.inputValue());
  await volume.focus();
  await volume.press("ArrowRight");
  await expect(volume).toHaveValue(String(Math.min(1, value + 0.01)));
  await expect(volume).toHaveAttribute(
    "aria-valuetext",
    `${Math.round(Math.min(1, value + 0.01) * 100)} percent`,
  );
  expect(await volume.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send("Accessibility.getFullAXTree");
  expect(
    tree.nodes.some(
      (n) => n.role?.value === "slider" && n.name?.value === "Volume",
    ),
  ).toBe(true);
});

test("phone controls precede the plot with enlarged text and search remains reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?browser-test=1");
  for (const scale of [100, 150]) {
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = `${value}%`;
    }, scale);
    const source = await page.locator(".acquire-stage").boundingBox();
    const tuning = await page.locator(".demodulate-stage").boundingBox();
    const plot = await page.locator(".graphics-panel").boundingBox();
    expect(source!.y).toBeLessThan(tuning!.y);
    expect(tuning!.y).toBeLessThan(plot!.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.getByRole("slider", { name: "Volume", exact: true }).focus();
    await expect(
      page.getByRole("slider", { name: "Volume", exact: true }),
    ).toBeInViewport();
  }
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Search stations & signals" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Search", exact: true }),
  ).toBeFocused();
});

test("stalled replay reads latch double Load, cancel promptly and ignore a source change", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("button", { name: "Open example recording" }).click();
  const fixture = createDeterministicRecordingFixture();
  await page
    .locator(".file-picker-input")
    .nth(0)
    .setInputFiles({
      name: "test.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
  await page
    .locator(".file-picker-input")
    .nth(1)
    .setInputFiles({
      name: "test.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.metadata)),
    });
  await page.evaluate(() => {
    File.prototype.text = () => new Promise(() => {});
  });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Checking recording…", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel replay import" }).click();
  await expect(
    page.getByRole("button", { name: "Load files", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Start replay", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("synthetic");
  await expect(
    page.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Cancel replay import" }),
  ).toHaveCount(0);
});

test("Explorer exposes storage failures and rejects malformed restored profiles", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("browsersdr-surveys", 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore("survey-runs", { keyPath: "key" });
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("survey-runs", "readwrite");
        tx.objectStore("survey-runs").put({
          version: 1,
          key: "latest",
          snapshot: { profile: { bands: [] } },
          windows: [],
          records: [],
          progress: {},
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.locator(".survey-storage-status")).toContainText(
    "Not saved",
  );
  await expect(
    page.getByRole("button", { name: "Export recovery JSON" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Scan current window" }),
  ).toBeVisible();
});

test("Explorer quota failure exposes an export of the final in-memory survey", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "survey-runs")
        throw new DOMException("Quota exhausted", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page
    .getByRole("button", { name: "Scan current window", exact: true })
    .click();
  await expect(
    page.locator(".explorer-results .diagnostic-message"),
  ).toContainText(/complete/);
  await expect(page.locator(".survey-storage-status")).toContainText(
    "Not saved: Quota exhausted",
  );
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export recovery JSON" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/recovery\.json$/);
  await expect(
    page.getByRole("button", { name: "Scan current window", exact: true }),
  ).toBeEnabled();
});
