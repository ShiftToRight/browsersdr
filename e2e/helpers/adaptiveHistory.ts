import { expect, type Page } from "@playwright/test";
import { analyzeMonitorWindow } from "../../src/radio/monitorDetection";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
} from "../../src/radio/signalMonitor";
import type {
  SourceSessionMetadata,
  SpectrumFrame,
} from "../../src/radio/types";

/** Deterministic measured-spectrum fixture; separate from live synthetic acquisition and physical RF. */
export async function adaptiveHistory(page: Page, dense = false) {
  await page.goto("/?browser-test=1");
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
  let s = createMonitorSession(
    {
      version: 1,
      name: "Adaptive review fixture",
      site: { label: "Deterministic spectrum fixture" },
      bands: [
        {
          id: "test",
          name: "Review band",
          startFrequencyHz: 99.7e6,
          endFrequencyHz: 100.3e6,
          dwellMs: 350,
          thresholdDb: 10,
          detector: "average",
          captureSeconds: 2,
        },
      ],
    },
    receiver,
    new Date().toISOString(),
    undefined,
    { version: 2, preset: "general" },
  );
  for (let i = 0; i < 5; i++) {
    const shift = [0, 1, -1, 8, 0][i]!;
    const bins = new Float32Array(4096).fill(-100);
    if (dense) {
      for (let j = 0; j < 16; j++)
        bins.fill(-50, 1048 + j * 120, 1088 + j * 120);
    } else {
      bins.fill(-50, 2468 + shift, 2548 + shift);
      bins.fill(-96, 2548 + shift, 2556 + shift);
      bins.fill(-52, 2556 + shift, 2636 + shift);
      bins[2150] = -45;
    }
    const frame = {
      bins,
      centerFrequencyHz: 100e6,
      sampleRateHz: 1024000,
      sessionGeneration: 1,
      sampleIndex: i * 16384,
    } as SpectrumFrame;
    const r = analyzeMonitorWindow(
      s.windows[0]!.plan,
      {
        frames: [frame],
        targetSamples: 16384,
        sourceSamples: 16384,
        coverage: 1,
        missingSamples: 0,
        status: "complete",
      },
      10,
      "average",
      s.analysis!,
    );
    s = recordMonitorVisit(
      s,
      0,
      r,
      350,
      new Date(Date.now() + i).toISOString(),
    );
  }
  s.status = "paused";
  s.message =
    "Paused deterministic adaptive grouping fixture. No RF acquisition.";
  s = validateMonitorSession(s);
  await page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("browsersdr-monitoring", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("sessions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(value, "latest");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, s);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(
    dense ? 16 : 2,
  );
  return s;
}
