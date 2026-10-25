import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSameIds, digest } from "./browser-coverage.mjs";
import { verifyBuildReceipt } from "./browser-build.mjs";
import { verifyBrowserShards } from "./verify-browser-shards.mjs";

export const PROJECTS = ["chromium-dev", "chromium-production"];
export const SHARDS = PROJECTS.flatMap((project) =>
  [1, 2].map((shard) => `${project}-${shard}`),
);
export const JOBS = [
  "quality",
  "browser-coverage",
  ...PROJECTS.flatMap((p) => [1, 2].map((s) => `browser (${p}, ${s})`)),
];
export const ARTIFACTS = [
  "browser-build",
  "browser-coverage",
  ...SHARDS.map((name) => `browser-check-${name}`),
];
export const read = (path) => JSON.parse(readFileSync(path));
const shaPattern = /^[a-f0-9]{40}$/;

export function assertSourceRun(
  run,
  { repository, sha, workflowId, currentRunId, now = Date.now() },
) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(sha, shaPattern);
  assert(
    Number.isSafeInteger(run.id) && run.id > 0 && run.id !== currentRunId,
    "Invalid/circular source run",
  );
  assert.equal(run.head_sha, sha, "Source commit changed");
  assert.equal(run.workflow_id, workflowId, "Workflow identity changed");
  assert.equal(run.path, ".github/workflows/ci.yml");
  assert.equal(run.event, "push", "Only ordinary repository push CI qualifies");
  assert.equal(
    run.display_title,
    `CI ${sha}`,
    "Recursive/partial/stamped qualification is ineligible",
  );
  assert.equal(run.run_attempt, 1, "Reruns cannot qualify promotion");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.repository?.full_name, repository);
  assert.equal(
    run.head_repository?.full_name,
    repository,
    "Fork evidence is ineligible",
  );
  assert(
    typeof run.head_branch === "string" &&
      run.head_branch !== "main" &&
      run.head_branch.length > 0,
    "Require the original branch execution",
  );
  const created = Date.parse(run.created_at),
    updated = Date.parse(run.updated_at);
  assert(
    Number.isFinite(created) &&
      Number.isFinite(updated) &&
      updated >= created &&
      now >= updated &&
      now - created <= 24 * 60 * 60_000,
    "Source proof expired or has an invalid date",
  );
}

// A green sibling cannot erase known failures or prior attempts at this commit.
// Dedicated stamped qualification has a different build context and stays separate.
export function assertNoFailedPeers(
  runs,
  { repository, sha, workflowId, currentRunId },
) {
  assert(Array.isArray(runs));
  for (const run of runs) {
    if (run.head_sha !== sha || run.id === currentRunId) continue;
    const relevant =
      run.event === "push" ||
      (run.event === "workflow_dispatch" &&
        typeof run.display_title === "string" &&
        run.display_title.startsWith("CI promotion "));
    if (!relevant) continue;
    assert(Number.isSafeInteger(run.id) && run.id > 0);
    assert.equal(run.workflow_id, workflowId);
    assert.equal(run.path, ".github/workflows/ci.yml");
    assert.equal(run.repository?.full_name, repository);
    assert.equal(run.head_repository?.full_name, repository);
    assert.equal(run.run_attempt, 1, `Same-commit run ${run.id} was rerun`);
    assert(
      run.status === "completed" ||
        ["queued", "in_progress", "waiting", "requested", "pending"].includes(
          run.status,
        ),
      `Unknown same-commit run status: ${run.status}`,
    );
    if (run.status === "completed")
      assert.equal(
        run.conclusion,
        "success",
        `Same-commit run ${run.id} did not succeed; qualify a corrected commit`,
      );
    else assert.equal(run.conclusion, null);
  }
}

