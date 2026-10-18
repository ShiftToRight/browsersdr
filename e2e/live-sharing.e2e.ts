import { test, expect, type Page } from "@playwright/test";
import { createDeterministicRecordingFixture } from "../src/testing/recordingFixture";
import { sharingSignalingFixture } from "./helpers/sharingSignaling";
let signaling: ReturnType<typeof sharingSignalingFixture>;
test.beforeEach(async ({ context }) => {
  signaling = sharingSignalingFixture();
  await signaling.install(context);
});

async function share(page: Page) {
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page
    .getByRole("button", { name: "Share live audio & spectrum", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start sharing", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open guest preview" }),
  ).toBeVisible();
  return page.getByRole("dialog", { name: "Share live audio & spectrum" });
}
async function guestGuards(page: Page) {
  await page.addInitScript(() => {
    const counts = { usb: 0, media: 0 };
    Object.defineProperty(window, "__guestAccess", { value: counts });
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        getDevices: () => {
          counts.usb++;
          return Promise.resolve([]);
        },
        requestDevice: () => {
          counts.usb++;
          throw new Error("Guest requested USB");
        },
      },
    });
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = () => {
        counts.media++;
        return Promise.reject(new Error("Guest requested microphone"));
      };
  });
}

test("real WebRTC shares RF rows to one guest, refuses a second and ends on host Stop without guest USB", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  const panel = await share(page);
  const link = await page
    .getByRole("link", { name: "Open guest preview" })
    .getAttribute("href");
  const guest = await context.newPage();
  await guestGuards(guest);
  await guest.goto(link!);
  await expect(
    guest.getByRole("button", { name: "Join host", exact: true }),
  ).toBeEnabled();
  await expect(guest.getByTestId("share-received-frames")).toHaveText("0");
  await guest.getByRole("button", { name: "Join host", exact: true }).click();
  await expect(guest.locator(".live-share-status")).toHaveText("Connected");
  if (process.env.BSD_E2E_SHARING_RELAY === "1")
    await expect(guest.getByTestId("share-connection-path")).toContainText(
      "TURN relay",
    );
  await expect
    .poll(async () =>
      Number(await guest.getByTestId("share-received-frames").textContent()),
    )
    .toBeGreaterThan(2);
  expect(
    await guest.evaluate(
      () => (window as unknown as { __guestAccess: unknown }).__guestAccess,
    ),
  ).toEqual({ usb: 0, media: 0 });
  expect(
    await guest
      .locator("audio")
      .evaluate((element: HTMLAudioElement) => element.paused),
  ).toBe(true);
  const canvas = guest.getByRole("img", {
    name: "Shared host RF spectrum and waterfall, relative power",
  });
  const picture = await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d")!;
    const pixels = context.getImageData(0, 325, 1024, 1).data;
    const colored = Array.from(
      { length: 1024 },
      (_, x) =>
        pixels[x * 4] !== 8 ||
        pixels[x * 4 + 1] !== 19 ||
        pixels[x * 4 + 2] !== 33,
    ).some(Boolean);
    return {
      rows: Number(element.dataset.historyRows),
      seconds: Number(element.dataset.historySeconds),
      colored,
    };
  });
  expect(picture.rows).toBeGreaterThan(0);
  expect(picture.rows).toBeLessThan(225);
  expect(picture.seconds).toBeGreaterThanOrEqual(0);
  expect(picture.colored).toBe(true);
  const second = await context.newPage();
  await second.goto(link!);
  await second.getByRole("button", { name: "Join host", exact: true }).click();
  await expect(
    second.getByText(/already has a guest|not found or expired/),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Close live sharing panel" }).click();
  await expect(
    page.getByRole("button", { name: /Sharing live/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    guest.getByText("Host ended sharing.", { exact: false }),
  ).toBeVisible();
  await expect(guest.locator(".live-share-status")).toHaveText("Disconnected");
  await second.close();
  await guest.close();
});

test("a single session key joins isolated browsers and carries decoded AM audio with host volume zero", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(45_000);
  const fixture = createDeterministicRecordingFixture(48_000 * 40);
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("replay");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("slider", { name: "Volume", exact: true }).fill("0");
  const panel = await share(page);
  const key = await panel
    .getByRole("textbox", { name: "Host session key", exact: true })
    .inputValue();
  expect(key).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  const guestContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  await signaling.install(guestContext);
  const guest = await guestContext.newPage();
  await guestGuards(guest);
  await guest.goto("/?live-guest=1");
  await guest
    .getByRole("textbox", { name: "Session key", exact: true })
    .fill(key.toLowerCase());
  await guest.getByRole("button", { name: "Join host", exact: true }).click();
  await expect(guest.locator(".live-share-status")).toHaveText("Connected");
  if (process.env.BSD_E2E_SHARING_RELAY === "1")
    await expect(guest.getByTestId("share-connection-path")).toContainText(
      "TURN relay",
    );
  await expect
    .poll(async () =>
      Number(await guest.getByTestId("share-audio-packets").textContent()),
    )
    .toBeGreaterThan(5);
  expect(
    await guest
      .locator("audio")
      .evaluate((element: HTMLAudioElement) => element.paused),
  ).toBe(true);
  await guest.getByRole("button", { name: "Listen", exact: true }).click();
  const measured = await guest
    .locator("audio")
    .evaluate(async (element: HTMLAudioElement) => {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(
          element.srcObject as MediaStream,
        ),
        analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 0;
      for (let i = 1; i < bins.length; i++)
        if (bins[i]! > bins[peak]!) peak = i;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(
        data.reduce((sum, v) => sum + v * v, 0) / data.length,
      );
      const result = {
        rms,
        peakHz: (peak * context.sampleRate) / analyser.fftSize,
        paused: element.paused,
      };
      source.disconnect();
      await context.close();
      return result;
    });
  expect(measured.paused).toBe(false);
  expect(measured.rms).toBeGreaterThan(0.02);
  expect(measured.peakHz).toBeGreaterThan(900);
  expect(measured.peakHz).toBeLessThan(1100);
  expect(
    await guest.evaluate(
      () => (window as unknown as { __guestAccess: unknown }).__guestAccess,
    ),
  ).toEqual({ usb: 0, media: 0 });
  await panel
    .getByRole("button", { name: "Stop sharing", exact: true })
    .click();
  await expect(
    guest.getByText("Host ended sharing.", { exact: false }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Close live sharing panel" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await guestContext.close();
});

test("guest key input rejects invalid and unknown keys and fits a narrow view without automatic access", async ({
  page,
}) => {
  await guestGuards(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?live-guest=1#join=invalid");
  await expect(
    page.getByRole("button", { name: "Join host", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Session key", exact: true })
    .fill("ZZZZ-ZZZZ-ZZZZ");
  await page.getByRole("button", { name: "Join host", exact: true }).click();
  await expect(
    page.getByText(
      "Session key not found or expired. Check the key with the host.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => location.hash)).toBe("");
  expect(
    await page.evaluate(
      () => (window as unknown as { __guestAccess: unknown }).__guestAccess,
    ),
  ).toEqual({ usb: 0, media: 0 });
});

test("sharing keeps receiving beyond the worker window when the host animation loop is suspended", async ({
  page,
  context,
}) => {
  // The demo produces 8192 samples per 20 ms, below its declared RF rate.
  // Allow enough actual input to exceed the 32-row worker window.
  test.setTimeout(45_000);
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  const panel = await share(page);
  const link = await page
    .getByRole("link", { name: "Open guest preview" })
    .getAttribute("href");
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    (
      window as unknown as { __restoreShareAnimation: () => void }
    ).__restoreShareAnimation = () => {
      window.requestAnimationFrame = original;
    };
    window.requestAnimationFrame = () => 0;
  });
  const guest = await context.newPage();
  try {
    await guest.goto(link!);
    await guest.getByRole("button", { name: "Join host", exact: true }).click();
    await expect(guest.locator(".live-share-status")).toHaveText("Connected");
    if (process.env.BSD_E2E_SHARING_RELAY === "1")
      await expect(guest.getByTestId("share-connection-path")).toContainText(
        "TURN relay",
      );
    await expect
      .poll(
        async () =>
          Number(
            await guest.getByTestId("share-received-frames").textContent(),
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(40);
    await expect(guest.getByTestId("share-spectrum-fps")).not.toHaveText(
      "0.0 rows/s",
    );
    await guest
      .getByRole("button", { name: "Leave session", exact: true })
      .click();
    await expect(guest.locator(".live-share-status")).toHaveText(
      "Disconnected",
    );
    await expect(
      guest.getByRole("status").filter({
        hasText: "Disconnected. Ask the host for a new session key",
      }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() =>
      (
        window as unknown as { __restoreShareAnimation: () => void }
      ).__restoreShareAnimation(),
    );
    await guest.close();
  }
  await panel.getByRole("button", { name: "Close live sharing panel" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("an unavailable optional sharing service leaves the local receiver running", async ({
  page,
}) => {
  await page.route("**/api/v1/sharing", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Sharing is temporarily unavailable." }),
    }),
  );
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page
    .getByRole("button", { name: "Share live audio & spectrum", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start sharing", exact: true })
    .click();
  await expect(
    page.getByText("Sharing is temporarily unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start sharing", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Close live sharing panel", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});
