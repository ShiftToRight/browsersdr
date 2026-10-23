import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { monitorHistory } from "./helpers/monitorHistory";
import type { MonitorSession } from "../src/radio/signalMonitor";

async function installSignalFixture(page: Page, dynamicClipping = false) {
  const source = (
    await Promise.all(
      ["src/testing/rdsFixture.ts", "src/testing/intelligenceRfFixture.ts"].map(
        (path) => readFile(path, "utf8"),
      ),
    )
  )
    .join("\n")
    .replace(/^export /gm, "");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  await page.addInitScript({
    content: `${javascript}\nglobalThis.__RF_TEST_AMPLITUDE__ = 0.65;\ninstallIntelligenceRfFixture(createRdsMultiplexFixture({ sampleRate: 336000, programmeService: 'TEST FM', radioText: 'Generated RF fixture', pilotAmplitude: 0.08 }), ${dynamicClipping ? "() => globalThis.__RF_TEST_AMPLITUDE__" : "() => 0.65"});`,
  });
}
async function openReceiver(page: Page, dynamicClipping = false) {
  await installSignalFixture(page, dynamicClipping);
  await page.goto("/?browser-test=1");
  await page.getByLabel("Channel frequency", { exact: false }).fill("100");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(page.locator(".receiver-status")).toHaveClass(
    /receiver-status-running/,
  );
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
}

