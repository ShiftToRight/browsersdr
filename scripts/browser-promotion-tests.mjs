import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, verificationDigest } from "./browser-coverage.mjs";
import { writeBuildReceipt } from "./browser-build.mjs";
import {
  ARTIFACTS,
  JOBS,
  PROJECTS,
  SHARDS,
  assertArtifacts,
  assertJobs,
  assertNative,
  assertNoFailedPeers,
  assertSourceRun,
  expectedStability,
  read,
  verifyBundle,
  verifyFresh,
} from "./browser-promotion-core.mjs";
import { extractArchive, verifyArchive } from "./browser-promotion.mjs";

const clone = (value) => structuredClone(value);
const context = {
  repository: "owner/repo",
  sha: "a".repeat(40),
  workflowId: 42,
  currentRunId: 200,
  now: Date.parse("2026-10-25T10:00:00Z"),
};
const sourceRun = () => ({
  id: 100,
  head_sha: context.sha,
  workflow_id: 42,
  path: ".github/workflows/ci.yml",
  event: "push",
  display_title: `CI ${context.sha}`,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  head_branch: "codex/candidate",
  repository: { full_name: "owner/repo" },
  head_repository: { full_name: "owner/repo" },
  created_at: "2026-10-25T08:00:00Z",
  updated_at: "2026-10-25T09:00:00Z",
});
const jobs = () =>
  JOBS.map((name, index) => ({
    id: index + 1,
    name,
    run_id: 100,
    head_sha: context.sha,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    labels: ["ubuntu-latest"],
    runner_id: index + 10,
  }));
const artifacts = () =>
  ARTIFACTS.map((name, index) => ({
    id: index + 1,
    name,
    expired: false,
    digest: `sha256:${"b".repeat(64)}`,
    size_in_bytes: 1000,
    workflow_run: { id: 100, head_sha: context.sha },
  }));

test("promotion accepts only complete original same-repository exact-SHA ordinary source runs", () => {
  assertSourceRun(sourceRun(), context);
  for (const mutate of [
    (r) => {
      r.id = 200;
    },
    (r) => {
      r.head_sha = "b".repeat(40);
    },
    (r) => {
      r.workflow_id++;
    },
    (r) => {
      r.path = "other.yml";
    },
    (r) => {
      r.event = "pull_request";
    },
    (r) => {
      r.event = "workflow_dispatch";
    },
    (r) => {
      r.display_title = "CI promotion recycled";
    },
    (r) => {
      r.run_attempt = 2;
    },
    (r) => {
      r.head_branch = "main";
    },
    (r) => {
      r.conclusion = "failure";
    },
    (r) => {
      r.status = "in_progress";
    },
    (r) => {
      r.head_repository.full_name = "fork/repo";
    },
    (r) => {
      r.created_at = "2026-10-23T08:00:00Z";
    },
    (r) => {
      r.updated_at = "2026-10-26T08:00:00Z";
    },
  ]) {
    const run = sourceRun();
    mutate(run);
    assert.throws(() => assertSourceRun(run, context));
  }
});

test("successful source cannot hide failed, cancelled or rerun same-commit peers", () => {
  const good = sourceRun();
  const peer = { ...sourceRun(), id: 101 };
  assertNoFailedPeers([good, peer], context);
  for (const change of [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "timed_out" },
    { conclusion: null },
    { run_attempt: 2 },
    { path: "other.yml" },
    { workflow_id: 43 },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } },
    { status: "unknown" },
    {
      event: "workflow_dispatch",
      display_title: "CI promotion nonce",
      conclusion: "failure",
    },
  ])
    assert.throws(() =>
      assertNoFailedPeers([good, { ...peer, ...change }], context),
    );
  for (const change of [
    { id: context.currentRunId, status: "in_progress", conclusion: null },
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { head_sha: "b".repeat(40), conclusion: "failure" },
    { event: "pull_request", conclusion: "failure" },
    {
      event: "workflow_dispatch",
      display_title: "Browser qualification nonce",
      conclusion: "failure",
    },
  ])
    assertNoFailedPeers([good, { ...peer, ...change }], context);
});

test("failed, missing, duplicate, rerun and reused-runner jobs are ineligible", () => {
  assertJobs(jobs(), sourceRun());
  for (const mutate of [
    (j) => j.pop(),
    (j) => {
      j[1] = clone(j[0]);
    },
    (j) => {
      j[2].runner_id = j[3].runner_id;
    },
    (j) => {
      j[2].labels = ["self-hosted"];
    },
    (j) => {
      j[0].conclusion = "failure";
    },
    (j) => {
      j[0].run_attempt = 2;
    },
    (j) => {
      j[0].head_sha = "b".repeat(40);
    },
  ]) {
    const values = jobs();
    mutate(values);
    assert.throws(() => assertJobs(values, sourceRun()));
  }
});

