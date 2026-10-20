import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBrowserChecks } from "./run-browser-checks.mjs";

// Supplemental early checks, never a substitute for complete release coverage.
// Exact identities fail closed if a renamed/deleted test would disappear.
export const riskGroups = [
  {
    name: "cold-throughput",
    repeats: 3,
    cases: [
      [
        "signal-ux.e2e.ts",
        "19.2 MS/s channel capture completes five seconds while Search opens",
      ],
    ],
  },
  {
    name: "catalog-throughput",
    repeats: 1,
    cases: [
      [
        "public-frequency-capture.e2e.ts",
        "19.2 MS/s capture preserves five seconds while a complete live frequency catalog is validated and saved",
      ],
    ],
  },
  {
    name: "integration",
    repeats: 1,
    cases: [
      [
        "next-ux.e2e.ts",
        "frequency edits survive a delayed real sample-rate transaction without implicit retuning",
      ],
      [
        "decoder-workspace.e2e.ts",
        "RS41 uses the geographic canvas and retains labelled telemetry in narrow selected detail",
      ],
      [
        "decoder-map-pan.e2e.ts",
        "Decoder map pans without selecting a dragged aircraft and Fit restores framing",
      ],
      [
        "live-sharing.e2e.ts",
        "real WebRTC shares RF rows to one guest, refuses a second and ends on host Stop without guest USB",
      ],
      [
        "live-sharing.e2e.ts",
        "a single session key joins isolated browsers and carries decoded AM audio with host volume zero",
      ],
    ],
  },
];
export function assertRiskInventory(tests, group) {
  const expected = new Set(
    group.cases.flatMap(([file, title]) =>
      Array.from({ length: group.repeats }, (_, repeat) =>
        JSON.stringify([file, title, repeat]),
      ),
    ),
  );
  const actual = tests.map((test) =>
    JSON.stringify([test.file, test.titles.at(-1), test.repeat]),
  );
  if (
    actual.length !== expected.size ||
    new Set(actual).size !== expected.size ||
    actual.some((id) => !expected.has(id))
  )
    throw new Error(`Incomplete release risk inventory: ${group.name}`);
}
export async function runReleaseRisk({ source, work, url, env }) {
  const results = [];
  const failures = [];
  for (const group of riskGroups) {
    const config = join(work, `risk-${group.name}.config.mjs`);
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const options = {
      testDir: join(source, "e2e"),
      testMatch: [...new Set(group.cases.map(([file]) => "**/" + file))],
      repeatEach: group.repeats,
      fullyParallel: false,
      workers: 1,
      retries: 0,
      forbidOnly: true,
      failOnFlakyTests: true,
      timeout: 20000,
      expect: { timeout: 7000 },
      use: {
        baseURL: url,
        browserName: "chromium",
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 },
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
      },
    };
    const pattern = group.cases
      .map(([, title]) => escape(title) + "$")
      .join("|");
    writeFileSync(
      config,
      `const config=${JSON.stringify(options)};config.grep=new RegExp(${JSON.stringify(pattern)});export default config;\n`,
      { flag: "wx" },
    );
    try {
      const { receipt } = await runBrowserChecks({
        root: source,
        config,
        output: join(work, group.name),
        env,
        inventoryCheck: (tests) => assertRiskInventory(tests, group),
      });
      results.push({
        group: group.name,
        cases: receipt.actual.length,
        status: receipt.status,
      });
    } catch (error) {
      failures.push(`${group.name}: ${error.message}`);
      results.push({
        group: group.name,
        status: "failed",
        error: error.message,
      });
    }
  }
  const result = {
    schemaVersion: 1,
    kind: "diagnostic-only",
    status: failures.length ? "failed" : "passed",
    canDeploy: false,
    completeReleaseGate: false,
    groups: results,
  };
  writeFileSync(
    join(work, "risk-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  if (failures.length) throw new Error(failures.join("; "));
  return result;
}
