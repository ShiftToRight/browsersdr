import { expect, test } from "@playwright/test";
import { monitorHistory } from "./helpers/monitorHistory";

test("monitor status reserves stable rows across acquisition, progress and paused states", async ({
  page,
}, info) => {
  await monitorHistory(page);
  const styles = await page
    .locator('style, link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => link.outerHTML).join(""));
  // Freeze the real rendered card in an isolated document to exercise each
  // status without starting acquisition or depending on transition timing.
  const markup = await page
    .locator(".monitor-state-card")
    .evaluate((node) => node.outerHTML);
  const variants = [
    [
      "Monitoring",
      "Receiver changing state; waiting for completion.",
      "running",
    ],
    ["Monitoring", "Receiver acquiring at 100.000000 MHz.", "running"],
    ["Analyzing signals", "Receiver acquiring at 100.000000 MHz.", "analysis"],
    [
      "Restoring receiver",
      "Receiver changing state; waiting for completion.",
      "analysis",
    ],
    ["Pausing…", "Receiver changing state; waiting for completion.", "cleanup"],
    ["paused", "Receiver is not acquiring. History retained.", "paused"],
    ["stopped", "Receiver is not acquiring.", "paused"],
    ["Ready to monitor", "Receiver is not acquiring.", "ready"],
    ["interrupted", "Receiver is not acquiring.", "failed"],
    ["failed", "Receiver is not acquiring.", "failed"],
  ];
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometries = [];
    for (const variant of variants) {
      await page.setContent(
        `<html><head>${styles}</head><body><main class="explorer-studio" style="width:310px;padding:14px"><div class="monitor-control-state">${markup}</div><div id="below">Settings below</div></main></body></html>`,
      );
      await page
        .locator(".monitor-state-card")
        .evaluate((card, [title, receiver, state]) => {
          card.setAttribute("data-state", state!);
          card.querySelector(".status-pill")!.textContent = title!;
          card.querySelector(".monitor-acquisition-state")!.textContent =
            receiver!;
          const measurement = card.querySelector(".monitor-state-measurement")!;
          if (state === "ready") measurement.replaceChildren();
          else if (state === "analysis")
            measurement.innerHTML =
              '<div class="monitor-state-progress"><div><span>Acquired samples</span><span>2.0 / 30 s limit</span></div><progress aria-label="Candidate acquired samples" max="30" value="2"></progress><small>100.000000 MHz · 512 waiting</small></div>';
          const count = card.querySelector(".monitor-cycle-count")!;
          count.textContent = "512 candidate visits completed";
          count.setAttribute("aria-hidden", String(state === "ready"));
        }, variant);
      await page.evaluate(() => document.fonts.ready);
      geometries.push(
        await page
          .locator("#below")
          .evaluate((node) => node.getBoundingClientRect().top),
      );
      const title = page.locator(".monitor-state-title");
      expect((await title.boundingBox())!.height).toBeLessThan(45);
    }
    expect(Math.max(...geometries) - Math.min(...geometries)).toBeLessThan(1);
  }
  await page.screenshot({ path: info.outputPath("status-stable.png") });
});

test("Explorer themed toggles retain keyboard and label activation in all themes", async ({
  page,
}, info) => {
  await monitorHistory(page);
  // The marker switch appears after a candidate has a saved analysis record.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("browsersdr-monitoring", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise<{
      id: string;
      signals: { id: string; frequencyHz: number; bandwidthHz: number }[];
    }>((resolve, reject) => {
      const request = db
        .transaction("sessions")
        .objectStore("sessions")
        .get("latest");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    localStorage.setItem(
      "browsersdr.signalAnalysis.v1",
      JSON.stringify({
        version: 1,
        sessionKey: session.id,
        records: [
          {
            candidate: session.signals[0],
            at: new Date().toISOString(),
            error: "Presentation fixture",
          },
        ],
      }),
    );
    db.close();
  });
  await page.reload();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  const analysis = page.getByLabel("Analyze signals after 3 sweeps", {
    exact: true,
  });
  const markers = page.getByLabel(/Show all detection markers/);
  for (const theme of [
    "midnight-observatory",
    "field-deck",
    "vice-afterglow",
  ]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const toggle of [analysis, markers]) {
      await toggle.scrollIntoViewIfNeeded();
      await toggle.uncheck();
      const before = await toggle.locator("..").boundingBox();
      await toggle.focus();
      await expect(toggle).toBeFocused();
      await toggle.press("Space");
      await expect(toggle).toBeChecked();
      expect(
        await toggle.evaluate((node) => getComputedStyle(node).outlineStyle),
      ).toBe("solid");
      expect(await toggle.locator("..").boundingBox()).toEqual(before);
      const knob = await toggle.evaluate((node) => ({
        background: getComputedStyle(node, "::before").backgroundColor,
        track: getComputedStyle(node).backgroundColor,
      }));
      expect(knob.background).not.toBe(knob.track);
      await toggle.locator("..").click();
      await expect(toggle).not.toBeChecked();
    }
    await page.screenshot({ path: info.outputPath(`toggles-${theme}.png`) });
  }
});
