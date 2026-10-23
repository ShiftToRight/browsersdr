import { expect, test, type Page } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

test("monitor settings need one disclosure and desktop history fills the viewport at different heights", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1686, height: 1200 });
  await monitorHistory(page);
  const setup = page.getByRole("complementary", {
    name: "Monitor setup",
    exact: true,
  });
  await setup.getByText("Site & profile settings", { exact: true }).click();
  await expect(setup.getByLabel("Profile name", { exact: true })).toBeVisible();
  await expect(setup.getByLabel("Site label", { exact: true })).toBeVisible();
  await expect(setup.getByText("Site & profile", { exact: true })).toHaveCount(
    0,
  );
  await page.locator(".monitor-frequency").first().click();
  for (const height of [903, 1440, 2000]) {
    await page.setViewportSize({ width: 1686, height });
    const results = await page.locator(".studio-results-main").boundingBox();
    const inspector = await page.locator(".monitor-inspector").boundingBox();
    expect(Math.abs(results!.y + results!.height - (height - 16))).toBeLessThan(
      4,
    );
    expect(
      Math.abs(
        inspector!.y + inspector!.height - (results!.y + results!.height),
      ),
    ).toBeLessThan(2);
    const history = await page.locator(".monitor-results-scroll").boundingBox();
    expect(history!.y + history!.height).toBeLessThan(
      results!.y + results!.height,
    );
    if (height === 2000) expect(history!.height).toBeGreaterThan(1100);
  }
  await page.screenshot({
    path: info.outputPath("explorer-viewport-fill.png"),
  });
});

async function monitor(page: Page) {
  await page.goto("/?browser-test=1");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page
    .getByLabel("Explorer activity", { exact: true })
    .selectOption("monitor");
}

