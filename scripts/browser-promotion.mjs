import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHARDS,
  assertArtifacts,
  assertJobs,
  assertNative,
  assertNoFailedPeers,
  assertSourceRun,
  browserRunners,
  read,
  verifyBundle,
  verifyFresh,
} from "./browser-promotion-core.mjs";
import { assertSameIds } from "./browser-coverage.mjs";
import { verifyBuildReceipt } from "./browser-build.mjs";
import { runBrowserChecks } from "./run-browser-checks.mjs";

const root = process.cwd();
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const git = (...args) =>
  execFileSync("git", ["--no-optional-locks", ...args], {
    encoding: "utf8",
  }).trim();
const save = (file, data) => {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
};
const bundlePath = join(root, "test-results/promotion-source");

export function verifyArchive(archive, metadata) {
  assert.equal(
    statSync(archive).size,
    metadata.size_in_bytes,
    "Artifact size mismatch",
  );
  assert.equal(
    `sha256:${sha(archive)}`,
    metadata.digest,
    "Authoritative artifact digest mismatch",
  );
}

function ciContext() {
  assert(
    process.env.ImageOS && process.env.ImageVersion,
    "Require an identified hosted runner image",
  );
  return {
    schemaVersion: 1,
    headSha: git("rev-parse", "HEAD"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    lockfileSha256: sha("package-lock.json"),
    workflowSha256: sha(".github/workflows/ci.yml"),
  };
}

function repository() {
  const name = process.env.GITHUB_REPOSITORY;
  assert(
    typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name),
    "Set the exact repository",
  );
  return name;
}

async function api(path) {
  assert(
    path.startsWith(`/repos/${repository()}/actions/`),
    "Unexpected API scope",
  );
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(60_000),
  });
  assert(response.ok, `GitHub metadata request failed: ${response.status}`);
  return response.json();
}

async function pages(path, field) {
  const values = [];
  for (let page = 1; page <= 30; page++) {
    const data = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert(Array.isArray(data[field]));
    values.push(...data[field]);
    if (data[field].length < 100) return values;
  }
  throw Error("Unexpected GitHub pagination limit");
}

async function metadata(id) {
  assert(/^[1-9][0-9]*$/.test(String(id)) && Number.isSafeInteger(Number(id)));
  const path = `/repos/${repository()}/actions/runs/${id}`;
  const run = await api(path);
  const [jobs, artifacts] = await Promise.all([
    pages(`${path}/attempts/1/jobs`, "jobs"),
    pages(`${path}/artifacts`, "artifacts"),
  ]);
  return { run, jobs, artifacts };
}

export function extractArchive(archive, target) {
  // Inspect every ZIP member before extraction; reject traversal, alias paths,
  // links and bombs. Never execute downloaded scripts or load remote configuration.
  execFileSync(
    "python3",
    [
      "-c",
      String.raw`
from pathlib import Path, PurePosixPath
import shutil, stat, sys, zipfile
archive,target=Path(sys.argv[1]),Path(sys.argv[2])
assert not target.exists()
with zipfile.ZipFile(archive) as z:
 names=set();total=0
 for entry in z.infolist():
  p=PurePosixPath(entry.filename)
  assert p.parts and not p.is_absolute() and '..' not in p.parts and '\\' not in entry.filename and ':' not in entry.filename
  assert str(p) not in names and not stat.S_ISLNK(entry.external_attr>>16)
  assert entry.file_size<=256*1024**2
  names.add(str(p));total+=entry.file_size
  assert total<=1024**3
 target.mkdir(parents=True)
 for entry in z.infolist():
  dest=target/entry.filename
  if entry.is_dir():dest.mkdir(parents=True,exist_ok=True)
  else:
   dest.parent.mkdir(parents=True,exist_ok=True)
   with z.open(entry) as src,dest.open('xb') as dst:shutil.copyfileobj(src,dst)
`,
      archive,
      target,
    ],
    { stdio: "pipe" },
  );
}

