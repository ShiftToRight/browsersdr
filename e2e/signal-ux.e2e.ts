import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { installHackrfUsb } from "./hackrf-usb-fixture";
import { chooseReceiverMode } from "./application-navigation";

test("19.2 MS/s channel capture completes five seconds while Search opens", async ({
  page,
}, testInfo) => {
  await installHackrfUsb(page, false, false, 19_200_000);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await chooseReceiverMode(page, "DAB");
  if (testInfo.project.name === "chromium-dev") {
    // Compile Vite's lazy Search modules before measuring RF throughput.
    // Built/stamped projects still exercise the first Search open during capture.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("searchbox", {
        name: "Search text, frequency or DAB block",
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Search", exact: true })
      .first()
      .click();
  }
  await page.getByText("Device details & settings", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Sample rate", exact: true })
    .selectOption("19200000");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByLabel("Capture current channel only").check();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page.getByLabel("Timed capture seconds").fill("5");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  // Open Search during actual capture, after asynchronous storage preparation
  // has committed its controls, rather than clicking through that transition.
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search text, frequency or DAB block" })
    .fill("5C");
  await page
    .getByRole("button", { name: "Close Search", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Download ZIP", exact: true }),
  ).toBeEnabled({ timeout: 12000 });
  await expect(page.locator(".recording-state")).not.toContainText(
    "stopped early",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const zip = unzipSync(await readFile((await (await pending).path())!));
  const meta = JSON.parse(
    new TextDecoder().decode(
      Object.entries(zip).find(([name]) => name.endsWith(".sigmf-meta"))![1],
    ),
  );
  const data = Object.entries(zip).find(([name]) =>
    name.endsWith(".sigmf-data"),
  )![1];
  await testInfo.attach("channel-capture-metadata", {
    body: JSON.stringify(meta, null, 2),
    contentType: "application/json",
  });
  expect(meta.global["core:sample_rate"]).toBe(2_400_000);
  expect(data.byteLength / 2 / 2_400_000).toBeGreaterThan(4.65);
  expect(data.byteLength / 2 / 2_400_000).toBeLessThan(5.3);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});

test("spectrum channel raster and free override follow the selected plan", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByLabel("Channel frequency", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Band guide plan", exact: true })
    .selectOption("DE");
  // Synthetic source accepts WBFM settings and uses its actual displayed span.
  const canvas = page.locator(".spectrum-display canvas").first();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.57, y: 35 } });
  const snapped = await page
    .getByLabel("Channel frequency", { exact: true })
    .inputValue();
  expect((Number(snapped) * 1e6) % 100_000).toBeCloseTo(0, 2);
  await canvas.click({
    position: { x: box.width * 0.573, y: 35 },
    modifiers: ["Alt"],
  });
  const free = await page
    .getByLabel("Channel frequency", { exact: true })
    .inputValue();
  expect((Number(free) * 1e6) % 100_000).not.toBeCloseTo(0, 2);
});

test("European OOK sensor selection is explicit and resets on modulation change", async ({
  page,
}) => {
  await page.goto("/");
  await chooseReceiverMode(page, "SRD");
  // The controls are grouped by their accessible label rather than a region role.
  const decoder = page
    .locator('[aria-label="SRD reception settings"]')
    .getByRole("combobox", { name: /^Decoder/ });
  await decoder.selectOption("fineoffset-wh2");
  await expect(decoder).toHaveValue("fineoffset-wh2");
  await page.reload();
  await expect(decoder).toHaveValue("fineoffset-wh2");
  await page
    .locator('[aria-label="SRD reception settings"]')
    .getByRole("combobox", { name: "Modulation", exact: true })
    .selectOption("2fsk");
  await expect(decoder).toHaveValue("none");
  await expect(decoder.locator('option[value="fineoffset-wh2"]')).toHaveCount(
    0,
  );
  await expect(decoder.locator('option[value="fineoffset-wh51"]')).toHaveCount(
    1,
  );
});
