import { expect, type Page } from "@playwright/test";
import {
  createMonitorSession,
  recordMonitorVisit,
  validateMonitorSession,
} from "../../src/radio/signalMonitor";
import type { SourceSessionMetadata } from "../../src/radio/types";

// Deterministic persisted measurement fixture: no RF acquisition or transmitter identity.
export async function monitorHistory(page: Page) {
  await page.goto("/?browser-test=1");
  const receiver: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: 1024000,
    actualSampleRateHz: 1024000,
    hardwareCenterFrequencyHz: 915e6,
    selectedChannelFrequencyHz: 915e6,
    mode: "OFF",
    channelBandwidthHz: 200000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  let session = createMonitorSession(
    {
      version: 1,
      name: "UHF fixture",
      site: { label: "Test" },
      bands: [
        {
          id: "uhf",
          name: "Custom UHF range",
          startFrequencyHz: 914.7e6,
          endFrequencyHz: 915.3e6,
          dwellMs: 350,
          thresholdDb: 10,
          detector: "average",
          captureSeconds: 2,
        },
      ],
    },
    receiver,
    new Date(Date.now() - 120000).toISOString(),
    undefined,
    { version: 1, preset: "general" },
  );
  const candidates = Array.from({ length: 16 }, (_, i) => ({
    frequencyHz: 914.75e6 + i * 30000,
    bandwidthHz: 10000,
    lowerFrequencyHz: 914.745e6 + i * 30000,
    upperFrequencyHz: 914.755e6 + i * 30000,
    peakFrequencyHz: 914.752e6 + i * 30000,
    lowerEdgeClipped: false,
    upperEdgeClipped: false,
    peakDb: -70 + i,
    noiseFloorDb: -100,
    occupancy: 0.5,
  }));
  const result = {
    plan: session.windows[0]!.plan,
    points: [],
    candidates,
    noiseFloorDb: -100,
    coverage: 1,
    missingSamples: 0,
    frameCount: 10,
    status: "complete" as const,
  };
  for (let i = 0; i < 3; i++)
    session = recordMonitorVisit(
      session,
      0,
      result,
      350,
      new Date(Date.now() - 120000).toISOString(),
    );
  session = recordMonitorVisit(
    session,
    0,
    {
      ...result,
      candidates: [
        ...candidates,
        {
          ...candidates[0]!,
          frequencyHz: 915.24e6,
          lowerFrequencyHz: 915.235e6,
          upperFrequencyHz: 915.245e6,
          peakFrequencyHz: 915.242e6,
        },
      ],
    },
    350,
    new Date(Date.now() - 120000).toISOString(),
  );
  session.status = "paused";
  session.message = "Monitoring paused. Deterministic UHF measurement fixture.";
  validateMonitorSession(session);
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
  }, session);
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Explorer activity").selectOption("monitor");
  await expect(page.locator(".monitor-signal-table tbody tr")).toHaveCount(16);
}
