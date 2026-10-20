import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { writeOfflineWorker } from "../scripts/offline-build.mjs";
import { createDeterministicRecordingFixture } from "../src/testing/recordingFixture";

// Real production assets and real service workers in both suite projects.
// The private server emulates an atomic deployment, canonical document URLs and
// no HTTP caching, independently of Vite's development-only module server.
let directory: string, origin: string, server: Server, active: string;
let broken = false,
  rejected = 0;
let requests: { path: string; build: string; broken: boolean }[] = [];
let nextVersion: string;
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

test.beforeAll(async () => {
  test.setTimeout(60_000);
  directory = await mkdtemp(join(tmpdir(), "browsersdr-offline-browser-"));
  const a = join(directory, "a"),
    b = join(directory, "b");
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--outDir", a],
    { cwd: process.cwd(), env: process.env },
  );
  const html = await readFile(join(a, "index.html"), "utf8");
  await writeFile(
    join(a, "index.html"),
    html.replace("<html", '<html data-offline-build="a"'),
  );
  await writeOfflineWorker(a);
  await cp(a, b, { recursive: true });
  await writeFile(
    join(b, "index.html"),
    html.replace("<html", '<html data-offline-build="b"'),
  );
  nextVersion = (await writeOfflineWorker(b)).version;
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname.endsWith("/index.html")) {
        response.writeHead(308, {
          Location: url.pathname.slice(0, -10) + url.search,
        });
        response.end();
        return;
      }
      const path = url.pathname.endsWith("/")
        ? url.pathname + "index.html"
        : url.pathname;
      if (path === "/sw.js" || path === "/index.html")
        requests.push({ path, build: active, broken });
      const file = resolve(active, "." + path);
      if (!file.startsWith(active + "/")) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const bytes = await readFile(file);
        response.writeHead(200, {
          "Content-Type": mime[extname(path)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        if (broken && path === "/index.html") {
          rejected++;
          response.end("bad bytes");
        } else response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Offline test server did not listen");
  origin = `http://127.0.0.1:${address.port}`;
});

test.beforeEach(() => {
  active = join(directory, "a");
  broken = false;
  rejected = 0;
  requests = [];
});
test.afterEach(async ({ context }, info) => {
  if (info.status === info.expectedStatus) return;
  const pages = await Promise.all(
    context.pages().map((page) =>
      page
        .evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return {
            url: location.href,
            controlled: Boolean(navigator.serviceWorker.controller),
            active: registration?.active?.state,
            waiting: registration?.waiting?.state,
            installing: registration?.installing?.state,
            caches: await caches.keys(),
          };
        })
        .catch((error) => String(error)),
    ),
  );
  const workers = await Promise.all(
    context
      .serviceWorkers()
      .map((worker) =>
        worker
          .evaluate(
            "({version: OFFLINE_BUILD.version, active: self.registration.active?.state, waiting: self.registration.waiting?.state, installing: self.registration.installing?.state})",
          )
          .catch((error) => String(error)),
      ),
  );
  await info.attach("offline-lifecycle-diagnostics", {
    body: JSON.stringify({ requests, pages, workers }, null, 2),
    contentType: "application/json",
  });
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) await rm(directory, { recursive: true });
});

