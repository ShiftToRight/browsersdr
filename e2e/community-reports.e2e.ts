import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createReportServer,
  validateCommunityReport,
} from "../deploy/report-service/report-service.mjs";
import type { CommunityReport } from "../src/diagnostics/communityTypes";
import { readFileSync } from "node:fs";
import { openApplicationView } from "./application-navigation";

const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const build = {
  id: process.env.VITE_BUILD_ID || "community-browser-fixture",
  version: packageInfo.version,
  builtAt: process.env.VITE_BUILD_TIMESTAMP || "2026-10-12T00:00:00.000Z",
};
const currentVersionName = new RegExp(
  `^${build.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);
const previous = {
  id: "community-previous-fixture",
  version: "0.9.0",
  builtAt: "2026-10-11T00:00:00.000Z",
};
function fixture(participant: string, windows = false): CommunityReport {
  return {
    schemaVersion: 2,
    reportType: "compatibility",
    reportId: `BC-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    build,
    participantToken: participant.repeat(64),
    setup: {
      source: "hackrf",
      hardwareId: "hackrf-pro",
      mode: "WBFM",
      srdProtocol: null,
      rateHz: 9600000,
      nativeRateHz: 76800000,
      protocolProfile: "hackrf-pro-stable-2026-v1",
      firmwareVersion: "2026.1.3",
      origin: "live",
    },
    environment: {
      browser: windows ? "Edge 140" : "Chrome 140",
      operatingSystem: windows ? "Windows" : "Linux",
      renderer: "canvas2d",
    },
    durationMinutes: 10,
    testScope: "smoke",
    observations: [
      { feature: "rds", result: "working" },
      { feature: "access", result: "working" },
    ],
    notes: "PRIVATE FIXTURE NOTE",
  };
}
async function isolated(page: Page, seed = true) {
  const service = createReportServer({
    database: new DatabaseSync(":memory:"),
    communityBuilds: [build, previous],
    communityReleasePath: null,
    allowedOrigin: "https://browsersdr.com",
  });
  await new Promise<void>((resolve) =>
    service.server.listen(0, "127.0.0.1", resolve),
  );
  const address = service.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing collector address");
  const origin = `http://127.0.0.1:${address.port}`;
  if (seed)
    for (const [participant, windows] of [
      ["a", false],
      ["b", true],
    ] as const) {
      const report = fixture(participant, windows);
      expect(validateCommunityReport(report)).toBeNull();
      const ack = service.community.accept(report);
      expect(ack.status).toBe(202);
    }
  // Test-only reverse proxy to the real HTTP/SQLite collector, never to production.
  await page.route("**/api/v1/compatibility-**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await fetch(origin + url.pathname + url.search, {
      method: request.method(),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://browsersdr.com",
      },
      body: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  return {
    ...service,
    close: () =>
      new Promise<void>((resolve, reject) =>
        service.server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
async function help(page: Page) {
  await page.goto("/?browser-test=1");
  await openApplicationView(page, "Compatibility");
  return page.locator(".community-compatibility");
}

test("community matrix immediately combines decoder reports across platforms and isolates version history", async ({
  page,
}, testInfo) => {
  const service = await isolated(page);
  try {
    const panel = await help(page);
    await expect(
      panel.getByRole("tab", { name: currentVersionName }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Analog audio", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const expectAlignedIcons = async () => {
      const icons = await panel
        .locator(".community-hardware-name svg")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const icon = element.getBoundingClientRect();
            const label = element.parentElement!.getBoundingClientRect();
            return {
              x: icon.x,
              centerOffset:
                icon.y + icon.height / 2 - (label.y + label.height / 2),
            };
          }),
        );
      expect(icons.length).toBeGreaterThan(1);
      expect(
        Math.max(...icons.map((icon) => icon.x)) -
          Math.min(...icons.map((icon) => icon.x)),
      ).toBeLessThan(1);
      expect(icons.every((icon) => Math.abs(icon.centerOffset) < 1)).toBe(true);
    };
    await expectAlignedIcons();
    await panel
      .getByRole("button", { name: "Digital broadcast", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "HackRF Pro · RDS: Confirmed", exact: true })
      .click();
    const details = panel.getByRole("region", {
      name: "Selected community test details",
    });
    await expect(details).toContainText("2 qualifying positives");
    await expect(details).not.toContainText("review pending");
    await expect(details).toContainText("Chrome 140 · Linux");
    await expect(details).toContainText("Edge 140 · Windows");
    await expect(panel).not.toContainText("PRIVATE FIXTURE NOTE");
    await panel
      .getByRole("button", { name: "Platform compatibility", exact: true })
      .click();
    await expectAlignedIcons();
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · Chrome 140 / Linux: Reported working",
        exact: true,
      }),
    ).toHaveText(/1\/2/);
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · Edge 140 / Windows: Reported working",
        exact: true,
      }),
    ).toHaveText(/1\/2/);
    await panel
      .getByRole("button", { name: "Engine checks", exact: true })
      .click();
    await expect(
      panel.getByRole("table", { name: "Exact-build engine checks" }),
    ).toContainText("Not recorded");
    await panel.getByRole("tab", { name: currentVersionName }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(panel.getByRole("tab", { name: /^0\.9\.0/ })).toBeFocused();
    await panel
      .getByRole("button", { name: "Reception & decoders", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · RDS: Untested",
        exact: true,
      }),
    ).toHaveText(/0\/2/);
    await panel.screenshot({
      path: testInfo.outputPath("community-desktop.png"),
    });
    await panel
      .getByRole("button", { name: "Packet & data", exact: true })
      .click();
    await openApplicationView(page, "Receiver");
    await openApplicationView(page, "Compatibility");
    await expect(
      panel.getByRole("button", { name: "Analog audio", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectAlignedIcons();
    await expect(
      panel.getByRole("button", { name: "Report this test" }),
    ).toBeVisible();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath("community-mobile.png"),
    });
  } finally {
    await service.close();
  }
});