test("artifact provenance, completeness, retention and digests are mandatory", () => {
  assertArtifacts(artifacts(), sourceRun());
  for (const mutate of [
    (a) => a.pop(),
    (a) => {
      a[0].expired = true;
    },
    (a) => {
      a[0].digest = "unsigned";
    },
    (a) => {
      a[0].workflow_run.id++;
    },
    (a) => {
      a[0].workflow_run.head_sha = "b".repeat(40);
    },
    (a) => {
      a[0].size_in_bytes = 2 ** 40;
    },
    (a) => {
      a[1] = clone(a[0]);
    },
  ]) {
    const values = artifacts();
    mutate(values);
    assert.throws(() => assertArtifacts(values, sourceRun()));
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bsd-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of [
    "src",
    "e2e",
    "scripts",
    "public",
    "deploy/report-service",
    ".github/workflows",
    "dist",
    "test-results",
  ])
    mkdirSync(join(root, folder), { recursive: true });
  symlinkSync(
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules/\ndist/\ntest-results/\n",
  );
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "playwright.config.ts"),
    "full fixture configuration",
  );
  writeFileSync(
    join(root, "e2e/promotion.config.ts"),
    "separate stability fixture configuration",
  );
  writeFileSync(
    join(root, "dist/index.html"),
    "immutable synthetic fixture site",
  );
  const policy = [
    { file: "first.e2e.ts", title: "startup", reason: "startup race" },
    {
      file: "second.e2e.ts",
      title: "throughput",
      reason: "throughput regression",
    },
  ];
  const put = (file, data) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  put(join(root, "scripts/browser-promotion-policy.json"), policy);
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "Disposable source fixture",
    ],
  ])
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const build = join(root, "test-results/browser-build.json");
  writeBuildReceipt(root, build, {});
  const artifact = {
    receiptSha256: awaitHash(build),
    files: read(build).files,
  };
  const inputDigest = verificationDigest(root);
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    playwright: read(join(root, "node_modules/@playwright/test/package.json"))
      .version,
    optionalAtlas: false,
    optionalBladeRf: false,
    buildFlags: {},
  };
  const identity = (project, file, title) => {
    const fields = { project, file, titles: [title], repeat: 0 };
    return { ...fields, id: digest(fields) };
  };
  const actual = (id) => ({
    identity: id,
    expectedStatus: "passed",
    annotations: [],
    results: [{ status: "passed", retry: 0 }],
  });
  const full = PROJECTS.flatMap((project) => [
    ...policy.map((entry) => identity(project, entry.file, entry.title)),
    identity(project, "third.e2e.ts", "unrelated integration"),
  ]);
  const makeReceipt = (project, current, narrowed) => {
    const inventory = full.filter(
      (id) =>
        id.project === project && (!narrowed || id.file !== "third.e2e.ts"),
    );
    const selected = inventory.filter((_, index) => index % 2 === current - 1);
    return {
      schemaVersion: 1,
      inputDigest,
      configurationDigest: digest(
        readFileSync(
          join(
            root,
            narrowed ? "e2e/promotion.config.ts" : "playwright.config.ts",
          ),
        ).toString("base64"),
      ),
      environment,
      project,
      shard: { current, total: 2 },
      full: inventory,
      selected,
      actual: selected.map(actual),
      allowedSkips: {},
      status: "passed",
      errors: [],
      ...(project === "chromium-production"
        ? { testedArtifact: artifact }
        : {}),
    };
  };
  const bundle = join(root, "test-results/promotion-source"),
    fresh = join(root, "test-results/fresh");
  const run = sourceRun(),
    ci = {
      schemaVersion: 1,
      headSha: run.head_sha,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      imageOS: "ubuntu24",
      imageVersion: "synthetic-image",
    };
  put(join(bundle, "run.json"), run);
  put(join(bundle, "jobs.json"), jobs());
  put(join(bundle, "artifacts.json"), artifacts());
  put(join(bundle, "ci-context.json"), ci);
  put(join(root, "test-results/ci-context.json"), ci);
  copyFileSync(build, join(bundle, "browser-build.json"));
  const originals = [];
  for (const project of PROJECTS)
    for (const shard of [1, 2]) {
      const name = `browser-check-${project}-${shard}`,
        original = makeReceipt(project, shard, false);
      originals.push(original);
      put(join(bundle, "receipts", name, "coverage-receipt.json"), original);
      put(
        join(fresh, name, "coverage-receipt.json"),
        makeReceipt(project, shard, true),
      );
      put(join(fresh, name, "fresh-context.json"), ci);
    }
  const native = {
    stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        specs: full.map((identity) => ({
          title: identity.titles[0],
          file: identity.file,
          tests: [
            {
              expectedStatus: "passed",
              projectName: identity.project,
              results: [{ status: "passed", retry: 0 }],
            },
          ],
        })),
      },
    ],
  };
  put(join(bundle, "merged-results.json"), native);
  return { root, bundle, fresh, put, originals, native, policy };
}

