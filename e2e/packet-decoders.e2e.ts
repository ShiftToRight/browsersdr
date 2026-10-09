import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { packetRecordingFixture } from "../src/testing/packetRecordingFixture";

async function load(page: Page, mode: "APRS" | "RS41", corrupt = false) {
  const fixture = packetRecordingFixture(mode, 1_024_000, 37_000, corrupt);
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
  await page.getByRole("button", { name: "Start replay" }).click();
  await page.getByRole("tab", { name: "Audio & decode" }).click();
}

for (const mode of ["APRS", "RS41"] as const) {
  test(`${mode} worker replay retains validated data at EOF and exports provenance`, async ({
    page,
  }) => {
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source" })
      .selectOption("replay");
    await load(page, mode);
    await expect(
      page.getByRole("heading", {
        name: mode === "APRS" ? "APRS stations" : "RS41 radiosondes",
      }),
    ).toBeVisible();
    await expect(page.locator(".packet-decode-panel table")).toContainText(
      mode === "APRS" ? "N0CALL-1" : "K1930293",
    );
    await page.locator(".receiver-status-menu > summary").click();
    await expect(
      page.getByText("Replay reached end of file. Final spectrum retained.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.locator(".receiver-status-menu > summary").press("Escape");
    await page.locator(".packet-decode-panel > details > summary").click();
    if (mode === "APRS") {
      await expect(page.locator(".packet-record-list")).toContainText(
        "<script>literal text</script>",
      );
      await expect(page.locator(".packet-decode-panel script")).toHaveCount(0);
    } else {
      await expect(page.locator(".packet-record-list").first()).toContainText(
        "gpsPosition: CRC passed",
      );
      await expect(page.locator(".packet-decode-panel table")).toContainText(
        "28410.0 m ellipsoidal",
      );
    }
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: `Export ${mode} data (JSON)` })
      .click();
    const path = await (await download).path();
    expect(path).toBeTruthy();
    const exported = JSON.parse(await readFile(path!, "utf8"));
    expect(exported.schema).toBe(`browsersdr-${mode.toLowerCase()}-export-v1`);
    expect(exported.acquisition.nativeSampleRateHz).toBe(1_024_000);
    expect(exported.worker.droppedInputBlocks).toBe(0);
    const provenance =
      mode === "APRS"
        ? exported.snapshot.stations[0].lastHeard
        : exported.snapshot.sondes[0].lastHeard;
    expect(provenance.actualInputSampleRateHz).toBe(1_024_000);
    expect(provenance.selectedChannelOffsetHz).toBe(37_000);
    expect(provenance.generation).toBe(exported.acquisition.generation);
    expect(exported).not.toHaveProperty("receiverLocation");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: `Export ${mode} data (JSON)` }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // Second start rejects corrupt frames and cannot inherit the old station/sonde.
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    await load(page, mode, true);
    await page.locator(".receiver-status-menu > summary").click();
    await expect(
      page.getByText("Replay reached end of file. Final spectrum retained.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.locator(".receiver-status-menu > summary").press("Escape");
    await expect(page.locator(".packet-decode-panel table")).not.toContainText(
      mode === "APRS" ? "N0CALL-1" : "K1930293",
    );
  });
}