test("community reporter downloads reviewed fields, submits only stamped builds and withdraws its evidence", async ({
  page,
}) => {
  const service = await isolated(page, false);
  try {
    const panel = await help(page);
    const trigger = panel.getByRole("button", { name: "Report this test" });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Report a community test",
    });
    await expect(
      dialog.getByRole("button", { name: "Send community report" }),
    ).toBeDisabled();
    await dialog
      .getByLabel("Spectrum / waterfall test result")
      .selectOption("working");
    await dialog.getByLabel("Test duration (minutes)").fill("10");
    await dialog.getByLabel("Private test notes").fill("PRIVATE BROWSER NOTE");
    const downloading = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Download community JSON" })
      .click();
    const downloaded = await downloading;
    const body = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
    expect(body).toMatchObject({
      schemaVersion: 2,
      durationMinutes: 10,
      observations: [{ feature: "display", result: "working" }],
    });
    expect(body.setup).not.toHaveProperty("exactFrequencyHz");
    if (process.env.VITE_BUILD_ID && process.env.VITE_BUILD_TIMESTAMP) {
      expect(validateCommunityReport(body)).toBeNull();
      await dialog
        .getByRole("button", { name: "Send community report" })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(panel).toContainText("Your results now contribute");
      expect(service.community.matrix(build.id)?.cells).toMatchObject([
        { working: 1, eligibleWorking: 1, status: "working" },
      ]);
      await panel
        .getByRole("button", { name: "Platform compatibility", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: /Reported working/ }),
      ).toHaveText(/1\/2/);
      const receiptDownload = page.waitForEvent("download");
      await panel
        .getByRole("button", { name: "Download withdrawal receipt" })
        .click();
      const receiptPath = (await receiptDownload).path();
      await page.reload();
      await openApplicationView(page, "Compatibility");
      await panel
        .getByRole("button", { name: "Withdraw report", exact: true })
        .click();
      const withdrawal = page.getByRole("dialog", {
        name: "Withdraw a report",
        exact: true,
      });
      await expect(
        withdrawal.getByRole("button", {
          name: "Withdraw this report",
          exact: true,
        }),
      ).toBeDisabled();
      await withdrawal
        .getByLabel("Withdrawal receipt JSON")
        .setInputFiles((await receiptPath)!);
      await expect(withdrawal).toContainText("Receipt loaded locally");
      await withdrawal
        .getByRole("button", { name: "Withdraw this report", exact: true })
        .click();
      await expect(withdrawal).not.toBeVisible();
      await expect(panel).toContainText("Report withdrawn");
      expect(service.community.matrix(build.id)?.cells).toHaveLength(0);
    } else {
      await expect(
        dialog.getByRole("button", { name: "Send community report" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
  } finally {
    await service.close();
  }
});

test("community API outage is distinct from untested cells and can be retried", async ({
  page,
}) => {
  const service = await isolated(page, false);
  try {
    await page.route("**/api/v1/compatibility-matrix*", (route) =>
      route.fulfill({ status: 503, body: "Unavailable" }),
    );
    const panel = await help(page);
    await expect(panel).toContainText("unavailable (503)");
    await panel
      .getByRole("button", { name: "Packet & data", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · AIS: Unavailable",
        exact: true,
      }),
    ).toHaveText(/—/);
    await page.unroute("**/api/v1/compatibility-matrix*");
    await panel
      .getByRole("button", { name: "Retry community reports" })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · AIS: Untested",
        exact: true,
      }),
    ).toHaveText(/0\/2/);
  } finally {
    await service.close();
  }
});

