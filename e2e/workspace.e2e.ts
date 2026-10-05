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
      ".graphics-panel",
      ".demodulate-stage",
      ".receiver-status-menu",
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

test("mobile follows the numbered acquire, analyze, demodulate and output order", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const panels = [
      ".acquire-stage",
      ".graphics-panel",
      ".demodulate-stage",
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
    "Start reception before recording",
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

test("receiver tools support arrow keys, Home and End even when collapsed", async ({
  page,
}) => {
  await page.goto("/");
  const audio = page.getByRole("tab", { name: "Audio & decode", exact: true });
  const capture = page.getByRole("tab", {
    name: "Capture & replay",
    exact: true,
  });
  const session = page.getByRole("tab", { name: "Session", exact: true });
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await audio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(capture).toBeFocused();
  await expect(capture).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#capture-panel")).toBeVisible();
  await page.keyboard.press("End");
  await expect(session).toBeFocused();
  await expect(page.locator("#session-panel")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(audio).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(session).toBeFocused();
  await expect(audio).toHaveAttribute("tabindex", "-1");
});

test("unavailable actions explain prerequisites and readiness reflects connection", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  const recording = page.getByRole("button", {
    name: "Start I/Q recording",
    exact: true,
  });
  await expect(recording).toBeDisabled();
  await recording.locator("..").focus();
  await expect(
    page.getByRole("tooltip", { name: "Start reception before recording." }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.locator(".explorer-heading .status-pill")).toHaveText(
    "Connect receiver",
  );
  await page
    .getByRole("button", { name: "Resume", exact: true })
    .locator("..")
    .focus();
  await expect(
    page.getByRole("tooltip", { name: "Pause a scan before resuming it." }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
  await expect(page.locator(".receiver-health")).toContainText(
    "Connect a receiver to record",
  );
  await page
    .getByRole("button", { name: "Create diagnostic report", exact: true })
    .click();
  const textarea = page.getByRole("dialog").locator("textarea").first();
  await expect(textarea).toBeVisible();
  expect(
    await textarea.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe("rgb(255, 255, 255)");
});

test("SRD choices are primary controls and hardware details have one home", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".demodulate-stage select").first().selectOption("SRD");
  await expect(page.locator(".mode-primary-controls")).toBeVisible();
  await expect(page.locator(".mode-primary-controls select")).toHaveCount(2);
  await expect(page.locator(".channel-advanced-settings")).not.toHaveAttribute(
    "open",
  );
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  await expect(page.locator(".receiver-status-menu")).not.toHaveAttribute(
    "open",
  );
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Session details", exact: true }),
  ).toBeVisible();
  await page.getByText("Hardware & signal details", { exact: true }).click();
  await expect(page.locator(".receiver-session-details p")).toBeVisible();
  await expect(page.locator(".receiver-session-details p")).toContainText(
    "Precise center",
  );
});

test("prerequisite hints stay inside the viewport and dismiss with Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByRole("tab", { name: "Open recording", exact: true }).click();
  await page
    .getByRole("button", { name: "Load files", exact: true })
    .locator("..")
    .focus();
  const hint = page.getByRole("tooltip", {
    name: "Choose both the I/Q data file and its metadata file.",
  });
  await expect(hint).toBeVisible();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const box = await hint.boundingBox();
        return Boolean(
          box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width &&
          box.y + box.height <= 900,
        );
      })
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(hint).not.toBeVisible();
});

test("all application views fit narrow screens without page-wide overflow", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of [
      "Receiver",
      "Explorer",
      "Diagnostics",
      "Help",
      "About",
    ]) {
      await page.getByRole("tab", { name: view, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
    }
  }
});
