import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
// Provenance/storage scenarios do not depend on motion; dedicated overlay tests
// cover animation and dismissal with both motion preferences.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});
async function openSite(page: Page) {
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Antenna site", exact: true }).click();
}
async function manualSite(page: Page, lat = "48.1", lon = "11.7") {
  await page
    .getByLabel("Site name", { exact: true })
    .fill("Synthetic review site");
  await page.getByLabel("Latitude", { exact: true }).fill(lat);
  await page.getByLabel("Longitude", { exact: true }).fill(lon);
  await page.getByRole("button", { name: "Apply site", exact: true }).click();
  if (Number(lat) >= -90 && Number(lat) <= 90) {
    await expect(
      page.getByRole("dialog", { name: "Antenna site", exact: true }),
    ).toBeHidden();
    await page
      .getByRole("button", { name: "Antenna site", exact: true })
      .click();
  }
}
async function closeSite(page: Page) {
  await page
    .getByRole("button", { name: "Close antenna site", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Antenna site", exact: true }),
  ).toBeHidden();
}
test("antenna site is deliberate, tab-only by default, and persists only on request", async ({
  page,
}) => {
  await openSite(page);
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toHaveText("Antenna location unknown.");
  await page.getByRole("button", { name: "Apply site", exact: true }).click();
  await expect(page.locator(".antenna-site-panel[open]")).toContainText(
    "Enter both",
  );
  await manualSite(page, "91");
  await expect(page.locator(".antenna-site-panel[open]")).toContainText(
    "valid WGS84",
  );
  await manualSite(page);
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toContainText("accuracy unknown");
  await page.reload();
  await page.getByRole("button", { name: "Antenna site", exact: true }).click();
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toContainText("unknown");
  await manualSite(page);
  await page.getByLabel("Remember exact site in this browser").check();
  await page.reload();
  await page.getByRole("button", { name: "Antenna site", exact: true }).click();
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toContainText("48.1, 11.7 · manual");
  await page.getByLabel("Remember exact site in this browser").uncheck();
  await page.reload();
  await page.getByRole("button", { name: "Antenna site", exact: true }).click();
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toHaveText("Antenna location unknown.");
});
for (const scenario of [
  "denied",
  "unsupported",
  "stale",
  "invalid",
  "cancel",
] as const) {
  test(`browser location handles ${scenario} without silently replacing the site`, async ({
    page,
  }) => {
    await page.addInitScript((scenario) => {
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value:
          scenario === "unsupported"
            ? undefined
            : {
                getCurrentPosition(
                  success: (value: unknown) => void,
                  failure: (value: unknown) => void,
                ) {
                  if (scenario === "denied") {
                    failure({ code: 1 });
                    return;
                  }
                  const position = {
                    coords: {
                      latitude: scenario === "invalid" ? 999 : 49.2,
                      longitude: 12.3,
                      accuracy: 25,
                    },
                    timestamp:
                      Date.now() - (scenario === "stale" ? 600_000 : 0),
                  };
                  if (scenario === "cancel")
                    setTimeout(() => success(position), 400);
                  else success(position);
                },
              },
      });
    }, scenario);
    await openSite(page);
    await manualSite(page);
    await page
      .getByRole("button", { name: "Use my location", exact: true })
      .click();
    if (scenario === "cancel") {
      await page
        .getByRole("button", { name: "Cancel location request" })
        .click();
      await page.waitForTimeout(500); // Exercise the deliberately late callback.
    }
    if (scenario === "stale")
      await expect(
        page.locator(".antenna-site-panel[open] .antenna-site-status"),
      ).toContainText("49.2, 12.3 · browser · reported accuracy ±25 m");
    else
      await expect(
        page.locator(".antenna-site-panel[open] .antenna-site-status"),
      ).toContainText("48.1, 11.7 · manual");
    await expect(page.locator(".antenna-site-panel[open]")).toContainText(
      scenario === "stale"
        ? "stale fix"
        : scenario === "denied"
          ? "permission denied"
          : scenario === "unsupported"
            ? "unavailable here"
            : scenario === "cancel"
              ? "Request cancelled"
              : "valid WGS84",
    );
  });
}
test("capture retains its start site after edits and the survey uses an explicit copy", async ({
  page,
}) => {
  await openSite(page);
  await manualSite(page);
  await closeSite(page);
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Antenna site", exact: true }).click();
  await manualSite(page, "49.2", "12.3");
  await closeSite(page);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const files = unzipSync(await readFile((await (await download).path())!));
  const metadataEntry = Object.entries(files).find(([name]) =>
    name.endsWith(".sigmf-meta"),
  );
  expect(metadataEntry).toBeDefined();
  const metadata = JSON.parse(new TextDecoder().decode(metadataEntry![1]));
  expect(metadata.captures[0]["core:geolocation"]).toEqual({
    type: "Point",
    coordinates: [11.7, 48.1],
  });
  expect(metadata.captures[0]["browsersdr:receiver_location"]).toMatchObject({
    latitude: 48.1,
    longitude: 11.7,
    source: "manual",
    stale: false,
  });
  await page
    .getByRole("button", { name: "Discard prepared capture", exact: true })
    .click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page
    .getByLabel("Explorer activity", { exact: true })
    .selectOption("survey");
  await page
    .getByRole("button", { name: "Use receiver site", exact: true })
    .click();
  await expect(page.getByLabel("Latitude (optional)")).toHaveValue("49.2");
  await expect(page.getByLabel("Longitude (optional)")).toHaveValue("12.3");
  await expect(page.locator(".survey-profile-panel")).toContainText(
    "Site source: manual",
  );
});
test("site coordinates are omitted from ordinary settings links", async ({
  page,
}) => {
  await openSite(page);
  await manualSite(page, "48.123456", "11.654321");
  await closeSite(page);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page
    .getByRole("button", { name: "Share settings", exact: true })
    .click();
  const url = await page
    .getByRole("dialog", { name: "Share settings", exact: true })
    .getByRole("textbox")
    .inputValue();
  const encoded = url.split("#")[1]!;
  const plain = Buffer.from(
    new URLSearchParams(encoded).get("settings")!,
    "base64url",
  ).toString("utf8");
  expect(plain).not.toMatch(
    /48\.123456|11\.654321|receiverLocation|observedAt|accuracyMeters/,
  );
});

