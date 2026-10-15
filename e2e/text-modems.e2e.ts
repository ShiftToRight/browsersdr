import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { textModemRecordingFixture } from "../src/testing/textModemRecordingFixture";
import {
  chooseReceiverMode,
  openApplicationView,
} from "./application-navigation";
for (const mode of ["RTTY", "PSK31", "NAVTEX", "ACARS"] as const) {
  test(`${mode} worker replay, EOF, text export and bounded Decoder messages`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = textModemRecordingFixture(mode);
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source" })
      .selectOption("replay");
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    const inputs = page.locator(".file-picker-input");
    await inputs.nth(0).setInputFiles({
      name: `${mode}.cu8`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
    await inputs.nth(1).setInputFiles({
      name: `${mode}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.metadata)),
    });
    await page.getByRole("button", { name: "Load files", exact: true }).click();
    await expect(page.locator(".file-message")).toContainText("Loaded");
    await page
      .getByRole("button", { name: "Start replay", exact: true })
      .click();
    await page.getByRole("tab", { name: "Audio & decode" }).click();
    const panel = page.locator(".text-decode-panel");
    await expect(
      panel.getByLabel("Received text", { exact: true }),
    ).toContainText(fixture.expectedText, { timeout: 15000 });
    await page.locator(".receiver-status-menu > summary").click();
    await expect(
      page.getByText("Replay reached end of file. Final spectrum retained.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 });
    await page.locator(".receiver-status-menu > summary").press("Escape");
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export modem JSON" }).click();
    const path = await (await download).path();
    const data = JSON.parse(await readFile(path!, "utf8"));
    expect(data.schema).toBe("browsersdr-text-modem-v1");
    expect(data.snapshot.mode).toBe(mode);
    expect(data.snapshot.messages.length).toBeGreaterThan(0);
    expect(data.snapshot.messages.length).toBeLessThanOrEqual(16);
    expect(data.worker.droppedInputBlocks).toBe(0);
    expect(data.snapshot.messages[0].provenance.selectedChannelOffsetHz).toBe(
      37000,
    );
    expect(data.snapshot.messages[0].provenance.generation).toBe(
      data.acquisition.generation,
    );
    if (mode === "ACARS") expect(data.snapshot.messages).toHaveLength(1);
    const textDownload = page.waitForEvent("download");
    await panel
      .getByRole("button", { name: "Export text", exact: true })
      .click();
    expect(
      await readFile((await (await textDownload).path())!, "utf8"),
    ).toContain(fixture.expectedText);
    await openApplicationView(page, "Decoder");
    await expect(page.locator(".decoder-workbench")).toContainText(
      fixture.expectedText,
    );
    await page.screenshot({
      path: `.local/evidence/d1-d4-2026-10-15/${mode}-${test.info().project.name}-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.local/evidence/d1-d4-2026-10-15/${mode}-${test.info().project.name}-phone.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
test("text modem chooser and settings persist without starting reception", async ({
  page,
}) => {
  await page.goto("/");
  await chooseReceiverMode(page, "RTTY");
  await page.getByRole("button", { name: "Amateur 45.45 / 170" }).click();
  await page.getByLabel("Text modem fine tuning offset").fill("1200");
  await page.getByLabel("Reverse mark / space").check();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue("RTTY");
  await expect(
    page.getByRole("combobox", { name: "RTTY baud", exact: true }),
  ).toHaveValue("45.45");
  await expect(page.getByLabel("Text modem fine tuning offset")).toHaveValue(
    "1200",
  );
  await expect(page.getByLabel("Reverse mark / space")).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeDisabled();
});
