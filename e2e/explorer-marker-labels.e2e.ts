import { expect, test } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";
import type { MonitorSession } from "../src/radio/signalMonitor";

test("wide mouse targets separate nearby detections and RDS labels occupy nonoverlapping lanes", async ({
  page,
}, info) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 2868, height: 1440 });
  await monitorHistory(page);
  // Explicit persisted presentation fixture, not a claim of live reception or decoded identity.
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
    session.signals.forEach((s, i) => {
      s.frequencyHz = 914.9e6 + i * 8000;
      s.bandwidthHz = 4000;
      s.lowerFrequencyHz = s.frequencyHz - 2000;
      s.upperFrequencyHz = s.frequencyHz + 2000;
      s.peakFrequencyHz = s.frequencyHz;
    });
    localStorage.setItem(
      "browsersdr.signalAnalysis.v1",
      JSON.stringify({
        version: 1,
        sessionKey: session.id,
        records: session.signals.map((s, i) => ({
          candidate: {
            id: s.id,
            frequencyHz: s.frequencyHz,
            bandwidthHz: s.bandwidthHz,
          },
          at: new Date().toISOString(),
          result: {
            version: 1,
            status: "complete",
            sampledSeconds: 2,
            resolutionHz: 62.5,
            frequencyHz: s.frequencyHz,
            label: `RDS: TEST ${i.toString().padStart(2, "0")}`,
            reasons: ["Presentation fixture"],
            stableProgrammeService: `TEST ${i.toString().padStart(2, "0")}`,
            suggestedMode: "WBFM",
            rds: { pi: "C201", validGroups: 16 },
          },
        })),
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
  await expect(page.getByTestId("monitor-detection-marker")).toHaveCount(17);
  await expect(
    page.getByTestId("monitor-detection-marker").filter({ hasText: "marks" }),
  ).toHaveCount(0);
  for (const width of [2868, 1440, 390]) {
    await page.setViewportSize({ width, height: 1440 });
    await expect
      .poll(async () =>
        page.locator(".monitor-marker-intelligence").evaluateAll((nodes) => {
          const bounds = nodes[0]
            ?.closest(".monitor-spectrum-plot")
            ?.getBoundingClientRect();
          if (!bounds) return true;
          const boxes = nodes.map((n) => n.getBoundingClientRect());
          return boxes.every(
            (a, i) =>
              a.left >= bounds.left - 1 &&
              a.right <= bounds.right + 1 &&
              boxes.every(
                (b, j) =>
                  i === j ||
                  a.right <= b.left ||
                  b.right <= a.left ||
                  a.bottom <= b.top ||
                  b.bottom <= a.top,
              ),
          );
        }),
      )
      .toBe(true);
    expect(
      await page
        .getByTestId("monitor-detection-marker")
        .evaluateAll((nodes) =>
          nodes.reduce((n, b) => n + Number(b.getAttribute("data-count")), 0),
        ),
    ).toBe(17);
    if (width === 2868) {
      expect(
        await page.locator(".monitor-marker-intelligence").count(),
      ).toBeGreaterThan(4);
      await page.screenshot({ path: info.outputPath("packed-rds-wide.png") });
    }
    if (width === 390) {
      const cluster = page
        .getByTestId("monitor-detection-marker")
        .filter({ hasText: "marks" })
        .first();
      await cluster.click();
      await expect(
        page.getByRole("dialog", { name: "Nearby detections", exact: true }),
      ).toContainText("RDS: TEST");
      await page.keyboard.press("Escape");
    }
  }
});
