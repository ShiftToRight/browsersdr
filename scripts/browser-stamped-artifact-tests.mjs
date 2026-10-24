import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBuildReceipt } from "./browser-build.mjs";
import { digest, verificationDigest } from "./browser-coverage.mjs";
import {
  validateStamp,
  stampedEnvironment,
  verifyStampedArtifact,
  verifyStampedCoverage,
  verifyReleaseEnvelope,
  assertServiceBoundary,
} from "./browser-stamped-artifact.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bsd-stamped-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const name of [
    "src",
    "e2e",
    "scripts",
    "public",
    "deploy/report-service",
    ".github",
    "dist",
    "test-results",
    "node_modules/vite",
    "node_modules/@playwright/test",
    "node_modules/@typescript/native",
  ])
    mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules/\ndist/\ntest-results/\n.local/\n",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "1.15.0" }),
  );
  writeFileSync(join(root, "playwright.config.ts"), "fixture config");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const stamp = {
    release: `20261024T120000Z-${commit.slice(0, 7)}-${"a".repeat(12)}`,
    commit,
    version: "1.15.0",
    sourceSha256: "a".repeat(64),
    workingTreeDirty: false,
    builtAt: "2026-10-24T12:00:00Z",
    node: "22.23.1",
    sharingService: {
      version: "0.1.0",
      protocol: 1,
      sourceSha256: "b".repeat(64),
    },
  };
  for (const name of ["vite", "@playwright/test", "@typescript/native"])
    writeFileSync(
      join(root, "node_modules", name, "package.json"),
      JSON.stringify({ version: "1" }),
    );
  writeFileSync(join(root, "dist/index.html"), "immutable stamped HTML");
  writeFileSync(join(root, "dist/app.js"), "immutable executable");
  writeFileSync(join(root, "dist/release.json"), JSON.stringify(stamp));
  const receipt = join(root, "test-results/browser-build.json");
  writeBuildReceipt(root, receipt, stampedEnvironment(stamp, {}));
  const artifacts = join(root, ".local/artifacts");
  mkdirSync(join(artifacts, "browser-build/test-results"), { recursive: true });
  cpSync(join(root, "dist"), join(artifacts, "browser-build/dist"), {
    recursive: true,
  });
  cpSync(
    receipt,
    join(artifacts, "browser-build/test-results/browser-build.json"),
  );
  const tested = verifyStampedArtifact(
    root,
    join(root, "dist"),
    receipt,
    stamp,
  );
  const receipts = [];
  for (const project of ["chromium-dev", "chromium-production"])
    for (const shard of [1, 2]) {
      const full = ["one", "two"].map((title) => {
        const identity = {
          project,
          file: "live-sharing.e2e.ts",
          titles: [title],
          repeat: 0,
        };
        return { ...identity, id: digest(identity) };
      });
      const selected = [full[shard - 1]];
      const result = {
        schemaVersion: 1,
        inputDigest: verificationDigest(root),
        configurationDigest: digest(
          readFileSync(join(root, "playwright.config.ts")).toString("base64"),
        ),
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          playwright: "1",
          optionalAtlas: false,
          optionalBladeRf: false,
          buildFlags: Object.fromEntries(
            Object.entries(stampedEnvironment(stamp, {}))
              .sort()
              .map(([k, v]) => [k, digest(v)]),
          ),
        },
        project,
        shard: { current: shard, total: 2 },
        full,
        selected,
        allowedSkips: {},
        actual: selected.map((identity) => ({
          identity,
          expectedStatus: "passed",
          annotations: [],
          results: [{ retry: 0, status: "passed" }],
        })),
        status: "passed",
        errors: [],
        ...(project === "chromium-production"
          ? { testedArtifact: tested }
          : {}),
      };
      const dir = join(artifacts, `browser-check-${project}-${shard}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "coverage-receipt.json"), JSON.stringify(result));
      receipts.push({ result, path: join(dir, "coverage-receipt.json") });
    }
  return { root, stamp, receipt, artifacts, tested, receipts };
}

test("stamps reject stale source, malformed identity, unsupported flags and private runtime mismatch", (t) => {
  const { root, stamp } = fixture(t);
  validateStamp(root, stamp);
  for (const change of [
    (s) => {
      s.commit = "0".repeat(40);
    },
    (s) => {
      s.release += "/extra";
    },
    (s) => {
      s.workingTreeDirty = true;
    },
    (s) => {
      s.builtAt = "2026-02-30T12:00:00Z";
    },
    (s) => {
      s.sharingService.protocol = 2;
    },
    (s) => {
      s.extra = true;
    },
  ]) {
    const bad = structuredClone(stamp);
    change(bad);
    assert.throws(() => validateStamp(root, bad));
  }
  assert.throws(() => stampedEnvironment(stamp, { VITE_BUILD_ID: "other" }));
  assert.throws(() => stampedEnvironment(stamp, { VITE_FEATURE: "enabled" }));
});

test("promotion requires complete first-attempt shards on the identical stamped artifact", (t) => {
  const { root, stamp, artifacts, receipts } = fixture(t);
  assert.equal(verifyStampedCoverage(root, artifacts, stamp).coverage.tests, 4);
  for (const change of [
    (r) => {
      r.testedArtifact.receiptSha256 = "other";
    },
    (r) => {
      r.environment.buildFlags = {};
    },
    (r) => {
      r.actual[0].results[0].retry = 1;
    },
    (r) => {
      r.status = "failed";
    },
    (r) => {
      r.selected = [];
      r.actual = [];
    },
    (r) => {
      r.environment.optionalAtlas = true;
    },
  ]) {
    const bad = structuredClone(receipts[2].result);
    change(bad);
    writeFileSync(receipts[2].path, JSON.stringify(bad));
    assert.throws(() => verifyStampedCoverage(root, artifacts, stamp));
    writeFileSync(receipts[2].path, JSON.stringify(receipts[2].result));
  }
  rmSync(receipts[3].path);
  assert.throws(() => verifyStampedCoverage(root, artifacts, stamp));
});

test("promotion fails on executable, metadata, extra-file and source tampering", (t) => {
  const { root, stamp, artifacts } = fixture(t);
  const site = join(artifacts, "browser-build/dist");
  for (const name of ["app.js", "release.json", "extra.js"]) {
    const previous =
      name === "extra.js" ? undefined : readFileSync(join(site, name));
    writeFileSync(join(site, name), "tampered");
    assert.throws(() => verifyStampedCoverage(root, artifacts, stamp));
    if (previous) writeFileSync(join(site, name), previous);
    else rmSync(join(site, name));
  }
  writeFileSync(join(root, "src/new.js"), "changed source");
  assert.throws(() => verifyStampedCoverage(root, artifacts, stamp));
});

test("sealing permits only the reviewed carry envelope and independently hashes final site", (t) => {
  const { root, stamp, tested } = fixture(t),
    site = join(root, "dist");
  const check = { testedSiteSha256: digest(tested.files) },
    evidenceFingerprints = { access: "c".repeat(64) };
  const audit = { build: stamp, check, evidenceFingerprints };
  mkdirSync(join(site, "community-evidence"));
  writeFileSync(
    join(site, "community-evidence", stamp.release + ".json"),
    JSON.stringify(audit),
  );
  writeFileSync(
    join(site, "release.json"),
    JSON.stringify({
      ...stamp,
      communityCarryCheck: check,
      evidenceFingerprints,
    }),
  );
  const proof = verifyReleaseEnvelope(site, tested.files, stamp);
  assert.notEqual(proof.testedSiteSha256, proof.finalSiteSha256);
  writeFileSync(join(site, "app.js"), "rebuilt");
  assert.throws(
    () => verifyReleaseEnvelope(site, tested.files, stamp),
    /Sealing changed/,
  );
});

test("new service-dependent test files require an explicit promotion boundary review", (t) => {
  const { root } = fixture(t);
  assertServiceBoundary(root);
  writeFileSync(
    join(root, "e2e/new.e2e.ts"),
    "process.env.BSD_E2E_SHARING_REAL",
  );
  assert.throws(() => assertServiceBoundary(root), /scope changed/);
});
