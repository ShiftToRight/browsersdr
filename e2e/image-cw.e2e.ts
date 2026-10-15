import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { imageCwRecordingFixture } from "../src/testing/imageCwRecordingFixture";
import {
  chooseReceiverMode,
  openApplicationView,
} from "./application-navigation";

async function load(page: Page, mode: "WEFAX" | "SSTV" | "CW-TEXT") {
  const fixture = imageCwRecordingFixture(mode);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  const files = page.locator(".file-picker-input");
  await files.nth(0).setInputFiles({
    name: `${mode}.cu8`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(fixture.data),
  });
  await files.nth(1).setInputFiles({
    name: `${mode}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.metadata)),
  });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(page.locator(".file-message")).toContainText("Loaded");
  return fixture;
}
async function start(page: Page) {
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("tab", { name: "Audio & decode" }).click();
}
for (const mode of ["WEFAX", "SSTV"] as const)
  test(`${mode} worker replay renders pixels, retains partial EOF image and exports PNG with provenance`, async ({
    page,
  }) => {
    // Real-time replay plus cold workspace loading, two exports and responsive screenshots.
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await load(page, mode);
    await start(page);
    const panel = page.locator(".image-decode-panel");
    await expect(panel).toContainText("End of input · partial image", {
      timeout: 15000,
    });
    const canvas = panel.locator("canvas");
    const raster = await canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext("2d")!;
      return {
        width: element.width,
        height: element.height,
        bars: Array.from({ length: 4 }, (_, bar) => [
          ...context.getImageData(
            Math.floor((element.width * (bar + 0.5)) / 4),
            2,
            1,
            1,
          ).data,
        ]),
      };
    });
    expect(raster.width).toBe(mode === "WEFAX" ? 1809 : 160);
    expect(raster.height).toBeGreaterThanOrEqual(7);
    if (mode === "SSTV")
      for (let bar = 0; bar < 4; bar++)
        for (let c = 0; c < 3; c++) {
          if (bar === c || bar === 3)
            expect(raster.bars[bar]![c]).toBeGreaterThan(220);
          else expect(raster.bars[bar]![c]).toBeLessThan(35);
        }
    else
      for (let bar = 0; bar < 4; bar++)
        expect(Math.abs(raster.bars[bar]![0]! - bar * 85)).toBeLessThan(10);
    await panel.getByLabel("Image alignment", { exact: true }).fill("25");
    await panel
      .getByLabel("Image slant correction", { exact: true })
      .fill("100");
    const pngDownload = page.waitForEvent("download");
    await panel
      .getByRole("button", { name: "Export PNG", exact: true })
      .click();
    const png = await readFile((await (await pngDownload).path())!);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(raster.width);
    expect(png.readUInt32BE(20)).toBe(raster.height);
    const jsonDownload = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export image metadata" }).click();
    const metadata = JSON.parse(
      await readFile((await (await jsonDownload).path())!, "utf8"),
    );
    expect(metadata.image).toMatchObject({
      width: raster.width,
      complete: false,
      receivedRows: raster.height,
    });
    expect(metadata.displayCorrection).toMatchObject({
      alignmentPercent: 25,
      slantPpm: 100,
      appliedToPng: true,
    });
    expect(metadata.image.provenance).toMatchObject({
      selectedChannelOffsetHz: 37000,
      actualInputSampleRateHz: 1_024_000,
    });
    expect(metadata.worker.droppedInputBlocks).toBe(0);
    expect(metadata.image.pixels).toBeUndefined();
    await openApplicationView(page, "Decoder");
    await expect(page.locator(".decoder-workbench")).toContainText(
      "received rows",
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `.local/evidence/d5-d6-2026-10-15/${mode}-${test.info().project.name}-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });

test("CW text retains Morse transcription while the audio monitor produces a 600 Hz recording", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await load(page, "CW-TEXT");
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  const audio = page.locator("#decode-panel .audio-capture-panel");
  await audio.locator("summary").click();
  await audio
    .getByRole("button", { name: "Record audio", exact: true })
    .click();
  await start(page);
  const text = page.locator(".text-decode-panel");
  await expect(text.getByLabel("Received text", { exact: true })).toContainText(
    fixture.expectedText,
    { timeout: 15000 },
  );
  await expect(page.getByLabel("Volume", { exact: true })).toBeVisible();
  await audio.locator("summary").click();
  await expect(audio.getByRole("status")).toContainText("end of file", {
    timeout: 15000,
  });
  const downloading = page.waitForEvent("download");
  await audio.getByRole("button", { name: "Download audio WAV" }).click();
  const bytes = await readFile((await (await downloading).path())!);
  const rate = bytes.readUInt32LE(24),
    frames = bytes.readUInt32LE(40) / 4;
  let real = 0,
    imaginary = 0,
    energy = 0;
  for (let i = 0; i < frames; i++) {
    const value = bytes.readInt16LE(44 + i * 4) / 32768;
    real += value * Math.cos((2 * Math.PI * 600 * i) / rate);
    imaginary += value * Math.sin((2 * Math.PI * 600 * i) / rate);
    energy += value * value;
  }
  expect(Math.sqrt(energy / frames)).toBeGreaterThan(0.01);
  expect(Math.hypot(real, imaginary) / frames).toBeGreaterThan(0.01);
  const exported = page.waitForEvent("download");
  await text.getByRole("button", { name: "Export modem JSON" }).click();
  const data = JSON.parse(
    await readFile((await (await exported).path())!, "utf8"),
  );
  expect(data.snapshot.mode).toBe("CW-TEXT");
  expect(data.snapshot.messages[0].integrity).toContain("Tentative Morse");
  expect(data.worker.droppedInputBlocks).toBe(0);
  await openApplicationView(page, "Decoder");
  await expect(page.locator(".decoder-workbench")).toContainText(
    fixture.expectedText,
  );
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local/evidence/d5-d6-2026-10-15/CW-TEXT-${test.info().project.name}-390.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("image and CW controls persist without starting hardware", async ({
  page,
}) => {
  await page.goto("/");
  await chooseReceiverMode(page, "WEFAX");
  await page
    .getByLabel("WEFAX reception", { exact: true })
    .selectOption("manual");
  await page
    .getByRole("combobox", { name: "Index of cooperation", exact: true })
    .selectOption("288");
  await page
    .getByRole("combobox", { name: "WEFAX shift (Hz)", exact: true })
    .selectOption("850");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Index of cooperation", exact: true }),
  ).toHaveValue("288");
  await expect(page.getByLabel("WEFAX reception", { exact: true })).toHaveValue(
    "manual",
  );
  await chooseReceiverMode(page, "SSTV");
  await page
    .getByRole("combobox", { name: "SSTV image mode", exact: true })
    .selectOption("Martin M1");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "SSTV image mode", exact: true }),
  ).toHaveValue("Martin M1");
  await chooseReceiverMode(page, "CW-TEXT");
  await page.getByLabel("CW text speed", { exact: true }).fill("28");
  await page.getByLabel("Track CW speed", { exact: true }).check();
  await page.reload();
  await expect(page.getByLabel("CW text speed", { exact: true })).toHaveValue(
    "28",
  );
  await expect(
    page.getByLabel("Track CW speed", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeDisabled();
});