export function assertJobs(jobs, run) {
  assert.equal(jobs.length, JOBS.length, "Missing/extra jobs");
  assert.deepEqual(jobs.map((job) => job.name).sort(), [...JOBS].sort());
  assert.equal(new Set(jobs.map((job) => job.id)).size, JOBS.length);
  for (const job of jobs) {
    assert.equal(job.run_id, run.id);
    assert.equal(job.head_sha, run.head_sha);
    assert.equal(job.run_attempt, 1);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    assert(
      job.labels?.includes("ubuntu-latest") &&
        !job.labels.includes("self-hosted"),
      "Require the reviewed hosted environment",
    );
  }
  return browserRunners(jobs);
}

export function browserRunners(jobs) {
  const runners = jobs
    .filter((job) => job.name.startsWith("browser ("))
    .map((job) => job.runner_id);
  assert.equal(runners.length, 4);
  assert(runners.every((id) => Number.isSafeInteger(id) && id > 0));
  assert.equal(
    new Set(runners).size,
    4,
    "Require four separate hosted runners",
  );
  return runners.sort((a, b) => a - b);
}

export function assertArtifacts(artifacts, run) {
  assert.equal(artifacts.length, ARTIFACTS.length);
  assert.deepEqual(
    artifacts.map((item) => item.name).sort(),
    [...ARTIFACTS].sort(),
  );
  assert.equal(
    new Set(artifacts.map((item) => item.id)).size,
    ARTIFACTS.length,
  );
  for (const artifact of artifacts) {
    assert(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.equal(artifact.expired, false);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
    assert(
      Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= 1024 ** 3,
    );
    assert.equal(artifact.workflow_run?.id, run.id);
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  }
}

export function assertNative(report, receipts) {
  const tests = [];
  function walk(suite, titles = [], nested = false) {
    const path = nested ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const fields = {
          project: test.projectName,
          file: spec.file,
          titles: [...path, spec.title],
          repeat: 0,
        };
        tests.push({ ...test, identity: { ...fields, id: digest(fields) } });
      }
    for (const child of suite.suites ?? []) walk(child, path, true);
  }
  for (const suite of report.suites ?? []) walk(suite);
  const actual = receipts.flatMap((receipt) => receipt.actual);
  assertSameIds(
    actual.map((test) => test.identity),
    tests.map((test) => test.identity),
  );
  assert.equal(tests.length, actual.length, "Native report lost cases");
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.flaky, 0);
  assert.equal(
    report.stats.skipped,
    actual.filter((test) => test.results[0].status === "skipped").length,
  );
  assert.equal(report.stats.expected + report.stats.skipped, tests.length);
  for (const test of tests) {
    assert.equal(
      test.results[0]?.status,
      actual.find((item) => item.identity.id === test.identity.id)?.results[0]
        .status,
      "Native outcome differs from the guarded result",
    );
    assert.equal(
      test.expectedStatus,
      test.results[0]?.status === "skipped" ? "skipped" : "passed",
    );
    assert.equal(test.results.length, 1);
    assert.equal(test.results[0].retry, 0);
    assert(["passed", "skipped"].includes(test.results[0].status));
  }
}

export function loadReceipts(directory) {
  return SHARDS.map((name) =>
    read(join(directory, `browser-check-${name}`, "coverage-receipt.json")),
  );
}

export function expectedStability(receipts, policy) {
  assert(Array.isArray(policy) && policy.length > 0);
  const keys = policy.map(({ file, title, reason }) => {
    assert(typeof reason === "string" && reason.length > 0);
    assert(typeof file === "string" && /^[\w-]+\.e2e\.ts$/.test(file));
    assert(typeof title === "string" && title.length > 0);
    return JSON.stringify([file, title]);
  });
  assert.equal(
    new Set(keys).size,
    keys.length,
    "Duplicate stability policy entry",
  );
  return PROJECTS.flatMap((project) => {
    const full = receipts.find((receipt) => receipt.project === project)?.full;
    assert(full, "Missing original target");
    return policy.map(({ file, title }) => {
      const matches = full.filter(
        (test) =>
          test.file === file &&
          test.titles.join(" > ") === title &&
          test.repeat === 0,
      );
      assert.equal(
        matches.length,
        1,
        `Required stability identity missing/ambiguous: ${project} ${file} ${title}`,
      );
      return matches[0];
    });
  });
}