for (const initiallyRunning of [false, true]) {
  test(`Investigate in Receiver tunes and receives from ${initiallyRunning ? "running" : "connected paused"} reception`, async ({
    page,
  }) => {
    await installSignalFixture(page);
    await monitorHistory(page);
    await page.getByRole("tab", { name: "Receiver", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start receiving", exact: true }),
    ).toBeEnabled();
    if (initiallyRunning) {
      await page
        .getByRole("button", { name: "Start receiving", exact: true })
        .click();
      await expect(page.locator(".receiver-status")).toHaveClass(
        /receiver-status-running/,
      );
    }
    await page.getByRole("tab", { name: "Explorer", exact: true }).click();
    await page.locator(".monitor-frequency").first().click();
    await page
      .getByRole("button", { name: "Investigate in Receiver", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Receiver", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".receiver-status")).toHaveClass(
      /receiver-status-running/,
    );
    await expect(
      page.getByLabel("Channel frequency", { exact: false }),
    ).toHaveValue("914.750");
    await expect(
      page.getByRole("button", { name: "Stop receiving", exact: true }),
    ).toBeEnabled();
  });
}

test("Explorer automatically refines actual generated RF and proposes WBFM from checked RDS", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openReceiver(page);
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page.getByLabel("Detection preset").selectOption("fm-balanced");
  await page.getByLabel("Analyze signals after 3 sweeps").check();
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  const analysis = page.getByRole("region", {
    name: "Intelligent signal analysis",
    exact: true,
  });
  await expect(page.locator(".monitor-message")).toContainText(
    "Discovery sweep",
  );
  await expect(page.locator(".monitor-control-state .status-pill")).toHaveText(
    "Analyzing signals",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("monitor-sweeps")).toHaveText("3");
  const stopAnalysis = page.getByRole("button", {
    name: "Pause monitoring",
    exact: true,
  });
  await expect(page.locator(".monitor-control-state").first()).toContainText(
    "Pause monitoring",
  );
  const sidebar = await page
    .getByRole("region", { name: "Monitoring & analysis", exact: true })
    .boundingBox();
  expect((await stopAnalysis.boundingBox())!.width).toBeLessThan(
    sidebar!.width,
  );
  expect((await stopAnalysis.boundingBox())!.width).toBeLessThan(300);
  await expect(
    page.locator(".monitor-workspace > .input-clipping-slot"),
  ).toHaveCount(0);
  await expect(
    page.locator(".monitor-sidebar-status > .input-clipping-slot"),
  ).toHaveCount(1);

  await expect(page.locator(".monitor-message")).toContainText("Analyzing");
  await expect(
    page.getByRole("region", { name: "Band spectrum overview" }),
  ).toContainText("100% retained range measured");
  await page.locator(".monitor-intelligent-tools > summary").click();
  await expect(page.locator(".monitor-signal-table")).toContainText(
    "RDS: TEST FM",
    { timeout: 60_000 },
  );
  await expect(analysis).toContainText("Analysis finished", {
    timeout: 20_000,
  });
  // Positive decoder evidence is visible even if repeat detection is still tentative.
  await expect(page.locator(".monitor-signal-table")).toContainText(
    "RDS: TEST FM",
  );
  await expect(
    page.locator(".monitor-marker-intelligence").filter({ hasText: "TEST FM" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Show all detection markers", { exact: false }),
  ).not.toBeChecked();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("browsersdr.signalAnalysis.v1")!),
  );
  const decoded = saved.records.find(
    (r: { result?: { stableProgrammeService?: string } }) =>
      r.result?.stableProgrammeService === "TEST FM",
  );
  expect(decoded.result.rds.validGroups).toBeGreaterThanOrEqual(8);
  expect(decoded.result.resolutionHz).toBe(62.5);
  expect(decoded.result.suggestedMode).toBe("WBFM");
  expect(
    saved.records.some(
      (r: { result?: { suggestedMode?: string } }) => !r.result?.suggestedMode,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("intelligent-spectrum.png"),
    fullPage: true,
  });
  await analysis.locator(".signal-analysis-export > summary").click();
  const download = page.waitForEvent("download");
  await analysis.getByRole("button", { name: "Export analysis JSON" }).click();
  const exported = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(exported.records).toHaveLength(saved.records.length);
  await page
    .locator(`tr[data-signal-id="${decoded.candidate.id}"] .monitor-frequency`)
    .click();
  await page
    .getByRole("complementary", {
      name: "Selected signal details",
      exact: true,
    })
    .getByRole("button", { name: "Use WBFM + RDS", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Receiver", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("finite survey analysis can be cancelled without losing completed detections", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openReceiver(page);
  await page.getByLabel("Analyze signals after scan").check();
  await page
    .getByRole("button", { name: "Scan current window", exact: true })
    .click();
  const analysis = page.getByRole("region", {
    name: "Intelligent signal analysis",
    exact: true,
  });
  await expect(
    analysis.getByRole("button", { name: "Stop analysis" }),
  ).toBeVisible({ timeout: 15_000 });
  await analysis.getByRole("button", { name: "Stop analysis" }).click();
  await expect(analysis).toContainText("Analysis stopped", { timeout: 10_000 });
  await expect(
    analysis.getByRole("button", { name: "Analyze all signals" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Scan current window", exact: true }),
  ).toBeEnabled();
  expect(await page.locator(".candidate-review-card").count()).toBeGreaterThan(
    0,
  );
});

test("manual analysis owns the receiver and blocks capture until cancellation completes", async ({
  page,
}) => {
  await openReceiver(page);
  await page
    .getByRole("button", { name: "Scan current window", exact: true })
    .click();
  await expect(page.locator(".candidate-review-card").first()).toBeVisible();
  await page.getByLabel("Select all candidates", { exact: true }).check();
  const capture = page.getByRole("button", { name: /Capture selected/ });
  await expect(capture).toBeEnabled();
  const analysis = page.getByRole("region", {
    name: "Intelligent signal analysis",
    exact: true,
  });
  await analysis.getByRole("button", { name: "Analyze all signals" }).click();
  await expect(capture).toBeDisabled();
  await expect(page.getByLabel("Explorer activity")).toBeDisabled();
  await analysis.getByRole("button", { name: "Stop analysis" }).click();
  await expect(capture).toBeEnabled();
  await expect(page.getByLabel("Explorer activity")).toBeEnabled();
});

test("monitor analysis exposes foreground progress and cancellation after three generic sweeps", async ({
  page,
}) => {
  await openReceiver(page);
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.getByLabel("Detection preset")).toHaveValue("general");
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("range");
  await page.getByLabel("Range start", { exact: true }).fill("99.5 MHz");
  await page.getByLabel("Range end", { exact: true }).fill("100.9 MHz");
  await page.getByLabel("Analyze signals after 3 sweeps").check();
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  const stop = page.getByRole("button", {
    name: "Pause monitoring",
    exact: true,
  });
  await expect(page.locator(".monitor-control-state .status-pill")).toHaveText(
    "Analyzing signals",
    { timeout: 15_000 },
  );
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("monitor-sweeps")).toHaveText("3");
  await expect(
    page.getByRole("region", { name: "Band spectrum overview" }),
  ).toContainText("100% retained range measured");
  await expect(page.locator(".monitor-metrics")).toContainText("Original grid");
  await expect(page.locator(".monitor-metrics")).toContainText("2 / 2");
  await expect(page.locator(".monitor-control-state .status-pill")).toHaveText(
    "Analyzing signals",
  );
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toHaveCount(0);
  const footprint = page.getByTestId("monitor-current-receiver");
  const probe = page.getByTestId("monitor-current-probe");
  await expect(footprint).toBeVisible();
  await expect(probe).toHaveAttribute("data-phase", "measuring");
  await expect(page.locator(".monitor-receiver-readout")).toContainText(
    "Analyzing",
  );
  expect(Number(await footprint.getAttribute("data-center-hz"))).not.toBe(
    Number(await probe.getAttribute("data-frequency-hz")),
  );
  await stop.click();
  await expect(probe).toHaveCount(0);
  await expect(footprint).toBeVisible();
  await page.locator(".monitor-intelligent-tools > summary").click();
  await expect(page.locator(".monitor-message")).toContainText("cycle paused");
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".monitor-control-state .status-pill")).toHaveText(
    "paused",
  );
  await expect(page.locator(".monitor-metrics")).toContainText("2 / 2");
});

test("restored decoder evidence stays visible without promoting tentative tracks and the overlay retains all markers", async ({
  page,
}) => {
  // Persisted presentation fixture only: this case does not claim RF decoding.
  await monitorHistory(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("browsersdr-monitoring", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise<MonitorSession>((resolve, reject) => {
      const request = db
        .transaction("sessions")
        .objectStore("sessions")
        .get("latest");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const candidate = session.signals.find((s) => !s.confirmed)!;
    session.signals.push({
      ...candidate,
      id: "retained-unknown",
      frequencyHz: 915.265e6,
      lowerFrequencyHz: 915.26e6,
      upperFrequencyHz: 915.27e6,
      peakFrequencyHz: 915.265e6,
    });
    localStorage.setItem(
      "browsersdr.signalAnalysis.v1",
      JSON.stringify({
        version: 1,
        sessionKey: session.id,
        records: [
          {
            candidate: {
              id: candidate.id,
              frequencyHz: candidate.frequencyHz,
              bandwidthHz: candidate.bandwidthHz,
            },
            at: new Date().toISOString(),
            result: {
              version: 1,
              status: "complete",
              frequencyHz: candidate.frequencyHz,
              sampledSeconds: 2,
              resolutionHz: 62.5,
              label: "RDS: UI TEST",
              reasons: ["Persisted presentation fixture"],
              stableProgrammeService: "UI TEST",
              suggestedMode: "WBFM",
              rds: { pi: "C201", validGroups: 16 },
            },
          },
        ],
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session, "latest");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(17);
  const decoded = page
    .locator(".monitor-signal-table tbody tr")
    .filter({ hasText: "RDS: UI TEST" });
  await expect(decoded).toContainText("Tentative");
  await expect(page.locator(".monitor-metrics")).toContainText("16 / 18");
  await expect(page.locator(".monitor-metrics")).toContainText(
    "1 signals · separate from repeat confirmation",
  );
  const markerCount = () =>
    page
      .getByTestId("monitor-detection-marker")
      .evaluateAll((nodes) =>
        nodes.reduce(
          (sum, node) => sum + Number(node.getAttribute("data-count")),
          0,
        ),
      );
  expect(await markerCount()).toBe(17);
  await page.getByLabel("Show all detection markers", { exact: false }).check();
  expect(await markerCount()).toBe(18);
  await page.getByLabel("Show signals", { exact: true }).selectOption("all");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(18);
});

test("clipping warning onset, details and clearing preserve the band spectrum position", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openReceiver(page, true);
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page.getByLabel("Analyze signals after 3 sweeps").uncheck();
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  const plot = page.locator(".monitor-spectrum-plot");
  await expect(plot).toBeVisible();
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  const slot = page.getByTestId("input-clipping-slot");
  // Empty clipping UI consumes no space; the warning belongs beside the spectrum.
  await expect(slot).toBeHidden();
  await expect(
    page.locator(".monitor-sidebar-status > .input-clipping-slot"),
  ).toHaveCount(1);
  const next = (await plot.boundingBox())!.y;
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __RF_TEST_AMPLITUDE__: number }
    ).__RF_TEST_AMPLITUDE__ = 1.4;
  });
  const summary = page.locator(".input-clipping-details summary");
  await expect(summary).toContainText("Input clipping");
  const side = await slot.boundingBox();
  expect(side!.x + side!.width).toBeLessThanOrEqual(
    (await plot.boundingBox())!.x,
  );
  expect((await plot.boundingBox())!.y).toBe(next);
  await summary.click();
  await expect(
    page.locator(".input-clipping-details .input-clipping-warning"),
  ).toBeVisible();
  expect((await plot.boundingBox())!.y).toBe(next);
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __RF_TEST_AMPLITUDE__: number }
    ).__RF_TEST_AMPLITUDE__ = 0.65;
  });
  await expect(summary).toHaveCount(0);
  expect((await plot.boundingBox())!.y).toBe(next);
});

