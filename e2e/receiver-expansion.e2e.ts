import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { installHackrfUsb } from "./hackrf-usb-fixture";

async function installRtl(page: Page) {
  await page.addInitScript(() => {
    const state = {
      opens: 0,
      closes: 0,
      parameters: [] as [string, unknown][],
      centers: [] as number[],
    };
    (
      window as unknown as { __receiverExpansion: typeof state }
    ).__receiverExpansion = state;
    Object.defineProperty(navigator, "usb", { configurable: true, value: {} });
    let rate = 1_024_000,
      frequency = 100e6,
      nextAt = 0,
      sample = 0;
    (
      window as unknown as { __BROWSERSDR_TEST_CONFIG__: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      rtlDependencies: {
        createSourceProvider: (
          permission: () => void,
          capture: (bytes: ArrayBuffer) => void,
        ) => ({
          get: async () => {
            ++state.opens;
            permission();
            return {
              setSampleRate: async (value: number) => {
                rate = value;
                return value;
              },
              setCenterFrequency: async (value: number) => {
                frequency = value;
                state.centers.push(value);
                if (state.centers.length > 64) state.centers.shift();
                return value;
              },
              setParameter: async <T>(name: string, value: T) => {
                state.parameters.push([name, value]);
                if (state.parameters.length > 64) state.parameters.shift();
                return value;
              },
              startReceiving: async () => {
                nextAt = performance.now();
              },
              readSamples: (count: number) => {
                const center = frequency;
                nextAt =
                  Math.max(nextAt, performance.now()) + (count / rate) * 1000;
                return new Promise((resolve) =>
                  setTimeout(
                    () => {
                      const I = new Float32Array(count),
                        Q = new Float32Array(count),
                        bytes = new Uint8Array(count * 2);
                      for (let i = 0; i < count; i++) {
                        const t = (sample + i) / rate,
                          a =
                            0.3 * (1 + 0.5 * Math.cos(2 * Math.PI * 1000 * t)),
                          phase = 2 * Math.PI * 100000 * t;
                        const re = a * Math.cos(phase),
                          im = a * Math.sin(phase);
                        bytes[2 * i] = Math.max(
                          0,
                          Math.min(255, Math.round(re * 128 + 127.5)),
                        );
                        bytes[2 * i + 1] = Math.max(
                          0,
                          Math.min(255, Math.round(im * 128 + 127.5)),
                        );
                        I[i] = (bytes[2 * i]! - 127.5) / 128;
                        Q[i] = (bytes[2 * i + 1]! - 127.5) / 128;
                      }
                      sample += count;
                      capture(bytes.buffer);
                      resolve({ I, Q, frequency: center });
                    },
                    Math.max(0, nextAt - performance.now()),
                  ),
                );
              },
              close: async () => {
                ++state.closes;
              },
            };
          },
        }),
      },
    };
  });
}
async function startRtl(page: Page) {
  await installRtl(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Mode", exact: true })
    .selectOption("AM");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(page.locator(".receiver-status")).toContainText(/Receiving/i);
}
test("declared HF input and converter controls remain passive until connection and preserve translated RF coordinates", async ({
  page,
}) => {
  await installRtl(page);
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: /^RF input & power/ }).click();
  await page.getByLabel("Declared RTL board").selectOption("nesdr-smart-v5");
  await page.getByLabel("HF input", { exact: true }).selectOption("q");
  await expect(page.getByLabel("Converter offset (Hz)")).toBeDisabled();
  await page
    .getByRole("dialog", { name: "RF input & power", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "RF input & power", exact: true }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __receiverExpansion: { opens: number } })
            .__receiverExpansion.opens,
      ),
    )
    .toBe(0);
  await page
    .getByRole("combobox", { name: "Mode", exact: true })
    .selectOption("AM");
  await page
    .getByRole("spinbutton", { name: "Channel frequency", exact: true })
    .fill("4.583");
  await expect(
    page.getByRole("spinbutton", { name: "Channel frequency", exact: true }),
  ).toHaveValue("4.583");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __receiverExpansion: { parameters: [string, unknown][] };
            }
          ).__receiverExpansion.parameters,
      ),
    )
    .toContainEqual(["direct_sampling_method", 2]);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: /^RF input & power/ }).click();
  await page.getByLabel("HF input", { exact: true }).selectOption("off");
  await page.getByLabel("Converter offset (Hz)").fill("125000000");
  await page
    .getByRole("dialog", { name: "RF input & power", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "RF input & power", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __receiverExpansion: { centers: number[] } }
        ).__receiverExpansion.centers.at(-1),
      ),
    )
    .toBe(129583000);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});
