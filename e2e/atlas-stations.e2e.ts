import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import fixture from "../docs/implementation/atlas-settings-search/fixtures/browsersdr-station-search-v1.json" with { type: "json" };
const token = "invented-station-browser-token-".repeat(2);
async function setup(page: Page) {
  await page.addInitScript((token) => {
    localStorage.setItem("browsersdr.atlas.user-token.v1", token);
    localStorage.setItem("browsersdr-source-kind", "synthetic");
  }, token);
  const requests: string[] = [];
  let status = 200,
    offline = false,
    logins = 0;
  let releaseSlow!: () => void;
  const slow = new Promise<void>((r) => {
    releaseSlow = r;
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push(url.pathname + url.search);
    if (url.pathname === "/api/v1/session") {
      logins++;
      await route.fulfill({
        status: 201,
        json: {
          operator_id: "example-viewer",
          expires_at: "2030-01-01T00:00:00Z",
          csrf_token: "station-test-csrf",
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/me") {
      await route.fulfill({ status: 200, json: fixture.viewer });
      return;
    }
    if (offline) {
      await route.abort("internetdisconnected");
      return;
    }
    if (status !== 200) {
      await route.fulfill({
        status,
        json: {
          error: { code: "test_error", message: "private server detail" },
        },
      });
      return;
    }
    if (url.pathname.startsWith("/api/v1/stations/")) {
      await route.fulfill({ status: 200, json: fixture.pages.first.items[0] });
      return;
    }
    if (url.searchParams.get("q") === "slow") {
      await slow;
      try {
        await route.fulfill({ status: 200, json: fixture.pages.last });
      } catch {
        /* Caller intentionally cancelled this read. */
      }
      return;
    }
    const body =
      url.searchParams.get("q") === "empty"
        ? { items: [], next_cursor: null }
        : url.searchParams.has("cursor")
          ? fixture.pages.last
          : fixture.pages.first;
    await route.fulfill({ status: 200, json: body });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  const panel = page.locator(".atlas-station-search");
  await panel.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open", "");
  return {
    panel,
    requests,
    errors,
    logins: () => logins,
    releaseSlow,
    status: (value: number) => {
      status = value;
    },
    offline: () => {
      offline = true;
    },
  };
}
async function search(page: Page) {
  await page
    .locator(".atlas-station-search")
    .getByRole("button", { name: "Search stations", exact: true })
    .click();
  await expect(page.locator(".atlas-station-result").first()).toBeVisible();
}

test("Atlas station search is explicit, links safely and latches a manually started synthetic capture", async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  const p = await setup(page);
  expect(p.requests).toEqual([]);
  const before = await page
    .getByLabel("Channel frequency", { exact: true })
    .inputValue();
  await p.panel.getByLabel("Station text").fill("Example <Radio>");
  await p.panel.getByLabel("Minimum frequency (MHz)").fill("99");
  await p.panel.getByLabel("Maximum frequency (MHz)").fill("101");
  await search(page);
  expect(p.requests.at(-1)).toContain(
    "min_frequency_hz=99000000&max_frequency_hz=101000000",
  );
  expect(p.logins()).toBe(1);
  await expect(
    page.getByLabel("Channel frequency", { exact: true }),
  ).toHaveValue(before);
  const row = page.locator(".atlas-station-result").first();
  await expect(
    row.getByRole("heading", { name: "Example <Radio>" }),
  ).toBeVisible();
  expect(await row.locator("radio").count()).toBe(0);
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  await row
    .getByLabel("Transmission for Example <Radio>")
    .selectOption(fixture.pages.first.items[0]!.transmissions[0]!.id);
  await expect(
    row.getByRole("link", { name: "Open in SigIntAtlas" }),
  ).toHaveAttribute(
    "href",
    `https://sigintatlas.com/#/database/stations?station_id=${fixture.pages.first.items[0]!.id}&transmission_id=${fixture.pages.first.items[0]!.transmissions[0]!.id}`,
  );
  await expect(
    p.panel.getByRole("link", { name: "Open station list" }),
  ).toHaveAttribute("href", /q=Example\+%3CRadio%3E&min_mhz=99&max_mhz=101/);
  await row.getByRole("button", { name: "Use in receiver" }).click();
  await expect(row.getByText(/applied 150,000 Hz/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("atlas-stations-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page.getByRole("button", { name: "Start I/Q recording" }).click();
  await expect
    .poll(async () =>
      Number(
        (await page.locator(".recording-state").textContent())?.match(
          /([0-9.]+) \/ (?:32|2048) MiB/,
        )?.[1] ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  // Changing query and transmission selection while capturing does not change the latched candidate.
  await p.panel.getByLabel("Station text").fill("another query");
  await search(page);
  await row
    .getByLabel("Transmission for Example <Radio>")
    .selectOption(fixture.pages.first.items[0]!.transmissions[1]!.id);
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save to SigIntAtlas", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await pending;
  const files = unzipSync(
    new Uint8Array(await readFile((await download.path())!)),
  );
  const meta = JSON.parse(
    new TextDecoder().decode(
      Object.entries(files).find(([name]) => name.endsWith(".sigmf-meta"))![1],
    ),
  );
  expect(meta.global["browsersdr:reception"]).toMatchObject({
    source_kind: "synthetic",
    candidate: {
      station_id: fixture.pages.first.items[0]!.id,
      transmission_id: fixture.pages.first.items[0]!.transmissions[0]!.id,
      bandwidth_hz: 150000,
    },
  });
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  expect(p.errors).toEqual([]);
  expect(p.requests.some((s) => s.includes("capabilities"))).toBe(false);
});

test("Atlas station filters cancel obsolete search and reset opaque pagination", async ({
  page,
}) => {
  const p = await setup(page);
  await search(page);
  await p.panel.getByRole("button", { name: "Next stations" }).click();
  await expect(
    p.panel.getByText("Example without references", { exact: true }),
  ).toBeVisible();
  expect(p.requests.at(-1)).toContain("cursor=MQ");
  await expect(
    p.panel.getByRole("link", { name: "Open in SigIntAtlas" }),
  ).toHaveAttribute(
    "href",
    new RegExp(`station_id=${fixture.pages.last.items[0]!.id}`),
  );
  await p.panel.getByRole("button", { name: "Previous stations" }).click();
  await expect(
    p.panel.getByRole("heading", { name: "Example <Radio>" }),
  ).toBeVisible();
  await p.panel.getByLabel("Station text").fill("slow");
  await p.panel.getByRole("button", { name: "Search stations" }).click();
  await expect(p.panel.getByText("Searching SigIntAtlas…")).toBeVisible();
  await p.panel.getByLabel("Station text").fill("fresh");
  await search(page);
  p.releaseSlow();
  await expect(
    p.panel.getByText("Example without references", { exact: true }),
  ).toHaveCount(0);
  expect(p.requests.at(-1)).not.toContain("cursor");
  await p.panel.getByLabel("Station text").fill("empty");
  await p.panel.getByRole("button", { name: "Search stations" }).click();
  await expect(
    p.panel.getByText("No stations match these filters."),
  ).toBeVisible();
  await p.panel.getByRole("button", { name: "Around channel" }).click();
  expect(
    await p.panel.getByLabel("Minimum frequency (MHz)").inputValue(),
  ).not.toBe("");
  await p.panel.getByRole("button", { name: "Clear search" }).click();
  await expect(p.panel.getByLabel("Station text")).toHaveValue("");
  await expect(p.panel.getByLabel("Minimum frequency (MHz)")).toHaveValue("");
  expect(p.logins()).toBe(1);
  expect(p.errors).toEqual([]);
});

test("Atlas station viewer search and deliberate unknown-format tuning fit 390 px with continued demo reception", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await setup(page);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  await search(page);
  const row = page.locator(".atlas-station-result").first();
  await row
    .getByLabel("Transmission for Example <Radio>")
    .selectOption(fixture.pages.first.items[0]!.transmissions[2]!.id);
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  await row
    .getByLabel("Receive mode for unknown or unsupported format")
    .selectOption("AM");
  await row.getByRole("button", { name: "Use in receiver" }).click();
  await expect(row.getByText(/Receiver candidate selected/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Mode/ })).toHaveValue("AM");
  await expect(
    page.getByLabel("Channel frequency", { exact: true }),
  ).toHaveValue(/^102(?:\.0+)?$/);
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("atlas-stations-mobile.png"),
    fullPage: true,
  });
  expect(p.errors).toEqual([]);
  expect(p.logins()).toBe(1);
});

test("Atlas station permission and offline states are actionable and never poll or rotate credentials", async ({
  page,
}) => {
  const p = await setup(page);
  p.status(403);
  await p.panel.getByRole("button", { name: "Search stations" }).click();
  await expect(p.panel.getByRole("alert")).toContainText("access denied");
  expect(p.logins()).toBe(1);
  expect(p.requests).toHaveLength(3);
  p.status(404);
  await p.panel.getByRole("button", { name: "Search stations" }).click();
  await expect(p.panel.getByRole("alert")).toContainText(
    "API proxy unavailable",
  );
  p.status(200);
  p.offline();
  await p.panel.getByRole("button", { name: "Search stations" }).click();
  await expect(p.panel.getByRole("alert")).toContainText("network");
  expect(p.logins()).toBe(1);
  await p.panel.getByRole("button", { name: "Atlas settings" }).click();
  await expect(
    page.getByRole("heading", { name: "SigIntAtlas", exact: true }),
  ).toBeVisible();
  expect(p.errors).toEqual([]);
});
