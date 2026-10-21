import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createSigmfExport } from "../src/radio/sigmf";
import { pocsagRecordingFixture } from "../src/testing/pocsagRecordingFixture";
for (const rate of [512, 1200, 2400] as const)
  test(`POCSAG ${rate} actual worker replay retains messages and exports evidence`, async ({
    page,
  }) => {
    const recording = pocsagRecordingFixture(rate);
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source" })
      .selectOption("replay");
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    const inputs = page.locator(".file-picker-input");
    await inputs.nth(0).setInputFiles({
      name: "pocsag.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(recording.data),
    });
    await inputs.nth(1).setInputFiles({
      name: "pocsag.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(recording.metadata)),
    });
    await page.getByRole("button", { name: "Load files", exact: true }).click();
    await expect(page.locator(".file-message")).toContainText("Loaded");
    await page.getByRole("button", { name: "Start replay" }).click();
    await page.getByRole("tab", { name: "Audio & decode" }).click();
    await expect(
      page.getByRole("heading", { name: "POCSAG reception" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "POCSAG reception" }),
    ).toContainText("1 complete framing");
    await page
      .getByRole("button", { name: "Open Decoder", exact: true })
      .click();
    const workspace = page.locator("#decoder-view");
    await expect(workspace.locator(".decoder-record-list")).toContainText(
      `POCSAG ${rate} DEMO <script>literal text</script>`,
    );
    await expect(workspace.locator("script")).toHaveCount(0);
    await expect(workspace.locator(".decoder-record-list")).toContainText(
      "RIC 123456",
    );
    await workspace.locator(".decoder-record").first().click();
    await workspace
      .getByRole("button", { name: "Freeze display", exact: true })
      .click();
    await workspace.locator(".decoder-export-menu > summary").click();
    const download = page.waitForEvent("download");
    await workspace
      .getByRole("button", { name: "Export selected record", exact: true })
      .click();
    const data = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(data.records[0].raw).toMatchObject({
      rate,
      address: 123456,
      complete: true,
      ending: "idle",
      provenance: { selectedChannelOffsetHz: 37000 },
    });
    await page.setViewportSize({ width: 390, height: 950 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  });
test("POCSAG truncated replay ends visibly partial", async ({ page }) => {
  const recording = pocsagRecordingFixture(1200, false);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  const inputs = page.locator(".file-picker-input");
  await inputs.nth(0).setInputFiles({
    name: "partial.cu8",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(recording.data),
  });
  await inputs.nth(1).setInputFiles({
    name: "partial.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(recording.metadata)),
  });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await page.getByRole("button", { name: "Start replay" }).click();
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  await expect(
    page.getByRole("region", { name: "POCSAG reception" }),
  ).toContainText("1 partial");
  await page.getByRole("button", { name: "Open Decoder", exact: true }).click();
  await expect(
    page.locator("#decoder-view .decoder-record-list"),
  ).toContainText("Partial");
});

test("explicit POCSAG SigMF import restores decoder settings before actual replay", async ({
  page,
}) => {
  const recording = pocsagRecordingFixture(2400);
  recording.metadata.pocsag!.rate = 2400;
  const exported = await createSigmfExport(recording);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page
    .getByRole("combobox", { name: "Replay pair format" })
    .selectOption("sigmf");
  await page
    .getByRole("combobox", { name: "SigMF replay mode" })
    .selectOption("POCSAG");
  await page
    .getByRole("combobox", { name: "SigMF replay channel" })
    .selectOption("custom");
  await page
    .getByRole("spinbutton", { name: "Custom replay channel (MHz)" })
    .fill(String(recording.metadata.selectedChannelFrequencyHz / 1e6));
  const inputs = page.locator(".file-picker-input");
  await inputs.nth(0).setInputFiles({
    name: exported.dataFilename,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(recording.data),
  });
  await inputs.nth(1).setInputFiles({
    name: exported.metadataFilename,
    mimeType: "application/json",
    buffer: Buffer.from(exported.metadataJson),
  });
  await page
    .getByRole("button", { name: "Load SigMF pair", exact: true })
    .click();
  await expect(page.locator(".file-message")).toContainText("Loaded");
  await expect(
    page.getByRole("combobox", { name: "POCSAG bit rate" }),
  ).toHaveValue("2400");
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  await expect(
    page.getByRole("region", { name: "POCSAG reception" }),
  ).toContainText("1 complete framing");
});