async function prepare(page: Page) {
  await page.goto(origin + "/?browser-test=1");
  await page.getByLabel("Settings", { exact: true }).click();
  await page
    .getByRole("button", { name: "Prepare offline app", exact: true })
    .click();
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(
    page.getByText("Ready for offline use", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
}

async function startCapture(page: Page) {
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
}

test("cold offline launch retains query state and runs first-use reception and recording", async ({
  page,
  context,
}) => {
  await prepare(page);
  await page.close();
  await context.setOffline(true);
  const offline = await context.newPage();
  await offline.goto(origin + "/?browser-test=1&offline-probe=preserved");
  expect(new URL(offline.url()).searchParams.get("offline-probe")).toBe(
    "preserved",
  );
  await expect(offline.locator("html")).toHaveAttribute(
    "data-offline-build",
    "a",
  );
  await startCapture(offline);
  await expect(offline.locator(".recording-state")).not.toContainText("0.00 s");
  await offline
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(offline.locator(".capture-retention-warning")).toContainText(
    "local recording library",
  );
  await offline
    .getByRole("tab", { name: "Audio & decode", exact: true })
    .click();
  await offline.locator("#decode-panel .audio-capture-panel summary").click();
  await expect(
    offline.getByRole("button", { name: "Record audio", exact: true }),
  ).toBeEnabled();
  const guide = await context.newPage();
  await guide.goto(origin + "/getting-started/");
  await expect(guide.getByRole("heading", { level: 1 })).toBeVisible();
});

test("offline replay demodulates AM and exports actual decoded audio", async ({
  page,
  context,
}) => {
  await prepare(page);
  await context.setOffline(true);
  await page.reload();
  const fixture = createDeterministicRecordingFixture(144_000);
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("replay");
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page
    .locator(".file-picker-input")
    .nth(0)
    .setInputFiles({
      name: "offline.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.data),
    });
  await page
    .locator(".file-picker-input")
    .nth(1)
    .setInputFiles({
      name: "offline.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.metadata)),
    });
  await page.getByRole("button", { name: "Load files", exact: true }).click();
  await expect(page.locator(".file-message")).toContainText("Loaded");
  await page.getByRole("tab", { name: "Audio & decode", exact: true }).click();
  const panel = page.locator("#decode-panel .audio-capture-panel");
  await panel.locator("summary").click();
  await panel
    .getByRole("button", { name: "Record audio", exact: true })
    .click();
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByRole("button", { name: "Start replay", exact: true }).click();
  await page.getByRole("tab", { name: "Audio & decode", exact: true }).click();
  await panel.locator("summary").click();
  await expect(panel.getByRole("status")).toContainText("end of file");
  const downloading = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Download audio WAV", exact: true })
    .click();
  const wav = await readFile((await (await downloading).path())!);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  const rate = wav.readUInt32LE(24),
    frames = wav.readUInt32LE(40) / 4;
  expect(frames / rate).toBeGreaterThan(2.9);
  expect(frames / rate).toBeLessThan(3.1);
  let peak = 0;
  for (let i = 44; i < wav.length - 1; i += 2)
    peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  expect(peak).toBeGreaterThan(100);
});

test("a prepared update waits for every window while live capture and saved recordings survive", async ({
  page,
  context,
}) => {
  // This case includes two complete installs, four window lifetimes, actual
  // capture/export and retained-library recovery. Individual waits stay 7s.
  test.setTimeout(45_000);
  await prepare(page);
  await page.evaluate(() =>
    localStorage.setItem("offline-preservation-probe", "keep"),
  );
  const other = await context.newPage();
  await other.goto(origin + "/?browser-test=1");
  await startCapture(page);
  active = join(directory, "b");
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      ),
    )
    .toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-offline-build", "a");
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(page.getByText(/A new version is ready/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const files = unzipSync(await readFile((await (await download).path())!));
  const data = Object.entries(files).find(([name]) =>
    name.endsWith(".sigmf-data"),
  )![1];
  const metadata = JSON.parse(
    new TextDecoder().decode(
      Object.entries(files).find(([name]) => name.endsWith(".sigmf-meta"))![1],
    ),
  );
  expect(data.byteLength).toBeGreaterThan(0);
  expect(createHash("sha512").update(data).digest("hex")).toBe(
    metadata.global["core:sha512"],
  );
  const nextWorker = context
    .serviceWorkers()
    .find((worker) => worker !== context.serviceWorkers()[0]);
  expect(nextWorker).toBeDefined();
  expect(await nextWorker!.evaluate("OFFLINE_BUILD.version")).toBe(nextVersion);
  await page.close();
  const third = await context.newPage();
  await third.goto(origin + "/?browser-test=1");
  await expect(third.locator("html")).toHaveAttribute(
    "data-offline-build",
    "a",
  );
  await expect(other.locator("html")).toHaveAttribute(
    "data-offline-build",
    "a",
  );
  await other.close();
  await third.close();
  await expect
    .poll(() =>
      nextWorker!.evaluate(
        "!self.registration.waiting && self.registration.active?.state === 'activated'",
      ),
    )
    .toBe(true);
  await context.setOffline(true);
  const updated = await context.newPage();
  await updated.goto(origin + "/?browser-test=1");
  await expect(updated.locator("html")).toHaveAttribute(
    "data-offline-build",
    "b",
  );
  expect(
    await updated.evaluate(() =>
      localStorage.getItem("offline-preservation-probe"),
    ),
  ).toBe("keep");
  await updated
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await updated
    .getByRole("tab", { name: "Local library", exact: true })
    .click();
  await updated.locator(".recording-library summary").click();
  await expect(updated.locator(".recording-library-entry")).toHaveCount(1);
});

test("a corrupt update keeps the complete old version usable offline", async ({
  page,
  context,
}) => {
  await prepare(page);
  active = join(directory, "b");
  broken = true;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect.poll(() => rejected).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.installing ===
          null,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      async () =>
        (await navigator.serviceWorker.getRegistration())?.waiting === null,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      async () =>
        (await caches.keys()).filter((name) =>
          name.startsWith("browsersdr-offline:"),
        ).length,
    ),
  ).toBe(1);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-offline-build", "a");
  await expect(
    page.getByRole("combobox", { name: "Signal source" }),
  ).toBeVisible();
});

test("installed-window mode automatically prepares the complete offline app", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === "(display-mode: standalone)"
        ? Object.defineProperty(original(query), "matches", { value: true })
        : original(query);
  });
  await page.goto(origin + "/?browser-test=1");
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(
    page.getByText("Ready for offline use", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("browsersdr.offline.enabled.v1"),
    ),
  ).toBe("true");
  await page.screenshot({ path: info.outputPath("offline-settings.png") });
  await page.setViewportSize({ width: 390, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  const menu = page
    .locator(".header-utility-content")
    .filter({ has: page.getByRole("group", { name: "Offline app" }) });
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
  await page.screenshot({
    path: info.outputPath("offline-settings-mobile.png"),
  });
});