test("community matrix carries reviewed feature evidence with separate fresh counts, provenance and issue precedence", async ({
  page,
}, testInfo) => {
  const service = await isolated(page, false);
  try {
    const fingerprint = "c".repeat(64);
    const evidenceFingerprints = { rds: fingerprint };
    expect(
      service.community.registerBuild({
        ...previous,
        evidenceFingerprints,
        engineChecks: [
          {
            feature: "rds",
            result: "passed",
            checkedAt: previous.builtAt,
            evidence: "https://browsersdr.com/reference",
          },
        ],
      }),
    ).toBe(true);
    expect(
      service.community.registerBuild({ ...build, evidenceFingerprints }),
    ).toBe(true);
    for (const participant of ["a", "b"])
      service.community.accept({ ...fixture(participant), build: previous });
    service.community.accept(fixture("a"));
    expect(
      service.community.registerEquivalence({
        sourceBuildId: previous.id,
        targetBuildId: build.id,
        feature: "rds",
        fingerprint,
        checkedAt: new Date().toISOString(),
        evidence: "https://browsersdr.com/integration-check",
      }),
    ).toBe(true);
    let panel = await help(page);
    await panel
      .getByRole("button", { name: "Digital broadcast", exact: true })
      .click();
    const carriedButton = panel.getByRole("button", {
      name: "HackRF Pro · RDS: Confirmed · carried",
      exact: true,
    });
    await expect(carriedButton).toContainText("fresh 1/2");
    await carriedButton.click();
    const details = panel.getByRole("region", {
      name: "Selected community test details",
    });
    await expect(details).toContainText(
      "Fresh on this build: 1 positive report(s), 1 qualifying positives",
    );
    await expect(details).toContainText("Carried from 0.9.0");
    await expect(details).toContainText(previous.id);
    await expect(details).toContainText("expires");
    await expect(panel).not.toContainText("PRIVATE FIXTURE NOTE");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await details
      .getByRole("heading", { name: "Carried from 0.9.0", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("community-carried-mobile.png"),
    });
    await panel
      .getByRole("button", { name: "Engine checks", exact: true })
      .click();
    const row = panel.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "RDS", exact: true }),
    });
    await expect(row).toContainText("Not recorded");
    await expect(row).toContainText("Carried passed from 0.9.0");
    const problem = fixture("a");
    problem.observations = [{ feature: "rds", result: "not-working" }];
    expect(service.community.accept(problem).status).toBe(202);
    panel = await help(page);
    await panel
      .getByRole("button", { name: "Digital broadcast", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "HackRF Pro · RDS: Issue reported",
        exact: true,
      }),
    ).toContainText("issue(s)");
  } finally {
    await service.close();
  }
});

test("new image and CW text reports reach their own community matrix columns", async ({
  page,
}, testInfo) => {
  const service = await isolated(page, false);
  try {
    const modes = [
      ["WEFAX", "wefax", "WEFAX images"],
      ["SSTV", "sstv", "SSTV Martin images"],
      ["CW-TEXT", "cw-text", "CW text assistant"],
    ] as const;
    for (const [mode, feature] of modes) {
      const report = fixture("a");
      report.setup.mode = mode;
      report.observations = [{ feature, result: "working" }];
      expect(validateCommunityReport(report)).toBeNull();
      expect(service.community.accept(report).status).toBe(202);
    }
    const panel = await help(page);
    await panel
      .getByRole("button", { name: "Packet & data", exact: true })
      .click();
    for (const [, , label] of modes) {
      await expect(
        panel.getByRole("columnheader", { name: label, exact: true }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", {
          name: `HackRF Pro · ${label}: Reported working`,
          exact: true,
        }),
      ).toHaveText(/1\/2/);
    }
    await panel
      .getByRole("button", { name: "Engine checks", exact: true })
      .click();
    const engine = panel.getByRole("table", {
      name: "Exact-build engine checks",
    });
    for (const [, , label] of modes)
      await expect(
        engine.getByRole("row").filter({
          has: page.getByRole("rowheader", { name: label, exact: true }),
        }),
      ).toContainText("Not recorded");
    await panel
      .getByRole("button", { name: "Reception & decoders", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath("community-new-modes.png"),
    });
  } finally {
    await service.close();
  }
});
