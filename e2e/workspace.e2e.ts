import { expect, test } from "@playwright/test";

test("desktop receiver fills the window with all primary panels in view", async ({
  page,
}) => {
  await page.goto("/");
  for (const viewport of [
    { width: 1181, height: 900 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })),
      )
      .toEqual(viewport);
    const shell = (await page.locator(".app-shell").boundingBox())!;
    expect(shell.width).toBe(viewport.width - 24);
    for (const selector of [
      ".app-topbar",
      ".acquire-stage",
      ".demodulate-stage",
      ".graphics-panel",
      ".receiver-status",
      ".receiver-dock",
    ]) {
      const panel = page.locator(selector);
      const box = (await panel.boundingBox())!;
      expect(box.y, selector).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, selector).toBeLessThanOrEqual(viewport.height);
      expect(
        await panel.evaluate(
          (element) => element.scrollHeight <= element.clientHeight + 1,
        ),
        selector,
      ).toBe(true);
    }
  }
  const plot = page.locator(".graphics-panel canvas");
  const large = (await plot.boundingBox())!;
  await page.setViewportSize({ width: 1920, height: 1080 });
  const smaller = (await plot.boundingBox())!;
  expect(large.width).toBeGreaterThan(smaller.width);
  expect(large.height).toBeGreaterThan(smaller.height);
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  expect((await plot.boundingBox())!.height).toBeGreaterThan(smaller.height);
});

test("desktop keeps expanded tools reachable and other views in document flow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  const record = page.getByRole("button", { name: "Start I/Q recording" });
  await record.scrollIntoViewIfNeeded();
  await expect(record).toBeInViewport();
  await page.locator(".display-settings > summary").click();
  await page.locator(".spectrum-details > summary").click();
  const details = page.locator(".spectrum-details .display-note").last();
  await details.scrollIntoViewIfNeeded();
  await expect(details).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    900,
  );
  await page.getByRole("tab", { name: "Help", exact: true }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(
    /receiver-workspace/,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeGreaterThan(900);
  await page.getByRole("tab", { name: "Receiver", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/receiver-workspace/);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    900,
  );
});

test("short windows retain scrolling and the full available width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 768 });
  await page.goto("/");
  expect((await page.locator(".app-shell").boundingBox())!.width).toBe(1896);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeGreaterThan(768);
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  const record = page.getByRole("button", { name: "Start I/Q recording" });
  await record.scrollIntoViewIfNeeded();
  await expect(record).toBeInViewport();
});

test("mobile follows acquisition, channel settings, spectrum and output order", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const panels = [
      ".acquire-stage",
      ".demodulate-stage",
      ".graphics-panel",
      ".receiver-status",
      ".receiver-dock",
    ];
    const tops: number[] = [];
    for (const selector of panels) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      tops.push(box!.y);
    }
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const toolbar = page.locator(".spectrum-toolbar");
    const pause = toolbar.getByRole("button", { name: "Pause display" });
    await expect(
      toolbar.getByRole("button", { name: "Auto scale", exact: true }),
    ).toBeVisible();
    const outer = (await toolbar.locator(".spectrum-actions").boundingBox())!;
    const inner = (await pause.boundingBox())!;
    expect(
      Math.abs(
        inner.y - outer.y - (outer.y + outer.height - inner.y - inner.height),
      ),
    ).toBeLessThanOrEqual(1);
    await expect(page.locator(".display-settings")).not.toHaveAttribute("open");
  }
});

test("recording tabs support keyboard navigation and keep replay separate", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  const record = page.getByRole("tab", { name: "Record", exact: true });
  const open = page.getByRole("tab", { name: "Open recording", exact: true });
  await expect(record).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".recording-state")).toContainText(
    "Ready to record",
  );
  await expect(
    page.getByRole("button", { name: "Download ZIP" }),
  ).not.toBeVisible();
  await record.focus();
  await page.keyboard.press("ArrowRight");
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Open example recording" }),
  ).toBeVisible();
  await page.keyboard.press("Home");
  await expect(record).toBeFocused();
  await expect(page.locator("#record-panel")).toBeVisible();
});