import { createHash } from "node:crypto";
function awaitHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("composed proof keeps original complete coverage distinct from fresh stability", (t) => {
  const f = fixture(t),
    source = verifyBundle(f.root, f.bundle, {});
  assert.equal(source.coverage.tests, 6);
  assert.equal(verifyFresh(f.root, f.fresh, source).coverage.tests, 4);
  const native = clone(f.native);
  native.suites[0].specs.pop();
  assert.throws(() => assertNative(native, f.originals));
  const duplicate = clone(f.native);
  duplicate.suites[0].specs[1] = clone(duplicate.suites[0].specs[0]);
  assert.throws(() => assertNative(duplicate, f.originals));
  assert.throws(() =>
    expectedStability(f.originals, [
      ...f.policy,
      { file: "missing.e2e.ts", title: "lost", reason: "required regression" },
    ]),
  );
});

test("artifact digest verification rejects same-size tampering and truncation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bsd-promotion-digest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "archive.zip");
  writeFileSync(file, "original");
  const metadata = { size_in_bytes: 8, digest: `sha256:${awaitHash(file)}` };
  verifyArchive(file, metadata);
  writeFileSync(file, "tampered");
  assert.throws(() => verifyArchive(file, metadata));
  writeFileSync(file, "short");
  assert.throws(() => verifyArchive(file, metadata));
});

test("changed assets, source, flags or image context invalidate inherited proof", (t) => {
  const f = fixture(t);
  verifyBundle(f.root, f.bundle, {});
  const index = join(f.root, "dist/index.html"),
    original = readFileSync(index);
  writeFileSync(index, "changed");
  assert.throws(() => verifyBundle(f.root, f.bundle, {}));
  writeFileSync(index, original);
  const file = join(f.root, "test-results/ci-context.json"),
    context = read(file);
  f.put(file, { ...context, imageVersion: "changed" });
  assert.throws(() => verifyBundle(f.root, f.bundle, {}));
  f.put(file, context);
  assert.throws(() =>
    verifyBundle(f.root, f.bundle, { VITE_BUILD_ID: "different" }),
  );
  writeFileSync(join(f.root, "src/changed.ts"), "runtime changed");
  assert.throws(() => verifyBundle(f.root, f.bundle, {}));
});

test("missing stability, retries, skips and different runner context fail promotion", (t) => {
  const f = fixture(t),
    source = verifyBundle(f.root, f.bundle, {});
  const file = join(
      f.fresh,
      `browser-check-${SHARDS[0]}/coverage-receipt.json`,
    ),
    original = read(file);
  for (const mutate of [
    (r) => {
      r.actual.pop();
    },
    (r) => {
      r.actual[0].results[0].retry = 1;
    },
    (r) => {
      r.actual[0].results[0].status = "skipped";
    },
    (r) => {
      r.environment.node = "different";
    },
  ]) {
    const receipt = clone(original);
    mutate(receipt);
    f.put(file, receipt);
    assert.throws(() => verifyFresh(f.root, f.fresh, source));
    f.put(file, original);
  }
  f.put(join(f.fresh, `browser-check-${SHARDS[0]}/fresh-context.json`), {
    ...source.context,
    imageVersion: "different",
  });
  assert.throws(() => verifyFresh(f.root, f.fresh, source));
});

test("ZIP extraction rejects traversal, Windows paths, duplicate members and links before writing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bsd-promotion-zip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, names] of [
    ["valid", ["safe/result.json"]],
    ["parent", ["../outside"]],
    ["windows", ["safe\\outside"]],
    ["duplicate", ["same", "same"]],
    ["link", ["link"]],
  ]) {
    const archive = join(root, index + ".zip"),
      output = join(root, index);
    execFileSync(
      "python3",
      [
        "-c",
        "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1],'w');names=json.loads(sys.argv[2]);[(z.writestr(zipfile.ZipInfo(n),b'fixture') if n!='link' else None) for n in names];i=zipfile.ZipInfo('link');i.external_attr=(0o120777<<16);z.writestr(i,b'elsewhere') if names==['link'] else None;z.close()",
        archive,
        JSON.stringify(names),
      ],
      { stdio: "pipe" },
    );
    if (index === "valid") {
      extractArchive(archive, output);
      assert.equal(readFileSync(join(output, names[0]), "utf8"), "fixture");
    } else assert.throws(() => extractArchive(archive, output), index);
  }
});
