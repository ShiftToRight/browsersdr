import { expect, test } from "@playwright/test";
import { installHackrfUsb } from "./hackrf-usb-fixture";
import {
  DEFAULT_SURVEY_PROFILE,
  createSurveyRunSnapshot,
} from "../src/radio/fieldSurvey";
import { SYNTHETIC_DEMO_SESSION } from "../src/testing/syntheticTone";

test("frequency edits survive a delayed real sample-rate transaction without implicit retuning", async ({
  page,
}) => {
  await installHackrfUsb(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  // Install the delayed rate hook only after startup has sent its own rate command.
  await expect(
    page.getByRole("button", { name: "Stop receiving", exact: true }),
  ).toBeEnabled();
  await page.getByText("Device details & settings", { exact: true }).click();
  await page.evaluate(() => {
    const win = window as unknown as {
      __hackrf: { device: USBDevice };
      __releaseUxRate(): void;
    };
    const device = win.__hackrf.device,
      original = device.controlTransferOut.bind(device);
    let delay = true;
    device.controlTransferOut = async (setup, data) => {
      if (setup.request === 6 && delay) {
        delay = false;
        await new Promise<void>((resolve) => {
          win.__releaseUxRate = resolve;
        });
      }
      return original(setup, data);
    };
  });
  await page
    .getByRole("combobox", { name: "Sample rate", exact: true })
    .selectOption("4800000");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await expect(channel).toBeEnabled();
  await channel.fill("100.1234");
  await expect(page.locator("#frequency-state")).toContainText("edit is kept");
  await page.evaluate(() =>
    (window as unknown as { __releaseUxRate(): void }).__releaseUxRate(),
  );
  await expect(
    page.getByRole("button", { name: "Stop receiving", exact: true }),
  ).toBeEnabled();
  await expect(channel).toHaveValue("100.1234");
  await expect(page.locator("#frequency-state")).toContainText(
    "Change pending",
  );
  await page.getByRole("button", { name: "Tune", exact: true }).click();
  await expect(page.locator("#frequency-state")).toHaveText("✓ Tuned");
  await expect(channel).toHaveValue("100.1234");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});

test("real origin-local locks identify another BrowserSDR tab and release on tab closure", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await installHackrfUsb(tab);
    await tab.addInitScript(() => {
      const device = (window as unknown as { __hackrf: { device: USBDevice } })
        .__hackrf.device;
      Object.defineProperty(device, "serialNumber", {
        value: "ux-disposable-same-device",
      });
    });
    await tab.goto("/?browser-test=1");
    await tab
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption("hackrf");
  }
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(second.locator(".receiver-status")).toContainText(
    "another BrowserSDR tab",
  );
  expect(
    await second.evaluate(
      () =>
        (window as unknown as { __hackrf: { device: USBDevice } }).__hackrf
          .device.opened,
    ),
  ).toBe(false);
  await page.close();
  await second.locator(".acquire-connect").click();
  await expect(
    second.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "Disconnect", exact: true }).click();
  await second.close();
});

test("Explorer explains unavailable recovery export and uses saved airband context for AM investigation", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export recovery JSON", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#survey-recovery-help")).toContainText(
    "No survey results",
  );
  const snapshot = createSurveyRunSnapshot(
    DEFAULT_SURVEY_PROFILE,
    DEFAULT_SURVEY_PROFILE.bands,
    { ...SYNTHETIC_DEMO_SESSION },
    "2026-10-16T12:00:00Z",
    "ux-airband",
  );
  await page.evaluate(async (snapshot) => {
    const saved = {
      version: 1,
      key: "latest",
      savedAt: "2026-10-16T12:00:00Z",
      scope: "band-plan",
      status: "completed",
      snapshot,
      windows: [],
      progress: { completed: 1, total: 1 },
      records: [
        {
          bandId: "airband",
          bandName: "Civil airband",
          frequencyHz: 125e6,
          peakDb: -40,
          noiseFloorDb: -90,
          bandwidthHz: 10000,
          selected: false,
          captured: false,
          annotation: { confidence: "unknown" },
        },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("browsersdr-surveys", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("survey-runs", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("survey-runs", "readwrite");
        tx.objectStore("survey-runs").put(saved);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, snapshot);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(
    page.getByLabel("Investigation mode at 125 MHz", { exact: true }),
  ).toHaveValue("AM");
  await expect(
    page.getByRole("button", { name: "Export recovery JSON", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  await expect(
    page.getByLabel("Channel frequency", { exact: true }),
  ).toHaveValue("125.000");
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue("AM");
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible();
});

test("AIS mode search excludes Vaisala and ATIS search provides a local-frequency explanation", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "More modes…", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search modes or decoders" })
    .fill("AIS");
  await expect(
    page.getByRole("button", { name: "Select AIS", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select RS41", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close decoder chooser" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search text, frequency or DAB block" })
    .fill("ATIS");
  await expect(
    page.getByRole("heading", { name: "ATIS / aviation voice" }),
  ).toBeVisible();
  await expect(
    page.getByText(/No local ATIS station or frequency is supplied/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview ATIS / aviation voice" }),
  ).toHaveCount(0);
});

test("waterfall ticks adapt to available width without overlapping labels", async ({
  page,
}, testInfo) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect
    .poll(() => page.locator(".frequency-rule > span").count())
    .toBeGreaterThanOrEqual(5);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () =>
        page
          .locator(".frequency-rule > span")
          .evaluateAll((nodes) =>
            nodes.every(
              (node, index) =>
                index === 0 ||
                node.getBoundingClientRect().left >=
                  nodes[index - 1]!.getBoundingClientRect().right,
            ),
          ),
      )
      .toBe(true);
    await page.locator(".graphics-panel").screenshot({
      path: `.local/ux-round3-20261016/ticks-${width}-${testInfo.project.name}.png`,
    });
  }
});
