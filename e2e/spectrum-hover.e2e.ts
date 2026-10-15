import { expect, test, type Page } from "@playwright/test";

async function start(page: Page) {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByText("Display settings", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Display renderer", exact: true })
    .selectOption("canvas2d");
  await expect(page.locator(".band-guide-strip")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause display", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Pause display", exact: true })
    .click();
}

test("hover inspects the frozen trace without tuning and waterfall names latest levels", async ({
  page,
}) => {
  await start(page);
  const canvas = page.locator(".canvas-frame canvas");
  const box = (await canvas.boundingBox())!;
  const channel = page.getByLabel("Channel frequency", { exact: true });
  const before = await channel.inputValue();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.12);
  const readout = page.locator(".spectrum-hover-readout");
  await expect(readout).toBeVisible();
  await expect(readout).toContainText("dB rel.");
  await expect(readout).toContainText("Paused");
  await expect(readout).not.toContainText("Click to tune");
  const text = await readout.textContent();
  const dot = (await page.locator(".spectrum-hover-dot").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect(readout).toHaveText(text!);
  expect(
    (await page.locator(".spectrum-hover-dot").boundingBox())!.y,
  ).toBeCloseTo(dot.y, 1);
  await expect(channel).toHaveValue(before);
  const center = page.getByLabel("Receiver center frequency", { exact: true });
  const accepted = Number(await center.inputValue());
  await expect(readout.locator("strong")).toHaveText(
    `${(accepted + 0.2048).toFixed(3)} MHz · Paused`,
  );
  await center.fill("145");
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await expect(readout).toContainText("Latest spectrum level");
  await expect(readout.locator("strong")).toHaveText(
    `${(accepted + 0.2048).toFixed(3)} MHz · Paused`,
  );
  await expect(channel).toHaveValue(before);
  await center.press("Escape");
  await page.screenshot({
    path: ".local/evidence/spectrum-hover-2026-10-15/hover-waterfall.png",
  });
  await page.locator(".band-guide-strip").hover();
  await expect(readout).toHaveCount(0);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.15);
  await expect(readout).toBeVisible();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.15);
  await expect(channel).not.toHaveValue(before);
  await page.mouse.move(0, 0);
  await expect(readout).toHaveCount(0);
});

test("guide preference persists and changing renderer clears the old preview", async ({
  page,
}) => {
  await start(page);
  const canvas = page.locator(".canvas-frame canvas");
  await canvas.hover({ position: { x: 100, y: 60 } });
  await expect(page.locator(".spectrum-hover-readout")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Display renderer", exact: true })
    .selectOption("webgpu");
  await expect(page.locator(".spectrum-hover-readout")).toHaveCount(0);
  const toggle = page.getByRole("checkbox", { name: "Hover frequency guide" });
  await toggle.uncheck();
  await page.reload();
  await page.getByText("Display settings", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test("edge tooltips stay in the plot and touch input leaves existing tuning available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const canvas = page.locator(".canvas-frame canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  for (const x of [0.01, 0.99]) {
    await page.mouse.move(box.x + box.width * x, box.y + box.height * 0.2);
    const readout = page.locator(".spectrum-hover-readout");
    await expect(readout).toBeVisible();
    const tooltip = (await readout.boundingBox())!;
    expect(tooltip.x).toBeGreaterThanOrEqual(box.x);
    expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(box.x + box.width);
    expect(tooltip.y + tooltip.height).toBeLessThanOrEqual(box.y + box.height);
  }
  await canvas.dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: box.x + 50,
    clientY: box.y + 50,
  });
  await expect(page.locator(".spectrum-hover-readout")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
