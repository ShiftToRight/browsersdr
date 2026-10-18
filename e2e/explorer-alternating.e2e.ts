import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
  type MonitorSession,
} from "../src/radio/signalMonitor";
import { analyzeMonitorWindow } from "../src/radio/monitorDetection";
import type { SourceSessionMetadata, SpectrumFrame } from "../src/radio/types";
import type { SurveyProfile } from "../src/radio/fieldSurvey";

async function exportHistory(page: Page): Promise<MonitorSession> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "History JSON", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}

test("alternating half-window sweeps cover both endpoints and retain one signal history", async ({
  page,
}, info) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.addInitScript(() =>
    localStorage.setItem(
      "browsersdr.surveyProfile.v1",
      JSON.stringify({
        version: 1,
        name: "Alternating sweep",
        site: { label: "Synthetic" },
        bands: [
          {
            id: "band",
            name: "Synthetic band",
            startFrequencyHz: 99.2e6,
            endFrequencyHz: 100.6e6,
            dwellMs: 150,
            thresholdDb: 6,
            detector: "max-hold",
            captureSeconds: 2,
          },
        ],
      }),
    ),
  );
  await page.goto("/?browser-test=1");
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await page
    .getByLabel("Monitor targets", { exact: true })
    .selectOption("band-plan");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect(page.getByTestId("monitor-sweep-grid")).toContainText(
    "alternating half-window sweeps",
  );
  // Give each complete grid its own existing expectation deadline, as in the
  // repeated-band regression; both grids must complete within the case limit.
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () =>
      Number(await page.getByTestId("monitor-sweeps").textContent()),
    )
    .toBeGreaterThanOrEqual(2);
  await page
    .getByRole("button", { name: "Pause monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume monitoring", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("monitor-active-window")).toHaveCount(0);
  await page.getByText("History & tools", { exact: true }).click();
  const before = await exportHistory(page);
  expect(before.sweepPattern).toEqual({ version: 1, startedAtSweep: 0 });
  expect(before.windows).toHaveLength(5);
  expect(before.windows.every((w) => w.visits > 0)).toBe(true);
  for (const phase of [0, 1]) {
    const w = before.windows.filter((w) => w.sweepPhase === phase);
    expect(w[0]!.plan.lowerFrequencyHz).toBe(99.2e6);
    expect(w.at(-1)!.plan.upperFrequencyHz).toBe(100.6e6);
    for (let i = 1; i < w.length; i++)
      expect(w[i]!.plan.lowerFrequencyHz).toBe(w[i - 1]!.plan.upperFrequencyHz);
  }
  const shifted = before.windows.filter((w) => w.sweepPhase === 1);
  expect(
    shifted.map((w) => [w.plan.lowerFrequencyHz, w.plan.upperFrequencyHz]),
  ).toEqual([
    [99.2e6, 99.55e6],
    [99.55e6, 100.25e6],
    [100.25e6, 100.6e6],
  ]);
  expect(before.signals.length).toBeGreaterThan(0);
  expect(before.signals.some((s) => s.detections >= 2)).toBe(true);
  if (info.project.name === "chromium-production")
    await page.screenshot({
      path: info.outputPath("alternating-sweep-paused.png"),
    });
  expect(errors).toEqual([]);
});

test("alternating history reload preserves a shifted-grid cursor and evidence without starting acquisition", async ({
  page,
}) => {
  const receiver: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: 1024000,
    actualSampleRateHz: 1024000,
    hardwareCenterFrequencyHz: 100e6,
    selectedChannelFrequencyHz: 100e6,
    mode: "OFF",
    channelBandwidthHz: 200000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const profile: SurveyProfile = {
    version: 1,
    name: "Recovery",
    site: { label: "Generated" },
    bands: [
      {
        id: "band",
        name: "Band",
        startFrequencyHz: 99.2e6,
        endFrequencyHz: 100.6e6,
        dwellMs: 150,
        thresholdDb: 10,
        detector: "average",
        captureSeconds: 2,
      },
    ],
  };
  let session = createMonitorSession(profile, receiver, undefined, undefined, {
    version: 2,
    preset: "general",
  });
  for (let i = 0; i < 3; i++) {
    const index = session.nextWindow,
      plan = session.windows[index]!.plan,
      bins = new Float32Array(4096).fill(-100);
    for (let j = 0; j < bins.length; j++)
      if (Math.abs(plan.centerFrequencyHz + (j - 2048) * 250 - 99.77e6) < 5000)
        bins[j] = -40;
    const result = analyzeMonitorWindow(
      plan,
      {
        frames: [
          {
            bins,
            centerFrequencyHz: plan.centerFrequencyHz,
            sampleRateHz: 1024000,
          } as SpectrumFrame,
        ],
        sourceSamples: 153600,
        targetSamples: 153600,
        coverage: 1,
        missingSamples: 0,
        status: "complete",
      },
      10,
      "average",
      session.analysis!,
    );
    session = recordMonitorVisit(
      session,
      index,
      result,
      150,
      new Date(Date.now() + i).toISOString(),
    );
  }
  session = validateMonitorSession(session);
  expect(session.sweeps).toBe(1);
  expect(session.nextWindow).toBe(3);
  expect(session.signals).toHaveLength(1);
  await page.goto("/?browser-test=1");
  await page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("browsersdr-monitoring", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sessions");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(value, "latest");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, session);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.getByTestId("monitor-sweeps")).toHaveText("1");
  await expect(page.getByTestId("monitor-sweep-grid")).toContainText(
    "Half-window grid",
  );
  await expect(
    page.getByRole("button", { name: "Pause monitoring", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("monitor-active-window")).toHaveCount(0);
  await page.getByText("History & tools", { exact: true }).click();
  const recovered = await exportHistory(page);
  expect(recovered.id).toBe(session.id);
  expect(recovered.nextWindow).toBe(3);
  expect(recovered.sweepPattern).toEqual(session.sweepPattern);
  expect(recovered.windows).toEqual(session.windows);
  expect(recovered.signals).toEqual(session.signals);
});