test("two audio VFOs share a single USB owner, reject out-of-window tuning and stop cleanly", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startRtl(page);
  await page.getByText("Second audio channel · VFO B", { exact: true }).click();
  await page.getByLabel("VFO B mode", { exact: true }).selectOption("AM");
  await page.getByLabel("VFO B frequency (MHz)").fill("100.1");
  await page.getByRole("button", { name: "Enable VFO B", exact: true }).click();
  await expect(page.locator(".receiver-vfo-tools")).toContainText(
    "VFO B receiving 100.100000 MHz · AM",
  );
  await page.getByLabel("VFO B frequency (MHz)").fill("110");
  await page.getByRole("button", { name: "Apply VFO B", exact: true }).click();
  await expect(page.locator(".receiver-vfo-tools")).toContainText(
    "must fit inside the current RF capture",
  );
  await expect(page.locator(".receiver-vfo-tools")).toContainText(
    "VFO B receiving 100.100000 MHz",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __receiverExpansion: { opens: number } })
            .__receiverExpansion.opens,
      ),
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Disable VFO B", exact: true })
    .click();
  await expect(page.locator(".receiver-vfo-tools")).toContainText("VFO B off");
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
  expect(errors).toEqual([]);
});
test("watch channels retains a real bounded native event capture and restores the original channel on Stop", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await startRtl(page);
  await page.getByRole("tab", { name: "Watch", exact: true }).click();
  await page.getByLabel("Watch frequencies (MHz)").fill("100.1\n100.2");
  await page.getByLabel("Dwell (ms)", { exact: true }).fill("500");
  await page.getByLabel("Maximum activity hold (ms)").fill("0");
  await page.getByLabel("Capture native I/Q on an activity event").check();
  await page.getByLabel("Pre-trigger seconds").fill("0.1");
  await page.getByLabel("Post-trigger seconds").fill("0.1");
  await page
    .getByRole("button", { name: "Start watching", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Download event 1 SigMF ZIP",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop watching", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop watching", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue("AM");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download event 1 SigMF ZIP", exact: true })
    .click();
  const download = await downloadPromise;
  const zip = unzipSync(await readFile((await download.path())!));
  const name = Object.keys(zip).find((key) => key.endsWith(".sigmf-meta"))!;
  const metadata = JSON.parse(new TextDecoder().decode(zip[name]!));
  expect(metadata.global["core:sample_rate"]).toBe(1024000);
  expect(metadata.global["core:description"]).toContain("Activity-triggered");
  const data =
    zip[Object.keys(zip).find((key) => key.endsWith(".sigmf-data"))!]!;
  expect(metadata.global["core:sha512"]).toBe(
    createHash("sha512").update(data).digest("hex"),
  );
  expect(data.length).toBeGreaterThan(100000);
  expect(data.length).toBeLessThanOrEqual(16 * 1024 * 1024);
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
});
test("HackRF power controls issue a deliberate request and reset the saved default", async ({
  page,
}) => {
  await installHackrfUsb(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("hackrf");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /^RF input & power/ }).click();
  await page
    .getByRole("checkbox", { name: "HackRF antenna power", exact: true })
    .check();
  await expect(
    page.getByRole("checkbox", { name: "HackRF antenna power", exact: true }),
  ).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __hackrf: { device: { radio: Map<number, bigint> } };
          }
        ).__hackrf.device.radio
          .get(20)
          ?.toString(),
      ),
    )
    .toBe("1");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("browsersdr.source.v1.hackrf")!)
          .hardwareSettings.antennaPowerEnabled,
    ),
  ).toBe(false);
  await page
    .getByRole("dialog", { name: "RF input & power", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "RF input & power", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: /^RF input & power/ }).click();
  await expect(
    page.getByRole("checkbox", { name: "HackRF antenna power", exact: true }),
  ).not.toBeChecked();
});
test("receiver tools remain usable without horizontal overflow on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRtl(page);
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: /^RF input & power/ }).click();
  await expect(page.getByLabel("Declared RTL board")).toBeVisible();
  await page.screenshot({
    path: "../evidence/receiver-tools-narrow.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("VFO B I/Q recording keeps its channel metadata while VFO A continues independently", async ({
  page,
}) => {
  test.setTimeout(30000);
  await startRtl(page);
  await page.getByText("Second audio channel · VFO B", { exact: true }).click();
  await page.getByLabel("VFO B mode", { exact: true }).selectOption("AM");
  await page.getByLabel("VFO B frequency (MHz)").fill("100.1");
  await page.getByRole("button", { name: "Enable VFO B", exact: true }).click();
  await expect(page.locator(".receiver-vfo-tools")).toContainText(
    "VFO B receiving",
  );
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page
    .getByLabel("I/Q recording channel", { exact: true })
    .selectOption("B");
  await page.getByLabel("Capture current channel only").uncheck();
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".recording-state").textContent())?.match(
          /([0-9.]+) \/ (?:32|2048) MiB/,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0.1);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await downloadPromise,
    zip = unzipSync(await readFile((await download.path())!));
  const json = Object.keys(zip).find((name) => name.endsWith(".json"))!;
  const metadata = JSON.parse(new TextDecoder().decode(zip[json]!));
  expect(metadata.selectedChannelFrequencyHz).toBe(100100000);
  expect(metadata.centerFrequencyHz).toBe(100000000);
  expect(metadata.mode).toBe("AM");
  expect(
    Number(
      await page
        .getByRole("spinbutton", { name: "Channel frequency", exact: true })
        .inputValue(),
    ),
  ).toBe(100);
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
});