async function download(info, output) {
  assertArtifacts(info.artifacts, info.run);
  mkdirSync(output, { recursive: false });
  for (const key of ["run", "jobs", "artifacts"])
    save(join(output, `${key}.json`), info[key]);
  for (const item of info.artifacts) {
    const archive = join(output, `${item.name}.zip`);
    // gh supplies the restricted token through its environment, never shell text.
    const bytes = execFileSync(
      "gh",
      ["api", `repos/${repository()}/actions/artifacts/${item.id}/zip`],
      { maxBuffer: 1024 ** 3 },
    );
    assert.equal(bytes.length, item.size_in_bytes, "Artifact size mismatch");
    writeFileSync(archive, bytes, { flag: "wx" });
    verifyArchive(archive, item);
    extractArchive(archive, join(output, item.name));
  }
}

function localContext() {
  assert.equal(process.version, "v22.23.1");
  assert.equal(
    git("status", "--porcelain=v1", "-uall"),
    "",
    "Promotion requires clean committed source",
  );
  assert.equal(git("rev-parse", "HEAD"), process.env.GITHUB_SHA);
  assert.equal(
    process.env.GITHUB_RUN_ATTEMPT,
    "1",
    "Promotion itself must be a first attempt",
  );
  assert(
    !process.env.BSD_RELEASE_STAMP,
    "Stamped release qualification stays independent",
  );
  for (const key of [
    "BSD04_CONTEXT",
    "BLADERF_OFFICIAL_ARTIFACT_DIR",
    "BROWSERSDR_CENTER_LIVE_DATA",
    "PACKET_REVIEW_FILES",
    "SIGNAL_ATLAS_BSD02_BASE_URL",
    "SIGNAL_ATLAS_BSD03_BASE_URL",
    "BSD01_UPDATE_FIXTURES",
    "GEO1_RECORD_FIXTURE",
    "BSD04_ATLAS_ORIGIN",
    "BSD_E2E_SHARING_REAL",
    "BSD_E2E_SHARING_RELAY",
    "BSD_E2E_SHARING_PROXY",
    "BROWSERSDR_SHARING_PROXY",
    "OVERLAY_REVIEW",
    "BSD_THEME_SCREENSHOT_DIR",
  ])
    assert(
      !process.env[key],
      "Custom fixture environments require full qualification",
    );
}

function sourceContext(current) {
  return {
    repository: repository(),
    sha: git("rev-parse", "HEAD"),
    workflowId: current.workflow_id,
    currentRunId: current.id,
  };
}

async function checkHistory(current) {
  const context = sourceContext(current);
  const runs = await pages(
    `/repos/${repository()}/actions/workflows/${current.workflow_id}/runs?head_sha=${context.sha}`,
    "workflow_runs",
  );
  assertNoFailedPeers(runs, context);
  return runs;
}

function outputPromotion(id = "") {
  assert(process.env.GITHUB_OUTPUT);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `promotion=${id ? "true" : "false"}\npromotion_run_id=${id}\n`,
  );
}

