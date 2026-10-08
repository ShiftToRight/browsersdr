import { openApplicationView } from "./application-navigation";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

// Opt-in only: context contains disposable credentials from proxy-check.py.
const contextPath = process.env.BSD04_CONTEXT;
const atlasOrigin = process.env.BSD04_ATLAS_ORIGIN ?? "https://localhost:44484";
test.skip(
  !contextPath,
  "Requires isolated Atlas/proxy services; see VALIDATION.md",
);

async function settings(page: Page, token: string) {
  await openApplicationView(page, "Settings");
  const panel = page.locator(".atlas-settings-panel");
  await panel.getByLabel("Settings SigIntAtlas user token").fill(token);
  await panel.getByRole("button", { name: "Save token", exact: true }).click();
  await panel.getByRole("button", { name: "Test connection" }).click();
  await expect(panel.getByText(/Connected as BSD04/)).toBeVisible();
}

test("real Atlas proxy preserves station identity, synthetic originals and CSRF across search and upload", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile(contextPath!, "utf8"));
  expect(
    Object.values(fixture.databases).every((url) =>
      new URL(String(url)).pathname.startsWith("/signal_atlas_test_"),
    ),
  ).toBe(true);
  const receiverOrigin = new URL(testInfo.project.use.baseURL!).origin;
  for (const origin of [atlasOrigin, receiverOrigin]) {
    expect(["localhost", "127.0.0.1"].includes(new URL(origin).hostname)).toBe(
      true,
    );
  }
  const secrets = [
    fixture.operator.token,
    fixture.viewer.token,
    fixture.bootstrap,
  ];
  const requests: string[] = [];
  const diagnostics: string[] = [];
  let logins = 0;
  page.on("request", (request) => {
    requests.push(request.url());
    if (
      new URL(request.url()).pathname === "/api/v1/session" &&
      request.method() === "POST"
    )
      logins++;
  });
  await page.route("**/api/v1/diagnostic-reports", async (route) => {
    diagnostics.push(route.request().postData() ?? "");
    await route.fulfill({ json: { reference: "BR-ISOLATED-PHASE04" } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("browsersdr-source-kind", "synthetic");
  });
  await page.goto("/?browser-test=1");
  expect(logins).toBe(0);
  await settings(page, fixture.operator.token);
  expect(logins).toBe(1);
  fixture.station = await (
    await page.request.get(`/api/v1/stations/${fixture.station.id}`)
  ).json();
  await page.getByRole("tab", { name: "Receiver", exact: true }).click();
  const panel = page.locator(".atlas-station-search");
  if ((await panel.getAttribute("open")) === null) {
    await panel.locator("summary").focus();
    await page.keyboard.press("Enter");
  }
  await expect(panel).toHaveAttribute("open", "");
  await panel.getByLabel("Station text").fill("BSD04");
  await panel
    .getByRole("button", { name: "Search stations", exact: true })
    .click();
  await expect(page.locator(".atlas-station-result")).toHaveCount(50);
  await expect(page.locator(".atlas-station-result").first()).toContainText(
    "No transmission references",
  );
  await panel.getByRole("button", { name: "Next stations" }).click();
  const row = page
    .locator(".atlas-station-result")
    .filter({ hasText: fixture.station.name });
  await expect(row).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Use in receiver" }),
  ).toBeDisabled();
  await row
    .getByLabel(`Transmission for ${fixture.station.name}`)
    .selectOption(fixture.station.transmissions[0].id);
  const link = await row
    .getByRole("link", { name: "Open in SigIntAtlas" })
    .getAttribute("href");
  expect(new URL(link!).origin).toBe(atlasOrigin);
  await row.getByRole("button", { name: "Use in receiver" }).click();
  await expect(
    page.getByLabel("Channel frequency", { exact: true }),
  ).toHaveValue(/100\.000/);
  const atlas = await page.context().newPage();
  await atlas.goto(link!);
  await expect(
    atlas.getByRole("heading", { name: "Sign in to SigIntAtlas" }),
  ).toBeVisible();
  await atlas.getByLabel("Access token").fill(fixture.operator.token);
  await atlas.getByRole("button", { name: "Sign in", exact: true }).click();
  const detail = atlas.locator("#station-detail-panel");
  await expect(detail).toContainText(fixture.station.name);
  await expect(
    atlas.locator(`[data-station-row="${fixture.station.id}"]`),
  ).toHaveCount(0);
  await expect(detail.locator("[data-linked]")).toContainText("FM");
  const renamed = "Z BSD04 renamed references";
  const rename = await atlas.request.patch(
    `${atlasOrigin}/api/v1/stations/${fixture.station.id}`,
    {
      headers: {
        Authorization: `Bearer ${fixture.bootstrap}`,
        "If-Match-Version": String(fixture.station.version),
      },
      data: { name: renamed },
    },
  );
  expect(rename.status()).toBe(200);
  await atlas.reload();
  await expect(
    detail.getByRole("heading", { name: renamed, exact: true }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await atlas.goBack();
  await expect(
    detail.getByRole("heading", { name: renamed, exact: true }),
  ).toBeVisible();
  const receive = new URL(
    (await detail
      .getByRole("link", { name: /Receive/ })
      .first()
      .getAttribute("href"))!,
  );
  expect(receive.origin).toBe("https://browsersdr.com");
  // Keep production navigation untouched; remap only its origin to this isolated receiver.
  await page.goto(`${receiverOrigin}/${receive.search}&browser-test=1`);
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await expect(
    page.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeEnabled();
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
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save to SigIntAtlas", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await downloading;
  const files = unzipSync(
    new Uint8Array(await readFile((await download.path())!)),
  );
  const metaBytes = Object.entries(files).find(([name]) =>
    name.endsWith(".sigmf-meta"),
  )![1];
  const dataBytes = Object.entries(files).find(([name]) =>
    name.endsWith(".sigmf-data"),
  )![1];
  const metadata = JSON.parse(new TextDecoder().decode(metaBytes));
  expect(metadata.global["browsersdr:reception"]).toMatchObject({
    source_kind: "synthetic",
    candidate: {
      station_id: fixture.station.id,
      transmission_id: fixture.station.transmissions[0].id,
    },
  });
  await page.getByLabel(/Analyze after save/).uncheck();
  let releasePart!: () => void;
  const hold = new Promise<void>((resolve) => {
    releasePart = resolve;
  });
  let blocked = false;
  let partSeen!: () => void;
  const partStarted = new Promise<void>((resolve) => {
    partSeen = resolve;
  });
  const csrf = new Set<string>();
  await page.route("**/api/v1/uploads/*/parts/*", async (route) => {
    if (route.request().method() === "PUT") {
      csrf.add(route.request().headers()["x-csrf-token"]!);
      if (!blocked) {
        blocked = true;
        partSeen();
        await hold;
      }
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Save to SigIntAtlas", exact: true })
    .click();
  await partStarted;
  const beforeSearch = logins;
  if ((await panel.getAttribute("open")) === null)
    await panel.locator("summary").click();
  await panel.getByLabel("Station text").fill("Z BSD04");
  await panel
    .getByRole("button", { name: "Search stations", exact: true })
    .click();
  await expect(page.locator(".atlas-station-result")).toHaveCount(1);
  expect(logins).toBe(beforeSearch);
  releasePart();
  await expect(page.locator(".atlas-save-panel .atlas-connection")).toHaveText(
    "Saved",
    { timeout: 60_000 },
  );
  expect(csrf.size).toBe(1);
  expect(csrf.has(undefined as unknown as string)).toBe(false);
  const savedHref = await page
    .getByRole("link", { name: "Confirm reception in SigIntAtlas" })
    .getAttribute("href");
  const saved = new URL(savedHref!, receiverOrigin);
  const recordingId = saved.hash.split("?")[0]!.split("/").at(-1)!;
  const recording = await page.request.get(`/api/v1/recordings/${recordingId}`);
  expect(recording.status()).toBe(200);
  const body = await recording.json();
  expect(body).toMatchObject({
    storage_verified: true,
    source_kind: "synthetic",
  });
  for (const [role, expected] of [
    ["data", dataBytes],
    ["metadata", metaBytes],
  ] as const) {
    const response = await page.request.get(
      `/api/v1/recordings/${recordingId}/files/${role}`,
    );
    expect(response.status()).toBe(200);
    expect(
      Buffer.from(await response.body()).equals(Buffer.from(expected)),
    ).toBe(true);
  }
  // Legacy recording links intentionally retain their existing destination policy.
  await atlas.goto(`${atlasOrigin}/${saved.hash}`);
  const form = atlas.locator("#reception-form");
  await expect(form).toBeVisible();
  await expect(atlas.locator(".reception-workflow")).toContainText(
    "Synthetic source",
  );
  await expect(form.getByLabel("Reception service (candidate)")).toHaveValue(
    fixture.station.id,
  );
  // Receiver intent must not silently attribute a physical transmitter.
  await expect(form.getByLabel("Catalog assignment (optional)")).toHaveValue(
    "",
  );
  await expect(
    form
      .getByLabel("Catalog assignment (optional)")
      .locator(`option[value="${fixture.station.transmissions[0].id}"]`),
  ).toHaveCount(1);
  await form.getByLabel("Identity decision").selectOption("reviewed");
  await form
    .getByLabel("Reception rationale")
    .fill(
      "Automated synthetic fixture: verifies exclusion, not real RF reception.",
    );
  await form.getByRole("button", { name: "Save reception decision" }).click();
  await expect(atlas.locator(".reception-decision-receipt")).toBeVisible();
  const summary = await page.request.get(
    `/api/v1/stations/${fixture.station.id}`,
  );
  const history = (await summary.json()).reception;
  expect(history.last_reviewed_reception_at).toBeNull();
  expect(history.excluded_reviewed_count).toBeGreaterThan(0);
  await openApplicationView(page, "Diagnostics");
  await page
    .getByRole("button", { name: "Create diagnostic report", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const reportDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download JSON" }).click();
  const report = await readFile((await (await reportDownload).path())!, "utf8");
  const inspected = [
    report,
    new TextDecoder().decode(metaBytes),
    ...requests,
    ...diagnostics,
    savedHref!,
    receive.href,
    link!,
  ].join("\n");
  expect(secrets.some((secret) => inspected.includes(secret))).toBe(false);
  expect([...csrf].some((secret) => inspected.includes(secret))).toBe(false);
  await atlas.close();
});

test("real revoked viewer access and failed logout preserve local downloads and synchronize token replacement", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = JSON.parse(await readFile(contextPath!, "utf8"));
  expect(
    Object.values(fixture.databases).every((url) =>
      new URL(String(url)).pathname.startsWith("/signal_atlas_test_"),
    ),
  ).toBe(true);
  expect(new URL(atlasOrigin).hostname).toBe("localhost");
  const auth = { Authorization: `Bearer ${fixture.bootstrap}` };
  const created = await page.request.post(`${atlasOrigin}/api/v1/admin/users`, {
    headers: auth,
    data: { display_name: "BSD04 revoked viewer", role: "viewer" },
  });
  expect(created.status()).toBe(201);
  const user = await created.json();
  const issued = await page.request.post(`${atlasOrigin}/api/v1/admin/tokens`, {
    headers: auth,
    data: { user_id: user.id, label: "Disposable failure fixture" },
  });
  expect(issued.status()).toBe(201);
  const credential = await issued.json();
  let logins = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v1/session" &&
      request.method() === "POST"
    )
      logins++;
  });
  await page.goto("/?browser-test=1");
  await settings(page, credential.token);
  await expect(page.locator(".atlas-settings-panel")).toContainText(
    "Viewer access is read-only",
  );
  await page.getByRole("tab", { name: "Receiver", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
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
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save to SigIntAtlas", exact: true }),
  ).toBeDisabled();
  const downloadBytes = async () => {
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download ZIP", exact: true })
      .click();
    return readFile((await (await pending).path())!);
  };
  const before = await downloadBytes();
  const panel = page.locator(".atlas-station-search");
  await panel.locator("summary").click();
  await panel.getByLabel("Station text").fill("Z BSD04");
  await panel
    .getByRole("button", { name: "Search stations", exact: true })
    .click();
  await expect(page.locator(".atlas-station-result")).toHaveCount(1);
  const revoke = await page.request.post(
    `${atlasOrigin}/api/v1/admin/tokens/${credential.credential.id}/revoke`,
    { headers: auth },
  );
  expect(revoke.status()).toBe(200);
  await panel
    .getByRole("button", { name: "Search stations", exact: true })
    .click();
  await expect(panel).toContainText("Token rejected or session expired");
  await expect(page.locator(".atlas-station-result")).toHaveCount(0);
  expect(logins).toBe(2); // One explicit login, then at most one coordinated read reauthentication.
  expect((await downloadBytes()).equals(before)).toBe(true);
  await settings(page, fixture.operator.token);
  await page.route("**/api/v1/session", async (route) => {
    if (route.request().method() === "DELETE")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  const settingsPanel = page.locator(".atlas-settings-panel");
  await settingsPanel
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(settingsPanel).toContainText("logout could not be confirmed");
  expect(
    (await settingsPanel
      .getByLabel("Settings SigIntAtlas user token")
      .inputValue()) === fixture.operator.token,
  ).toBe(true);
  await settingsPanel
    .getByRole("button", { name: "Forget token", exact: true })
    .click();
  await expect(
    settingsPanel.getByLabel("Settings SigIntAtlas user token"),
  ).toHaveValue("");
  await page.unroute("**/api/v1/session");
  const replacement = await page.context().newPage();
  await replacement.goto("/?browser-test=1");
  await openApplicationView(replacement, "Settings");
  await replacement
    .getByLabel("Settings SigIntAtlas user token")
    .fill(fixture.operator.token);
  const loginCount = logins;
  await replacement
    .getByRole("button", { name: "Save token", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await settingsPanel
          .getByLabel("Settings SigIntAtlas user token")
          .inputValue()) === fixture.operator.token,
    )
    .toBe(true);
  expect(logins).toBe(loginCount);
  await replacement.close();
  await page.getByRole("tab", { name: "Receiver", exact: true }).click();
  expect((await downloadBytes()).equals(before)).toBe(true);
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
});
