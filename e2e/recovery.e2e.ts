import { expect, test, type Page } from "@playwright/test";

async function installConnectionFailures(page: Page, cancelled = false) {
  await page.addInitScript((cancel) => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "Linux" },
    });
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => {
          throw new Error("Use the test provider");
        },
      },
    });
    let attempts = 0;
    (
      window as Window & { __BROWSERSDR_TEST_CONFIG__?: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      rtlDependencies: {
        createSourceProvider: (permissionGranted: () => void) => ({
          get: async () => {
            if (++attempts === 1) {
              if (cancel)
                throw new DOMException("No device selected", "NotFoundError");
              permissionGranted();
              throw new Error(
                "Unable to claimInterface: another application may be using this device",
                {
                  cause: new DOMException(
                    "Unable to claim interface",
                    "NetworkError",
                  ),
                },
              );
            }
            permissionGranted();
            return {
              setSampleRate: async (rate: number) => rate,
              setCenterFrequency: async (frequency: number) => frequency,
              setParameter: async <V>(_parameter: string, value: V) => value,
              startReceiving: async () => undefined,
              readSamples: () => new Promise<never>(() => undefined),
              close: async () => undefined,
            };
          },
        }),
      },
    };
  }, cancelled);
}

test("connection help stays compact and recovery adapts to the chosen OS", async ({
  page,
}, testInfo) => {
  await installConnectionFailures(page);
  await page.goto("/?browser-test=1");
  const setup = page.getByLabel("Connection setup");
  await expect(setup).toBeVisible();
  await expect(setup.locator("details")).not.toHaveAttribute("open", "");
  await expect(setup.locator(":scope > p")).toHaveText(
    "Close other SDR apps before connecting.",
  );
  await page.screenshot({ path: testInfo.outputPath("connection-ready.png") });
  await setup.locator("summary").click();
  await expect(
    setup.getByText("sudo modprobe -r dvb_usb_rtl28xxu", { exact: true }),
  ).toBeVisible();
  await setup.getByLabel("Instructions for").selectOption("Windows");
  await expect(setup).toContainText("WinUSB");
  await setup.locator("summary").click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const status = page.locator(".receiver-status");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("system driver may be using it");
  await page
    .getByRole("button", { name: "Recovery help", exact: true })
    .click();
  await expect(status.locator("details")).toHaveAttribute("open", "");
  expect(
    await page
      .locator(".acquire-stage")
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(400);
  await expect(status.getByLabel("Instructions for")).toHaveValue("Windows");
  await expect(status).toContainText("WinUSB");
  await expect(status).not.toContainText("modprobe");
  await status.getByLabel("Instructions for").selectOption("Linux");
  await expect(
    status.getByRole("button", {
      name: "Copy command: sudo modprobe -r dvb_usb_rtl28xxu",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("linux-recovery.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await status.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-recovery.png"),
    fullPage: true,
  });
  await status
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(status).toContainText("RTL-SDR connected");
  await expect(page.locator(".receiver-recovery")).toHaveCount(0);
  await expect(setup).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start receiving", exact: true }),
  ).toBeEnabled();
});

test("cancelled USB chooser remains a status and can be retried", async ({
  page,
}) => {
  await installConnectionFailures(page, true);
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const status = page.locator(".receiver-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toContainText("cancelled");
  await expect(
    status.getByRole("button", { name: "Review & send report" }),
  ).toHaveCount(0);
  await expect(status.locator("details")).toHaveCount(0);
  await status.getByRole("button", { name: "Choose device again" }).click();
  await expect(status).toContainText("RTL-SDR connected");
});