test("leaving Receiver cancels a channel watch before Explorer can acquire the receiver", async ({
  page,
}) => {
  await startRtl(page);
  await page.getByRole("tab", { name: "Watch", exact: true }).click();
  await page.getByLabel("Watch frequencies (MHz)").fill("100.1\n100.2");
  await page
    .getByRole("button", { name: "Start watching", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop watching", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByRole("tab", { name: "Receiver", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop watching", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start watching", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveValue("AM");
  await page
    .getByRole("button", { name: "Stop receiving", exact: true })
    .click();
});

test("RF health uses fresh samples and gain setup requires a declared continuous signal", async ({
  page,
}) => {
  await startRtl(page);
  await page.getByRole("button", { name: /^Reception health/ }).click();
  const setup = page.getByRole("button", {
    name: "Set input headroom",
    exact: true,
  });
  await expect(setup).toBeDisabled();
  await expect(
    page
      .getByRole("dialog", { name: "Reception health", exact: true })
      .locator(".health-metrics"),
  ).toContainText(/-?\d+\.\d dB relative/);
  const gainCount = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __receiverExpansion: { parameters: [string, unknown][] };
          }
        ).__receiverExpansion.parameters.filter(([name]) => name === "gain")
          .length,
    );
  const before = await gainCount();
  await page
    .getByRole("checkbox", {
      name: "I am using a continuous signal for gain setup",
      exact: true,
    })
    .check();
  await setup.click();
  await expect(
    page.getByRole("dialog", { name: "Reception health", exact: true }),
  ).toContainText("Input headroom is in range");
  expect(await gainCount()).toBe(before);
});

test("receiver tools follow workflow placement, typography and theme across desktop and phone", async ({
  page,
}) => {
  await installRtl(page);
  await page.goto("/?browser-test=1");
  const acquire = page.locator("#source-stage-body"),
    tuning = page.locator("#channel-stage-body");
  await expect(
    acquire.getByText("Second audio channel · VFO B", { exact: true }),
  ).toHaveCount(0);
  await expect(
    tuning.getByText("Second audio channel · VFO B", { exact: true }),
  ).toBeVisible();
  await expect(acquire.getByLabel("Watch frequencies (MHz)")).toHaveCount(0);
  await expect(page.locator(".graphics-panel .status-pill")).toHaveCount(0);
  await page.getByRole("button", { name: /^Reception health/ }).click();
  const health = page.getByRole("dialog", {
    name: "Reception health",
    exact: true,
  });
  const fonts = await health.evaluate((el) => ({
    heading: parseFloat(getComputedStyle(el.querySelector("h3")!).fontSize),
    body: parseFloat(getComputedStyle(el.querySelector("p")!).fontSize),
  }));
  expect(fonts.body).toBeLessThanOrEqual(fonts.heading);
  expect(fonts.body).toBe(12);
  const toggle = health.getByRole("checkbox", {
    name: "I am using a continuous signal for gain setup",
    exact: true,
  });
  await toggle.check();
  await expect(toggle).toBeChecked();
  for (const theme of [
    "Midnight Observatory",
    "Amber Field Deck",
    "Vice Afterglow",
  ]) {
    await health.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByLabel("Settings", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "Theme", exact: true })
      .selectOption({ label: theme });
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByRole("button", { name: /^Reception health/ }).click();
    const color = await health
      .locator(".receiver-switch-track")
      .evaluate((el) => ({
        actual: getComputedStyle(el, "::after").backgroundColor,
        expected: getComputedStyle(document.documentElement)
          .getPropertyValue("--cyan")
          .trim(),
      }));
    expect(color.actual).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: `../ui-refinement-20261024/health-${theme.split(" ")[0]!.toLowerCase()}.png`,
      fullPage: true,
    });
  }
  await health.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("tab", { name: "Watch", exact: true }).click();
  await page.getByLabel("Watch frequencies (MHz)").fill("145.5, 145.55");
  await page.getByRole("tab", { name: "Audio & decode", exact: true }).click();
  await page.getByRole("tab", { name: "Watch", exact: true }).click();
  await expect(page.getByLabel("Watch frequencies (MHz)")).toHaveValue(
    "145.5, 145.55",
  );
  await expect(
    page.getByRole("button", { name: "Start watching", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "../ui-refinement-20261024/watch-desktop.png",
    fullPage: true,
  });
  await page.locator(".receiver-status-menu > summary").click();
  const display = page
    .locator(".receiver-health-panel")
    .getByRole("button", { name: /^Display:/ });
  await expect(display).toBeVisible();
  await expect(display).not.toHaveClass(/is-working/);
  expect(
    await display.evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toBe("none");
  await page.screenshot({
    path: "../ui-refinement-20261024/display-status.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await expect(page.getByLabel("Watch frequencies (MHz)")).toBeVisible();
  await page.screenshot({
    path: "../ui-refinement-20261024/watch-phone.png",
    fullPage: true,
  });
});