async function prepare() {
  const requested = process.env.BSD_PROMOTION_RUN_ID ?? "";
  const automatic =
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.BSD_MAIN_PROMOTION_ENABLED === "true";
  if (!requested && !automatic) {
    outputPromotion();
    return;
  }
  localContext();
  const current = await api(
    `/repos/${repository()}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  );
  assert.equal(current.head_sha, process.env.GITHUB_SHA);
  assert.equal(current.run_attempt, 1);
  assert(["push", "workflow_dispatch"].includes(current.event));
  const context = sourceContext(current);
  const runs = await checkHistory(current);
  let id = requested;
  if (!id) {
    const eligible = runs
      .filter((run) => {
        try {
          assertSourceRun(run, context);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.id - a.id);
    if (!eligible.length) {
      outputPromotion();
      console.log("No qualifying original source run; complete CI required.");
      return;
    }
    id = String(eligible[0].id);
  }
  const info = await metadata(id);
  assertSourceRun(info.run, context);
  assertJobs(info.jobs, info.run);
  const downloaded = join(root, `test-results/promotion-downloads-${id}`);
  await download(info, downloaded);
  mkdirSync(bundlePath);
  save(join(bundlePath, "run.json"), info.run);
  save(join(bundlePath, "jobs.json"), info.jobs);
  save(join(bundlePath, "artifacts.json"), info.artifacts);
  copyFileSync(
    join(downloaded, "browser-build/test-results/browser-build.json"),
    join(bundlePath, "browser-build.json"),
  );
  copyFileSync(
    join(downloaded, "browser-build/test-results/ci-context.json"),
    join(bundlePath, "ci-context.json"),
  );
  const original = verifyBuildReceipt(
    root,
    join(bundlePath, "browser-build.json"),
    process.env,
    join(downloaded, "browser-build/dist"),
  );
  assert.deepEqual(
    original,
    verifyBuildReceipt(root, "test-results/browser-build.json"),
  );
  for (const name of SHARDS) {
    const target = join(bundlePath, "receipts", `browser-check-${name}`);
    mkdirSync(target, { recursive: true });
    copyFileSync(
      join(downloaded, `browser-check-${name}/coverage-receipt.json`),
      join(target, "coverage-receipt.json"),
    );
  }
  copyFileSync(
    join(downloaded, "browser-coverage/merged-results.json"),
    join(bundlePath, "merged-results.json"),
  );
  const source = verifyBundle(root, bundlePath);
  // Recheck the authoritative attempt after all downloads/verification.
  assertSourceRun(
    await api(`/repos/${repository()}/actions/runs/${id}`),
    context,
  );
  save(join(bundlePath, "transport-proof.json"), {
    sourceRunId: Number(id),
    artifactDigests: Object.fromEntries(
      info.artifacts.map((item) => [
        item.name,
        { id: item.id, digest: item.digest, bytes: item.size_in_bytes },
      ]),
    ),
    fullCoverage: source.coverage,
    expectedFreshIdentities: source.wanted.length,
  });
  await checkHistory(current);
  outputPromotion(id);
  console.log(
    JSON.stringify({
      sourceRunId: Number(id),
      completeInheritedIdentities: source.coverage.tests,
      requiredFreshIdentities: source.wanted.length,
    }),
  );
}

async function stability(project, shard) {
  localContext();
  const source = verifyBundle(root, bundlePath);
  assert.deepEqual(
    ciContext(),
    source.context,
    "Fresh stability runner context changed",
  );
  await runBrowserChecks({
    root,
    config: join(root, "e2e/promotion.config.ts"),
    project,
    shard: { current: Number(shard), total: 2 },
    output: "test-results/guarded",
    inventoryCheck: (inventory) =>
      assertSameIds(
        source.wanted.filter((test) => test.project === project),
        inventory,
      ),
  });
  save("test-results/guarded/fresh-context.json", ciContext());
}

async function verify(directory, currentRunId = process.env.GITHUB_RUN_ID) {
  localContext();
  const source = verifyBundle(root, bundlePath);
  const current = await api(
    `/repos/${repository()}/actions/runs/${currentRunId}`,
  );
  assert.equal(current.head_sha, process.env.GITHUB_SHA);
  assert.equal(current.path, ".github/workflows/ci.yml");
  assert.equal(current.run_attempt, 1);
  assert.equal(current.repository?.full_name, repository());
  assert.equal(current.head_repository?.full_name, repository());
  assert(
    (current.event === "push" && current.head_branch === "main") ||
      (current.event === "workflow_dispatch" &&
        current.display_title.startsWith("CI promotion ")),
    "Not an explicitly identified promotion run",
  );
  assertSourceRun(source.run, sourceContext(current));
  const authoritative = await metadata(source.run.id);
  assertSourceRun(authoritative.run, sourceContext(current));
  assertJobs(authoritative.jobs, authoritative.run);
  assertArtifacts(authoritative.artifacts, authoritative.run);
  for (const expected of source.artifacts) {
    const actual = authoritative.artifacts.find(
      (item) => item.id === expected.id,
    );
    assert(
      actual &&
        actual.digest === expected.digest &&
        actual.name === expected.name &&
        actual.size_in_bytes === expected.size_in_bytes,
      "Source artifact identity changed",
    );
  }
  const fresh = verifyFresh(root, directory, source);
  const jobs = await pages(
    `/repos/${repository()}/actions/runs/${currentRunId}/attempts/1/jobs`,
    "jobs",
  );
  const browsers = jobs.filter((job) => job.name.startsWith("browser ("));
  for (const job of browsers) {
    assert.equal(job.run_id, current.id);
    assert.equal(job.head_sha, current.head_sha);
    assert.equal(job.run_attempt, 1);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    assert(
      job.labels.includes("ubuntu-latest") &&
        !job.labels.includes("self-hosted"),
    );
  }
  const runners = browserRunners(browsers);
  assert(
    runners.every((id) => !browserRunners(source.jobs).includes(id)),
    "Fresh stability must use independent runner instances",
  );
  await checkHistory(current);
  const result = {
    schemaVersion: 1,
    kind: "full-source-coverage-plus-independent-stability",
    status: "passed",
    headSha: current.head_sha,
    runId: current.id,
    sourceRunId: source.run.id,
    inheritedFullTests: source.coverage.tests,
    inheritedApprovedSkips: source.coverage.skipped,
    freshStabilityTests: fresh.coverage.tests,
    freshSkipped: fresh.coverage.skipped,
    freshRunnerIds: runners,
    originalFullRunnerIds: browserRunners(source.jobs),
    runtimeArtifact: source.original,
    independentFullMainExecution: false,
    canReplaceMainBrowserGate:
      current.event === "push" && current.head_branch === "main",
    deploymentGatesRemainRequired: true,
  };
  save(join(directory, "promotion-summary.json"), result);
  console.log(JSON.stringify(result));
  return { result, fresh };
}

async function audit(id, output) {
  localContext();
  const info = await metadata(id);
  assert.equal(info.run.head_sha, process.env.GITHUB_SHA);
  assert.equal(info.run.path, ".github/workflows/ci.yml");
  assert.equal(info.run.repository?.full_name, repository());
  assert.equal(info.run.head_repository?.full_name, repository());
  assert(
    Date.now() - Date.parse(info.run.created_at) <= 24 * 60 * 60_000,
    "CI evidence is older than the reviewed promotion window",
  );
  assert.equal(info.run.run_attempt, 1);
  assert.equal(info.run.status, "completed");
  assert.equal(info.run.conclusion, "success");
  assertJobs(info.jobs, info.run);
  await checkHistory(info.run);
  await download(info, output);
  assert(
    !existsSync(bundlePath),
    "Use a clean audit checkout, not overwritten proof",
  );
  const inherited = existsSync(
    join(output, "browser-build/test-results/promotion-source"),
  );
  if (!inherited) {
    assert.equal(
      info.run.event,
      "push",
      "Full fallback requires ordinary push CI",
    );
    assert.equal(info.run.display_title, `CI ${info.run.head_sha}`);
    execFileSync("python3", [
      "-c",
      "import shutil,sys;from pathlib import Path;s=Path(sys.argv[1]);r=Path(sys.argv[2]);assert not (r/'dist').exists();shutil.copytree(s/'dist',r/'dist');(r/'test-results').mkdir(exist_ok=True);[(shutil.copyfile(s/'test-results'/n,r/'test-results'/n)) for n in ['browser-build.json','ci-context.json']]",
      join(output, "browser-build"),
      root,
    ]);
    mkdirSync(bundlePath);
    for (const key of ["run", "jobs", "artifacts"])
      save(join(bundlePath, `${key}.json`), info[key]);
    for (const name of ["browser-build.json", "ci-context.json"])
      copyFileSync(join(root, "test-results", name), join(bundlePath, name));
    for (const name of SHARDS) {
      const target = join(bundlePath, "receipts", `browser-check-${name}`);
      mkdirSync(target, { recursive: true });
      copyFileSync(
        join(output, `browser-check-${name}/coverage-receipt.json`),
        join(target, "coverage-receipt.json"),
      );
    }
    copyFileSync(
      join(output, "browser-coverage/merged-results.json"),
      join(bundlePath, "merged-results.json"),
    );
    const full = verifyBundle(root, bundlePath, process.env, {
      requireStability: false,
    });
    assert.deepEqual(
      full.coverage,
      read(
        join(
          output,
          "browser-coverage/browser-artifacts/coverage-summary.json",
        ),
      ),
    );
    const latest = await api(`/repos/${repository()}/actions/runs/${id}`);
    assert.equal(latest.run_attempt, 1);
    assert.equal(latest.status, "completed");
    assert.equal(latest.conclusion, "success");
    assert.equal(latest.head_sha, process.env.GITHUB_SHA);
    await checkHistory(info.run);
    const result = {
      schemaVersion: 1,
      kind: "independent-full-ordinary-ci",
      status: "passed",
      headSha: info.run.head_sha,
      runId: info.run.id,
      freshFullTests: full.coverage.tests,
      approvedSkips: full.coverage.skipped,
      fullRunnerIds: browserRunners(info.jobs),
      independentFullMainExecution: info.run.head_branch === "main",
      canReplaceMainBrowserGate: info.run.head_branch === "main",
      deploymentGatesRemainRequired: true,
      allCurrentArtifactDigestsReverified: true,
    };
    save(join(output, "audit-result.json"), result);
    console.log(JSON.stringify(result));
    return;
  }
  // The current quality artifact carries the original proof, visibly separate
  // from fresh receipts. Restore only evidence and immutable site, never source.
  execFileSync("python3", [
    "-c",
    "import shutil,sys;from pathlib import Path;s=Path(sys.argv[1]);r=Path(sys.argv[2]);shutil.copytree(s/'dist',r/'dist',dirs_exist_ok=True);shutil.copytree(s/'test-results/promotion-source',r/'test-results/promotion-source');shutil.copyfile(s/'test-results/browser-build.json',r/'test-results/browser-build.json');shutil.copyfile(s/'test-results/ci-context.json',r/'test-results/ci-context.json')",
    join(output, "browser-build"),
    root,
  ]);
  const sourceId = read(join(bundlePath, "run.json")).id;
  const original = await metadata(sourceId);
  const originalDirectory = `${output}-source`;
  await download(original, originalDirectory);
  for (const name of SHARDS)
    assert.deepEqual(
      read(
        join(originalDirectory, `browser-check-${name}/coverage-receipt.json`),
      ),
      read(
        join(
          bundlePath,
          `receipts/browser-check-${name}/coverage-receipt.json`,
        ),
      ),
    );
  assert.deepEqual(
    read(
      join(originalDirectory, "browser-build/test-results/browser-build.json"),
    ),
    read(join(bundlePath, "browser-build.json")),
  );
  assert.deepEqual(
    read(join(originalDirectory, "browser-build/test-results/ci-context.json")),
    read(join(bundlePath, "ci-context.json")),
  );
  assert.deepEqual(
    read(join(originalDirectory, "browser-coverage/merged-results.json")),
    read(join(bundlePath, "merged-results.json")),
  );
  const freshDirectory = join(output, "fresh-only");
  // Never recurse into the inherited receipts carried by browser-build while
  // validating the separate fresh subset.
  for (const name of SHARDS) {
    const target = join(freshDirectory, `browser-check-${name}`);
    mkdirSync(target, { recursive: true });
    for (const file of ["coverage-receipt.json", "fresh-context.json"])
      copyFileSync(
        join(output, `browser-check-${name}`, file),
        join(target, file),
      );
  }
  const { result, fresh } = await verify(freshDirectory, id);
  assertNative(
    read(join(output, "browser-coverage/merged-results.json")),
    fresh.receipts,
  );
  const published = read(
    join(output, "browser-coverage/browser-artifacts/promotion-summary.json"),
  );
  assert.deepEqual(
    result,
    published,
    "Published promotion proof differs from independent audit",
  );
  save(join(output, "audit-result.json"), {
    ...result,
    allCurrentAndOriginalArtifactDigestsReverified: true,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "context") save("test-results/ci-context.json", ciContext());
  else if (mode === "prepare") await prepare();
  else if (mode === "stability") await stability(first, second);
  else if (mode === "verify") await verify(first);
  else if (mode === "audit") await audit(first, resolve(second));
  else
    throw Error(
      "Usage: browser-promotion.mjs prepare|stability PROJECT SHARD|verify ARTIFACTS|audit RUN OUTPUT",
    );
}