test("location request has a bounded deadline", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition() {} },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await openSite(page);
  await manualSite(page);
  await page
    .getByRole("button", { name: "Use my location", exact: true })
    .click();
  await page.clock.fastForward(20_001);
  await expect(page.locator(".antenna-site-panel[open]")).toContainText(
    "request timed out",
  );
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toContainText("48.1, 11.7 · manual");
});
test("a browser-supplied synthetic fix requires a click and preserves timestamp/accuracy", async ({
  page,
  context,
}) => {
  await context.setGeolocation({
    latitude: 47.5,
    longitude: 10.5,
    accuracy: 16,
  });
  await context.grantPermissions(["geolocation"]);
  await openSite(page);
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toHaveText("Antenna location unknown.");
  await page
    .getByRole("button", { name: "Use my location", exact: true })
    .click();
  await expect(
    page.locator(".antenna-site-panel[open] .antenna-site-status"),
  ).toContainText("47.5, 10.5 · browser · reported accuracy ±16 m");
  await expect(
    page.getByLabel("Remember exact site in this browser"),
  ).not.toBeChecked();
});
test("remote antenna sites are scoped to receiver/band and omitted from remote presets", async ({
  page,
}) => {
  await page.routeWebSocket("wss://geo.example/ws/", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      if (message.startsWith("SERVER DE CLIENT")) {
        socket.send("CLIENT DE SERVER server=openwebrx version=v1.2.126");
        socket.send(
          JSON.stringify({
            type: "config",
            value: {
              center_freq: 10000000,
              samp_rate: 192000,
              fft_size: 128,
              audio_compression: "none",
              fft_compression: "none",
              start_freq: 10000000,
              start_mod: "am",
              sdr_id: "radio",
              profile_id: "hf",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "profiles",
            value: [
              { id: "radio|hf", name: "HF" },
              { id: "radio|vhf", name: "VHF" },
            ],
          }),
        );
      } else {
        const request = JSON.parse(message);
        if (request.type === "selectprofile") {
          const profile = request.params.profile.split("|")[1];
          socket.send(
            JSON.stringify({
              type: "config",
              value: {
                center_freq: profile === "hf" ? 10000000 : 100000000,
                samp_rate: 192000,
                start_freq: profile === "hf" ? 10000000 : 100000000,
                start_mod: "am",
                sdr_id: "radio",
                profile_id: profile,
              },
            }),
          );
        }
      }
    });
  });
  await openSite(page);
  await manualSite(page);
  await closeSite(page);
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("remote");
  await page.getByLabel("Receiver website").fill("https://geo.example/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const remote = page.getByRole("dialog", {
    name: "Antenna site",
    exact: true,
  });
  const remoteTrigger = page.locator(
    "#remote-source-body .antenna-site-trigger",
  );
  await remoteTrigger.click();
  await expect(remote.locator(".antenna-site-status")).toHaveText(
    "Antenna location unknown.",
  );
  await expect(
    remote.getByRole("button", { name: "Use my location" }),
  ).toHaveCount(0);
  await remote.getByLabel("Latitude", { exact: true }).fill("-27.5");
  await remote.getByLabel("Longitude", { exact: true }).fill("152.5");
  await remote.getByRole("button", { name: "Apply site" }).click();
  await expect(remote).toBeHidden();
  await remoteTrigger.click();
  await remote.getByLabel("Remember exact site in this browser").check();
  await closeSite(page);
  await page.getByLabel("Remote band").selectOption("radio|vhf");
  await remoteTrigger.click();
  await expect(remote.locator(".antenna-site-status")).toHaveText(
    "Antenna location unknown.",
  );
  await closeSite(page);
  await page.getByLabel("Remote band").selectOption("radio|hf");
  await remoteTrigger.click();
  await expect(remote.locator(".antenna-site-status")).toContainText(
    "-27.5, 152.5 · manual",
  );
  await closeSite(page);
  await page.getByRole("button", { name: /^Remote favorites/ }).click();
  await page
    .getByRole("button", { name: "Save receiver", exact: true })
    .click();
  await page
    .getByLabel("Preset name", { exact: true })
    .fill("Synthetic remote site");
  await page
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  await page.getByRole("button", { name: "Share preset", exact: true }).click();
  const link = await page.getByLabel("Remote preset link").inputValue();
  const decoded = Buffer.from(
    new URLSearchParams(new URL(link).hash.slice(1)).get("remote")!,
    "base64url",
  ).toString("utf8");
  expect(decoded).not.toMatch(
    /-27\.5|152\.5|receiverLocation|latitude|longitude/,
  );
});

test("optional antenna controls remain usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSite(page);
  await manualSite(page);
  await page.getByLabel("Remember exact site in this browser").check();
  const bounds = await page
    .getByRole("dialog", { name: "Antenna site", exact: true })
    .boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "Use my location", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Use my location", exact: true }),
  ).toBeVisible();
});