test("complete named setups restore range, preset, custom detection and analysis choices without starting acquisition", async ({
  page,
}) => {
  await monitor(page);
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await page.getByLabel("Range start", { exact: true }).fill("84 MHz");
  await page.getByLabel("Range end", { exact: true }).fill("108 MHz");
  await page
    .getByLabel("Detection preset", { exact: true })
    .selectOption("narrow");
  await page.getByLabel("Dwell milliseconds", { exact: true }).fill("750");
  await page.getByLabel("Threshold decibels", { exact: true }).fill("9");
  await page
    .getByLabel("Analyze signals after 3 sweeps", { exact: true })
    .check();
  await page.getByText("Saved scan setups", { exact: true }).click();
  await page.getByLabel("Setup name", { exact: true }).fill("Local FM");
  await page
    .getByRole("button", { name: "Save complete setup", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved “Local FM”" }),
  ).toBeVisible();
  await page.getByLabel("Range start", { exact: true }).fill("90 MHz");
  await page
    .getByLabel("Detection preset", { exact: true })
    .selectOption("bursts");
  await page
    .getByLabel("Analyze signals after 3 sweeps", { exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Load setup", exact: true }).click();
  await expect(page.getByLabel("Range start", { exact: true })).toHaveValue(
    "84 MHz",
  );
  await expect(page.getByLabel("Range end", { exact: true })).toHaveValue(
    "108 MHz",
  );
  await expect(
    page.getByLabel("Detection preset", { exact: true }),
  ).toHaveValue("narrow");
  await expect(
    page.getByLabel("Dwell milliseconds", { exact: true }),
  ).toHaveValue("750");
  await expect(
    page.getByLabel("Threshold decibels", { exact: true }),
  ).toHaveValue("9");
  await expect(
    page.getByLabel("Analyze signals after 3 sweeps", { exact: true }),
  ).toBeChecked();
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Range start", { exact: true })).toHaveValue(
    "84 MHz",
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Saved setup", { exact: true })).toContainText(
    "Local FM",
  );
});

test("field validation keeps unfinished drafts and reports storage failures with a working retry", async ({
  page,
}) => {
  await monitor(page);
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await page.getByLabel("Range start", { exact: true }).fill("unfinished MHz");
  await expect(page.getByLabel("Range start", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter a frequency" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const previous = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "browsersdr.customMonitorDraft.v1")
        throw new DOMException("Quota exceeded");
      return previous.call(this, key, value);
    };
    (window as unknown as { restoreStorage: () => void }).restoreStorage =
      () => {
        Storage.prototype.setItem = previous;
      };
  });
  await page.getByLabel("Range start", { exact: true }).fill("84 MHz");
  await expect(
    page.getByRole("button", { name: "Retry saving", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { restoreStorage: () => void }).restoreStorage(),
  );
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(page.getByText(/Settings saved locally/)).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Range start", { exact: true })).toHaveValue(
    "84 MHz",
  );
});

test("presentation, zoom, full view and history tools preserve plot geometry and acquisition stays stopped", async ({
  page,
}) => {
  await monitorHistory(page);
  await expect(page.locator(".monitor-draft-notice > strong")).toHaveText(
    "Retained setup",
  );
  const plot = page.locator(".monitor-spectrum-plot > svg");
  const before = await plot.boundingBox();
  await page.getByText("History & tools", { exact: true }).click();
  const after = await plot.boundingBox();
  expect(after).toEqual(before);
  expect(
    await plot.evaluate((el) => getComputedStyle(el.parentElement!).paddingTop),
  ).toBe("0px");
  await page
    .getByLabel("Show signals", { exact: true })
    .selectOption("history");
  await page.getByLabel("Sort signals", { exact: true }).selectOption("level");
  await page.locator(".monitor-frequency").first().click();
  await page
    .getByRole("button", { name: "Zoom selected", exact: true })
    .click();
  const markers = page.getByTestId("monitor-detection-marker");
  expect(await markers.count()).toBeLessThan(16);
  await page.getByText("Display", { exact: true }).click();
  await page
    .getByRole("slider", { name: "Spectrum height", exact: true })
    .fill("320");
  await expect.poll(async () => (await plot.boundingBox())!.height).toBe(320);
  await page
    .getByRole("button", { name: "Full spectrum view", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Band spectrum overview", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Full spectrum view", exact: true }),
  ).toBeFocused();
  await page.getByRole("tab", { name: /^Targets/ }).click();
  await expect(
    page.getByRole("complementary", {
      name: "Selected signal details",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Show signals", { exact: true })).toHaveValue(
    "history",
  );
  await expect(page.getByLabel("Sort signals", { exact: true })).toHaveValue(
    "level",
  );
  await expect(
    page.getByRole("slider", { name: "Spectrum height", exact: true }),
  ).toHaveValue("320");
  await expect(page.getByRole("tab", { name: /^Targets/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".monitor-tools")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});

for (const theme of ["classic", "field-deck", "vice-afterglow"]) {
  for (const width of [390, 768, 1440, 2868]) {
    test(`Explorer theme ${theme} stays aligned and bounded at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await monitorHistory(page);
      await page.getByLabel("Settings", { exact: true }).click();
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await page.getByLabel("Theme", { exact: true }).press("Escape");
      const rail = page.locator(".monitor-setup-rail");
      const corners = await rail.evaluate((el) => {
        const s = getComputedStyle(el);
        return [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomLeftRadius,
          s.borderBottomRightRadius,
        ];
      });
      expect(new Set(corners)).toEqual(new Set(["6px"]));
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const box = await page
        .locator(".monitor-spectrum-plot > svg")
        .boundingBox();
      expect(box!.height).toBeLessThanOrEqual(350);
      if (width >= 1440) expect(box!.y + box!.height).toBeLessThan(650);
      const marker = page.getByRole("button", {
        name: /^Select detection at 914\.750000 MHz/,
      });
      if (width >= 1440) {
        const expected = await page
          .locator(".monitor-spectrum-plot > svg")
          .evaluate(
            (el) =>
              new DOMPoint(52 + (0.05 / 0.6) * 1128, 18).matrixTransform(
                (el as SVGSVGElement).getScreenCTM()!,
              ).x,
          );
        await expect
          .poll(async () => {
            const b = await marker.boundingBox();
            return Math.abs(b!.x + b!.width / 2 - expected);
          })
          .toBeLessThan(1);
      }
      if (width <= 850) {
        const setupBox = await rail.boundingBox();
        expect(box!.y + box!.height).toBeLessThan(setupBox!.y);
        expect(
          await rail.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
        ).toBe(true);
        await expect
          .poll(async () =>
            page
              .locator(".monitor-spectrum-plot > svg text")
              .evaluateAll((nodes) => {
                const labels = nodes
                  .filter((node) => node.textContent?.includes("MHz"))
                  .map((node) => node.getBoundingClientRect());
                return labels.every(
                  (box, i) => !i || labels[i - 1]!.right <= box.left,
                );
              }),
          )
          .toBe(true);
      }
      const axisBounds = await page
        .locator(".monitor-spectrum-unit")
        .evaluate((node) => ({
          label: node.getBoundingClientRect().top,
          plot: node.closest("svg")!.getBoundingClientRect().top,
        }));
      expect(axisBounds.label).toBeGreaterThanOrEqual(axisBounds.plot - 1);
      const markerColors = await page
        .getByTestId("monitor-detection-marker")
        .evaluateAll((nodes) =>
          nodes.map((node) => getComputedStyle(node).backgroundColor),
        );
      expect(
        markerColors.every(
          (color) => color === "transparent" || color === "rgba(0, 0, 0, 0)",
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`${theme}-${width}.png`),
        fullPage: true,
      });
    });
  }
}

test("restoring the active setup restores targets and every detection setting together and hover uses retained measurements", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page
    .getByLabel("Explorer activity", { exact: true })
    .selectOption("monitor");
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await page.getByLabel("Range start", { exact: true }).fill("99.2 MHz");
  await page.getByLabel("Range end", { exact: true }).fill("100.6 MHz");
  await page
    .getByLabel("Detection preset", { exact: true })
    .selectOption("narrow");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  const svg = page.locator(".monitor-spectrum-plot > svg");
  const box = await svg.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator(".monitor-plot-hover")).toContainText("dB rel.");
  await page.getByLabel("Range start", { exact: true }).fill("99.3 MHz");
  await page
    .getByLabel("Detection preset", { exact: true })
    .selectOption("bursts");
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Restore active settings", exact: true })
    .click();
  await expect(page.getByLabel("Range start", { exact: true })).toHaveValue(
    "99200000 Hz",
  );
  await expect(
    page.getByLabel("Detection preset", { exact: true }),
  ).toHaveValue("narrow");
  await expect(
    page.getByLabel("Dwell milliseconds", { exact: true }),
  ).toHaveValue("500");
  await expect(
    page.getByLabel("Threshold decibels", { exact: true }),
  ).toHaveValue("10");
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});

test("named frequency setups preserve editable rows and labels", async ({
  page,
}) => {
  await monitor(page);
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("frequencies");
  await page.getByLabel("Frequency", { exact: true }).fill("99.7 MHz");
  await page.getByLabel("Watch width", { exact: true }).fill("200 kHz");
  await page
    .getByLabel("Label (optional)", { exact: true })
    .fill("Local watch");
  await page
    .getByRole("button", { name: "Add frequency", exact: true })
    .click();
  await page.getByText("Saved scan setups", { exact: true }).click();
  await page.getByLabel("Setup name", { exact: true }).fill("Channels");
  await page
    .getByRole("button", { name: "Save complete setup", exact: true })
    .click();
  await page.getByLabel("Frequency 1", { exact: true }).fill("101 MHz");
  await page.getByRole("button", { name: "Load setup", exact: true }).click();
  await expect(page.getByLabel("Frequency 1", { exact: true })).toHaveValue(
    "99700000 Hz",
  );
  await expect(page.getByLabel("Label 1", { exact: true })).toHaveValue(
    "Local watch",
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});
