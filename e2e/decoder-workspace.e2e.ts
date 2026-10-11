import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { targetRecordingFixture } from "../src/testing/targetRecordingFixture";
import { packetRecordingFixture } from "../src/testing/packetRecordingFixture";
import { openApplicationView } from "./application-navigation";

async function openFixture(page: Page, corrupt = false) {
  const fixture = packetRecordingFixture("APRS", 1_024_000, 37_000, corrupt);
  const inputs = page.locator(".file-picker-input");
  await inputs.nth(0).setInputFiles({
    name: "APRS.cu8",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(fixture.data),
  });
  await inputs.nth(1).setInputFiles({
    name: "APRS.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.metadata)),
  });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(page.locator(".file-message")).toContainText("Loaded");
  await page.getByRole("button", { name: "Start replay" }).click();
}

test("Decoder reviews actual worker replay, exports a frozen selection and clears it on the next generation", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await openFixture(page);
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  await expect(page.locator(".packet-decode-panel table")).toContainText(
    "N0CALL-1",
  );
  await page.getByRole("button", { name: "Open Decoder", exact: true }).click();
  const workspace = page.locator("#decoder-view");
  await expect(workspace.locator(".decoder-record-list")).toContainText(
    "N0CALL-1",
  );
  await workspace
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await expect(workspace.locator(".decoder-record-list")).toContainText(
    "<script>literal text</script>",
  );
  await expect(workspace.locator("script")).toHaveCount(0);
  await workspace
    .getByRole("button", { name: "Freeze display", exact: true })
    .click();
  await expect(workspace.locator(".decoder-state")).toHaveText(
    "Display frozen",
  );
  await workspace.getByLabel("Export scope").selectOption("selected");
  const download = page.waitForEvent("download");
  await workspace
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  const path = await (await download).path();
  const exported = JSON.parse(await readFile(path!, "utf8"));
  expect(exported.schema).toBe("browsersdr-decoder-view-v1");
  expect(exported.scope).toBe("selected");
  expect(exported.records).toHaveLength(1);
  expect(exported.display).toBe("frozen snapshot");
  expect(exported.records[0].raw.provenance.generation).toBe(
    exported.acquisition.generation,
  );
  expect(exported.records[0].raw.provenance.selectedChannelOffsetHz).toBe(
    37_000,
  );
  for (const width of [1366, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(
      workspace.getByRole("button", { name: "Export JSON", exact: true }),
    ).toBeVisible();
  }
  await workspace
    .getByRole("button", { name: "Open I/Q recording", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Open recording", exact: true }),
  ).toBeFocused();
  await openFixture(page, true);
  await page.locator(".receiver-status-menu > summary").click();
  await expect(
    page.getByText("Replay reached end of file. Final spectrum retained.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.locator(".receiver-status-menu > summary").press("Escape");
  await openApplicationView(page, "Decoder");
  await expect(workspace.locator(".decoder-record")).toHaveCount(0);
  await expect(workspace.locator(".decoder-state")).not.toHaveText(
    "Display frozen",
  );
});

test("format browsing is inert and satellite entry opens existing recording controls", async ({
  page,
}) => {
  await page.goto("/");
  const originalMode = await page
    .getByRole("combobox", { name: "Mode", exact: true })
    .inputValue();
  await openApplicationView(page, "Decoder");
  await page.getByLabel("Format", { exact: true }).selectOption("APRS");
  await expect(
    page.getByRole("button", { name: "Apply APRS", exact: true }),
  ).toBeVisible();
  await openApplicationView(page, "Receiver");
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue(originalMode);
  await openApplicationView(page, "Decoder");
  await page.getByLabel("Format", { exact: true }).selectOption("satellite");
  await expect(page.locator(".decoder-empty")).toContainText(
    "no native LRPT decoder",
  );
  await page
    .getByRole("button", { name: "Open recording workflow", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Receiver", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: "Open recording", exact: true }),
  ).toBeFocused();
});

test("utilities return to Decoder and applied configuration uses the shared mode", async ({
  page,
}) => {
  await page.goto("/");
  await openApplicationView(page, "Decoder");
  await page.getByLabel("Format", { exact: true }).selectOption("APRS");
  await page.getByRole("button", { name: "Apply APRS", exact: true }).click();
  await openApplicationView(page, "Help");
  await page
    .getByRole("button", { name: "Back to Decoder", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Decoder", exact: true }),
  ).toBeFocused();
  await openApplicationView(page, "Receiver");
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue("APRS");
});

for (const mode of ["ADS-B", "AIS"] as const) {
  test(`${mode} replay shows a reported symbol and received track with an inert display toggle`, async ({
    page,
  }) => {
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source" })
      .selectOption("replay");
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    const fixture = targetRecordingFixture(mode);
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
    await page.getByRole("button", { name: "Start replay" }).click();
    await openApplicationView(page, "Decoder");
    const workspace = page.locator("#decoder-view");
    await expect(workspace.locator(".map-target-symbol")).toHaveAttribute(
      "data-symbol",
      mode === "ADS-B" ? "helicopter" : "vessel",
    );
    await expect(workspace.locator(".map-track path")).toHaveCount(1);
    await expect(workspace.locator(".decoder-state")).toHaveText(
      "Retained / idle",
    );
    await workspace
      .getByRole("button", { name: "Freeze display", exact: true })
      .click();
    await expect(workspace.locator(".decoder-state")).toHaveText(
      "Display frozen",
    );
    const track = await workspace.locator(".map-track path").getAttribute("d");
    await workspace.getByRole("checkbox", { name: "Show tracks" }).uncheck();
    await expect(workspace.locator(".map-track path")).toHaveCount(0);
    await expect(workspace.locator(".map-target-symbol")).toHaveCount(1);
    await workspace.getByRole("checkbox", { name: "Show tracks" }).check();
    await expect(workspace.locator(".map-track path")).toHaveAttribute(
      "d",
      track!,
    );
    const download = page.waitForEvent("download");
    await workspace
      .getByRole("button", { name: "Export JSON", exact: true })
      .click();
    const exported = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(exported.records[0].raw.track.length).toBeGreaterThanOrEqual(2);
    expect(exported.records[0].map).toBeUndefined();
    if (mode === "ADS-B") expect(exported.records[0].raw.category).toBe("A7");
    for (const width of [1366, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await expect(
        workspace.getByRole("checkbox", { name: "Show tracks" }),
      ).toBeVisible();
    }
  });
}