export function verifyBundle(
  root,
  bundle,
  env = process.env,
  { requireStability = true } = {},
) {
  const run = read(join(bundle, "run.json")),
    jobs = read(join(bundle, "jobs.json")),
    artifacts = read(join(bundle, "artifacts.json"));
  assertJobs(jobs, run);
  assertArtifacts(artifacts, run);
  const receipts = loadReceipts(join(bundle, "receipts"));
  const coverage = verifyBrowserShards(join(bundle, "receipts"), { root });
  const original = verifyBuildReceipt(
    root,
    join(bundle, "browser-build.json"),
    env,
  );
  assert.deepEqual(
    original,
    verifyBuildReceipt(
      root,
      join(root, "test-results/browser-build.json"),
      env,
    ),
    "Fresh quality build differs from the full-source tested bytes",
  );
  const context = read(join(bundle, "ci-context.json"));
  assert.equal(context.schemaVersion, 1);
  assert.equal(context.headSha, run.head_sha);
  assert.equal(context.node, process.version);
  assert.equal(context.platform, process.platform);
  assert.equal(context.arch, process.arch);
  assert.equal(typeof context.imageOS, "string");
  assert.equal(typeof context.imageVersion, "string");
  assert(context.imageOS.length > 0 && context.imageVersion.length > 0);
  assert.deepEqual(
    context,
    read(join(root, "test-results/ci-context.json")),
    "Runner image, workflow, lockfile or tool context changed",
  );
  assert.equal(
    JSON.stringify(envFlags(env)),
    "{}",
    "Stamped/custom contexts require fresh full qualification",
  );
  const playwright = read(
    join(root, "node_modules/@playwright/test/package.json"),
  ).version;
  for (const receipt of receipts) {
    assert.equal(receipt.environment.node, process.version);
    assert.equal(receipt.environment.platform, process.platform);
    assert.equal(receipt.environment.arch, process.arch);
    assert.equal(receipt.environment.playwright, playwright);
    assert.equal(receipt.environment.optionalAtlas, false);
    assert.equal(receipt.environment.optionalBladeRf, false);
    assert.deepEqual(receipt.environment.buildFlags, {});
    if (receipt.project === "chromium-production")
      assert.deepEqual(receipt.testedArtifact, original);
  }
  assertNative(read(join(bundle, "merged-results.json")), receipts);
  const wanted = requireStability
    ? expectedStability(
        receipts,
        read(join(root, "scripts/browser-promotion-policy.json")),
      )
    : [];
  return {
    run,
    jobs,
    artifacts,
    receipts,
    coverage,
    original,
    wanted,
    context,
  };
}

function envFlags(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("VITE_")),
  );
}

export function verifyFresh(root, directory, source) {
  const coverage = verifyBrowserShards(directory, {
    root,
    config: join(root, "e2e/promotion.config.ts"),
  });
  const receipts = loadReceipts(directory);
  for (const name of SHARDS)
    assert.deepEqual(
      read(join(directory, `browser-check-${name}/fresh-context.json`)),
      source.context,
      "Stability runner image/context changed",
    );
  for (const project of PROJECTS) {
    const group = receipts.filter((receipt) => receipt.project === project);
    assertSameIds(
      source.wanted.filter((test) => test.project === project),
      group[0].full,
    );
    const environment = source.receipts.find(
      (receipt) => receipt.project === project,
    ).environment;
    for (const receipt of group) {
      assert.deepEqual(
        receipt.environment,
        environment,
        "Fresh stability environment changed",
      );
      if (project === "chromium-production")
        assert.deepEqual(receipt.testedArtifact, source.original);
      assert(
        receipt.actual.every((test) => test.results[0].status === "passed"),
        "Fresh stability cannot skip a selected test",
      );
    }
  }
  return { coverage, receipts };
}