test("continuous analysis revisits the band, pauses the entire cycle and hands an active probe to Receiver", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(() =>
    localStorage.setItem(
      "browsersdr.analysisBudget.v1",
      JSON.stringify({ seconds: 6 }),
    ),
  );
  await openReceiver(page);
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page.getByLabel("Detection preset").selectOption("fm-balanced");
  await page.getByLabel("Analyze signals after 3 sweeps").check();
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  const status = page.locator(".monitor-state-card");
  const sweeps = page.getByTestId("monitor-sweeps");
  const probe = page.getByTestId("monitor-current-probe");
  await expect(status).toHaveAttribute("data-state", "analysis", {
    timeout: 15_000,
  });
  await expect(sweeps).toHaveText("3");
  await expect(
    page.getByRole("progressbar", {
      name: "Candidate acquired samples",
      exact: true,
    }),
  ).toBeVisible();
  expect((await status.boundingBox())!.width).toBeGreaterThan(240);
  const pauseButton = page.getByRole("button", {
    name: "Pause monitoring",
    exact: true,
  });
  const beforeScroll = await pauseButton.boundingBox();
  expect(beforeScroll!.y + beforeScroll!.height).toBeLessThan(
    await page.evaluate(() => innerHeight),
  );
  await page.locator(".monitor-setup-rail").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const afterScroll = await pauseButton.boundingBox();
  expect(afterScroll!.y).toBe(beforeScroll!.y);
  await expect(page.locator(".monitor-cycle-count")).toContainText(
    "1 candidate visit completed",
    { timeout: 15_000 },
  );
  await expect
    .poll(async () => Number(await sweeps.textContent()))
    .toBeGreaterThanOrEqual(4);
  await expect(status).toHaveAttribute("data-state", "analysis", {
    timeout: 15_000,
  });
  await expect(probe).toHaveAttribute("data-phase", "measuring");
  await page.screenshot({
    path: info.outputPath("continuous-analysis-status.png"),
  });
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(status).toHaveAttribute("data-state", "paused");
  await expect(probe).toHaveCount(0);
  await expect(status).toContainText("Receiver acquiring");
  const pausedSweeps = Number(await sweeps.textContent());
  await page.waitForTimeout(1200);
  await expect(sweeps).toHaveText(String(pausedSweeps));
  await page.screenshot({
    path: info.outputPath("continuous-paused-status.png"),
  });
  await page
    .getByRole("button", { name: "Resume monitoring", exact: true })
    .click();
  await expect(status).toHaveAttribute("data-state", "analysis", {
    timeout: 15_000,
  });
  await expect(sweeps).toHaveText(String(pausedSweeps + 1));
  await expect(probe).toHaveAttribute("data-phase", "measuring");
  const selected = page.locator(".monitor-frequency").first();
  const frequency = Number((await selected.textContent())!.replace(" MHz", ""));
  await selected.click();
  const investigate = page.getByRole("button", {
    name: "Investigate in Receiver",
    exact: true,
  });
  await expect(investigate).toBeEnabled();
  await investigate.click();
  await expect(
    page.getByRole("tab", { name: "Receiver", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".receiver-status")).toHaveClass(
    /receiver-status-running/,
  );
  await expect
    .poll(async () =>
      Number(
        await page
          .getByLabel("Channel frequency", { exact: false })
          .inputValue(),
      ),
    )
    .toBeCloseTo(frequency, 5);
  await page.waitForTimeout(1200);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(status).toHaveAttribute("data-state", "paused");
  await expect(sweeps).toHaveText(String(pausedSweeps + 1));
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
});

test("freezing continuous analysis cancels its next stage and reload restores history without acquisition", async ({
  page,
}) => {
  await openReceiver(page);
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page.getByLabel("Analyze signals after 3 sweeps").check();
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect(page.getByTestId("monitor-current-probe")).toHaveAttribute(
    "data-phase",
    "measuring",
    { timeout: 15_000 },
  );
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await expect(page.locator(".monitor-state-card")).toHaveAttribute(
    "data-state",
    "paused",
  );
  const sweeps = await page.getByTestId("monitor-sweeps").textContent();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(sweeps!);
  await expect(page.getByTestId("monitor-current-probe")).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByTestId("monitor-sweeps")).toHaveText(sweeps!);
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeDisabled();
});
