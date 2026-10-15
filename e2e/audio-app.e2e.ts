import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createDeterministicRecordingFixture } from "../src/testing/recordingFixture";

async function prepareAudio(page: Page) {
  const fixture = createDeterministicRecordingFixture(144_000);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page
    .locator(".file-picker-input")
    .nth(0)
    .setInputFiles({
      name: "am.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
  await page
    .locator(".file-picker-input")
    .nth(1)
    .setInputFiles({
      name: "am.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.metadata)),
    });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(page.locator(".file-message")).toContainText("Loaded");
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  const panel = page.locator("#decode-panel .audio-capture-panel");
  await panel.locator("summary").click();
  await panel
    .getByRole("checkbox", { name: "Keep last 60 seconds for rewind" })
    .check();
  await panel
    .getByRole("button", { name: "Record audio", exact: true })
    .click();
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  await panel.locator("summary").click();
  return panel;
}

for (const deviceRate of [48_000, 44_100]) {
  test(`decoded AM audio records actual PCM, finishes at EOF, downloads WAV and supports rewind (${deviceRate} Hz device)`, async ({
    page,
  }) => {
    await page.addInitScript((rate) => {
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options?: AudioContextOptions) {
          super({ ...options, sampleRate: rate });
        }
      };
    }, deviceRate);
    const panel = await prepareAudio(page);
    await expect(panel.getByRole("status")).toContainText("end of file", {
      timeout: 15_000,
    });
    await expect(
      panel.getByRole("button", { name: "Download audio WAV" }),
    ).toBeEnabled();
    const downloading = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download audio WAV" }).click();
    const bytes = await readFile((await (await downloading).path())!);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    const rate = bytes.readUInt32LE(24),
      frames = bytes.readUInt32LE(40) / 4;
    expect(frames / rate).toBeGreaterThan(2.9);
    expect(frames / rate).toBeLessThan(3.1);
    let real = 0,
      imaginary = 0;
    for (let i = Math.floor(rate * 0.25); i < Math.floor(rate * 2.5); i++) {
      const value = bytes.readInt16LE(44 + i * 4) / 32768;
      real += value * Math.cos((2 * Math.PI * 1000 * i) / rate);
      imaginary -= value * Math.sin((2 * Math.PI * 1000 * i) / rate);
    }
    expect(Math.hypot(real, imaginary) / (rate * 2.25)).toBeGreaterThan(0.01);
    expect(bytes.toString()).toContain(
      "Decoded replay audio; AM; channel 10006000 Hz",
    );
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    await page.getByRole("tab", { name: "Audio & decode" }).click();
    await panel.locator("summary").click();
    await panel
      .getByRole("button", { name: "Rewind audio", exact: true })
      .click();
    const audio = panel.locator("audio");
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.duration),
      )
      .toBeGreaterThan(2.9);
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    await panel.getByRole("button", { name: "Return to live audio" }).click();
    await expect(audio).toHaveCount(0);
    await panel.screenshot({
      path: `/tmp/browsersdr-f2-f6-audio-${test.info().project.name}.png`,
    });
    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await expect(
        panel.getByRole("button", { name: "Save rewind WAV" }),
      ).toBeVisible();
    }
    await panel
      .getByRole("button", { name: "Discard audio", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Record audio", exact: true }),
    ).toBeEnabled();
  });
}

test("changing source stops rewind, clears history and preserves the completed audio export", async ({
  page,
}) => {
  const panel = await prepareAudio(page);
  await expect(
    panel.getByRole("button", { name: "Rewind audio", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Rewind audio", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("synthetic");
  await expect(
    panel.getByRole("button", { name: "Rewind audio", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Download audio WAV" }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      panel
        .locator("audio")
        .evaluate((element: HTMLAudioElement) => element.paused),
    )
    .toBe(true);
  await panel
    .getByRole("button", { name: "Discard audio", exact: true })
    .click();
});

test("app manifest and branded icons parse in Chromium and standalone keeps manual connection controls", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const session = await context.newCDPSession(page);
  const manifest = await session.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  const data = JSON.parse(manifest.data!);
  expect(data.id).toBe("/");
  expect(data.display).toBe("standalone");
  expect(data.start_url).toBe("/");
  for (const icon of data.icons) {
    const response = await page.request.get(icon.src);
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    const size = Number(icon.sizes.split("x")[0]);
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === "(display-mode: standalone)"
        ? Object.defineProperty(original(query), "matches", { value: true })
        : original(query);
  });
  await page.reload();
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(
    page.getByText("BrowserSDR app installed", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "Signal source" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
});

test("installation prompts require a click, dismissal consumes the prompt and appinstalled updates status", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    let calls = 0;
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        calls++;
        document.body.dataset.installCalls = String(calls);
      },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(event);
  });
  expect(
    await page.locator("body").getAttribute("data-install-calls"),
  ).toBeNull();
  await page.getByLabel("Settings", { exact: true }).click();
  await page
    .getByRole("button", { name: "Install BrowserSDR app", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute("data-install-calls", "1");
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(
    page.getByText("Installation dismissed.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install BrowserSDR app", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(
    page.getByText("BrowserSDR app installed", { exact: true }),
  ).toBeVisible();
});
