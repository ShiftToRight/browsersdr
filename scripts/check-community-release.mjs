import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, extname, relative } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fingerprintCommunityEvidence } from "./community-evidence-fingerprint.mjs";

// Run against the actual stamped payload using the exact frozen source's tests.
const [siteArgument, sourceArgument, mode = "full"] = process.argv.slice(2);
if (!siteArgument || !sourceArgument || !["full", "access"].includes(mode))
  throw new Error(
    "Usage: check-community-release.mjs SITE FROZEN_SOURCE [full|access]",
  );
const site = resolve(siteArgument),
  source = resolve(sourceArgument);
const metadataPath = join(site, "release.json"),
  metadata = JSON.parse(readFileSync(metadataPath));
delete metadata.communityCarryCheck;
delete metadata.evidenceFingerprints;
const policy = JSON.parse(
  readFileSync(
    new URL(
      "../deploy/report-service/community-evidence-policy.json",
      import.meta.url,
    ),
  ),
);
// Identity stamps do not change feature behavior; every other Vite flag does.
const flags = Object.fromEntries(
  Object.entries(process.env)
    .filter(
      ([key]) =>
        key.startsWith("VITE_") &&
        !["VITE_BUILD_ID", "VITE_BUILD_TIMESTAMP"].includes(key),
    )
    .sort()
    .map(([key, value]) => [
      key,
      createHash("sha256").update(value).digest("hex"),
    ]),
);
for (const feature of Object.values(policy.features))
  feature.buildContext.flags = flags;
const fingerprints = fingerprintCommunityEvidence(source, policy);
const work = resolve(
  process.env.BSD_COMMUNITY_CHECK_OUTPUT ??
    join(source, ".local/community-release-check"),
);
mkdirSync(work, { recursive: true });
const mime = {
  ".html": "text/html",
  ".txt": "text/plain; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
};
const server = createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405);
    response.end();
    return;
  }
  const pathname = decodeURIComponent(
    new URL(request.url, "http://localhost").pathname,
  );
  let path = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
  if (relative(site, path).startsWith("..") || !existsSync(path)) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    const bytes = readFileSync(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const config = join(work, "playwright.config.mjs");
const files =
  mode === "access"
    ? ["**/browser.e2e.ts", "**/hackrf.e2e.ts", "**/recovery.e2e.ts"]
    : undefined;
const grep =
  mode === "access"
    ? "pending permission is cancelled|failed device close retains|cancelled USB chooser|HackRF real pipeline with mocked USB|HackRF wideband keeps|live RTL rate selection"
    : undefined;
writeFileSync(
  config,
  `const config = ${JSON.stringify({ testDir: join(source, "e2e"), testMatch: files ?? "**/*.e2e.ts", fullyParallel: false, workers: 1, retries: 0, timeout: 20000, expect: { timeout: 7000 }, reporter: [["list"], ["json", { outputFile: join(work, "results.json") }]], outputDir: join(work, "test-results"), use: { baseURL: url, browserName: "chromium", acceptDownloads: true, viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure", trace: "retain-on-failure" } })}; config.grep = new RegExp(${JSON.stringify(grep ?? ".*")}); export default config;\n`,
);
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(source, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        config,
      ],
      {
        cwd: source,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_BUILD_ID: metadata.release,
          VITE_BUILD_TIMESTAMP: metadata.builtAt,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (result !== 0)
    throw new Error(
      "Stamped community integration failed; no attestation or registration permitted",
    );
  const results = JSON.parse(readFileSync(join(work, "results.json")));
  if (
    results.stats.unexpected ||
    results.stats.flaky ||
    results.stats.expected < (mode === "access" ? 7 : 100)
  )
    throw new Error("Incomplete stamped integration results");
  const check = {
    checkedAt: new Date().toISOString(),
    features:
      mode === "access"
        ? ["access"]
        : Object.keys(fingerprints.evidenceFingerprints),
    evidence: `https://browsersdr.com/community-evidence/${metadata.release}.json`,
    kind:
      mode === "access"
        ? "Mocked WebUSB connection/ownership integration"
        : "Full stamped Chromium integration",
    tests: results.stats.expected,
    skipped: results.stats.skipped,
  };
  const audit = {
    schemaVersion: 1,
    build: metadata,
    check,
    policy,
    policySha256: createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex"),
    ...fingerprints,
  };
  mkdirSync(join(site, "community-evidence"), { recursive: true });
  writeFileSync(
    join(site, "community-evidence", metadata.release + ".json"),
    JSON.stringify(audit, null, 2) + "\n",
    { flag: "wx" },
  );
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        ...metadata,
        evidenceFingerprints: fingerprints.evidenceFingerprints,
        communityCarryCheck: check,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ buildId: metadata.release, check }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
