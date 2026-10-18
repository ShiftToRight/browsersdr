import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  allowedSkips,
  assertComplete,
  assertSameIds,
  assertShardUnion,
  digest,
  verificationDigest,
} from "./browser-coverage.mjs";
import { execute, runBrowserChecks } from "./run-browser-checks.mjs";
import { verifyBrowserShards } from "./verify-browser-shards.mjs";

function identity(title = "case", project = "chromium-dev") {
  const fields = {
    project,
    file: "example.e2e.ts",
    titles: [title],
    repeat: 0,
  };
  return { ...fields, id: digest(fields) };
}
function actual(id = identity(), status = "passed") {
  return {
    identity: id,
    expectedStatus: "passed",
    annotations: [],
    results: [{ status, retry: 0 }],
  };
}
function receipt(project, current, full) {
  const selected = [full[current - 1]];
  return {
    schemaVersion: 1,
    inputDigest: "source",
    configurationDigest: "configuration",
    environment: { node: "22.23.1" },
    project,
    shard: { current, total: 2 },
    full,
    selected,
    actual: selected.map((id) => actual(id)),
    allowedSkips: {},
    status: "passed",
    errors: [],
  };
}

test("receipt identity changes when root HTML, TypeScript build configuration or source policy changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browsersdr-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    "src",
    "e2e",
    "scripts",
    "public",
    "deploy/report-service",
    ".github",
  ])
    mkdirSync(join(root, path), { recursive: true });
  for (const name of [
    "index.html",
    "tsconfig.app.json",
    "tsconfig.e2e.json",
    ".gitignore",
  ]) {
    writeFileSync(join(root, name), "original");
    const before = verificationDigest(root);
    writeFileSync(join(root, name), "changed");
    assert.notEqual(verificationDigest(root), before, name);
  }
});

test("coverage rejects missing, extra and duplicate identities", () => {
  const a = identity(),
    b = identity("other");
  assert.throws(() => assertSameIds([a, b], [a]), /mismatch/);
  assert.throws(() => assertSameIds([a], [a, b]), /mismatch/);
  assert.throws(() => assertSameIds([a, b], [a, a]), /duplicate/);
});

test("passes must be first attempts, complete, and not expected failures", () => {
  const id = identity(),
    manifest = { selected: [id], allowedSkips: {} };
  assertComplete(manifest, [actual()], "passed");
  for (const change of [
    (t) => {
      t.results = [];
    },
    (t) => {
      t.results.push({ status: "passed", retry: 1 });
    },
    (t) => {
      t.results[0].retry = 1;
    },
    (t) => {
      t.results[0].status = "timedOut";
    },
    (t) => {
      t.expectedStatus = "failed";
    },
  ]) {
    const t = actual();
    change(t);
    assert.throws(() => assertComplete(manifest, [t], "passed"));
  }
  assert.throws(() => assertComplete(manifest, [actual()], "interrupted"));
  assert.throws(() =>
    assertComplete(manifest, [actual()], "passed", ["global error"]),
  );
});

test("optional skips require the exact reviewed identity, reason and absent prerequisite", () => {
  const id = identity();
  const policy = [
    {
      file: id.file,
      titles: id.titles,
      reason: "needs fixture",
      requiredEnvironment: "FIXTURE",
    },
  ];
  const t = actual(id, "skipped");
  t.expectedStatus = "skipped";
  const manifest = {
    selected: [id],
    allowedSkips: allowedSkips([id], policy, {}),
  };
  assert.throws(
    () => assertComplete(manifest, [t], "passed"),
    /Unexpected skip/,
  );
  t.annotations = [{ type: "skip", description: "needs fixture" }];
  assertComplete(manifest, [t], "passed");
  assert.deepEqual(allowedSkips([id], policy, { FIXTURE: "/configured" }), {});
  assert.throws(
    () => assertComplete({ ...manifest, allowedSkips: {} }, [t], "passed"),
    /Unexpected skip/,
  );
});

test("shard union requires both complete targets, both shards, identical inputs and no overlapping cases", () => {
  const projects = ["chromium-dev", "chromium-production"];
  const all = projects.flatMap((p) => {
    const full = [identity("first", p), identity("second", p)];
    return [receipt(p, 1, full), receipt(p, 2, full)];
  });
  assertShardUnion(all, projects);
  assert.throws(() => assertShardUnion(all.slice(1), projects), /Missing/);
  for (const change of [
    (r) => {
      r[1] = structuredClone(r[0]);
    },
    (r) => {
      r[1].selected = r[0].selected;
      r[1].actual = r[0].actual;
    },
    (r) => {
      r[1].inputDigest = "other";
    },
    (r) => {
      r[1].configurationDigest = "other";
    },
    (r) => {
      r[1].schemaVersion = 999;
    },
    (r) => {
      r[1].environment.node = "other";
    },
    (r) => {
      r[1].full = [r[1].full[1]];
    },
    (r) => {
      r[1].status = "failed";
    },
  ]) {
    const clone = structuredClone(all);
    change(clone);
    assert.throws(() => assertShardUnion(clone, projects));
  }
});

// These use the real Playwright CLI/reporter lifecycle without opening a browser
// or starting a web server. They distinguish actual orchestration from mocks.
async function fixtureRun(t, body, { retries = 0, globalTimeoutMs } = {}) {
  const root = process.cwd(),
    dir = mkdtempSync(join(tmpdir(), "browsersdr-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = pathToFileURL(
    resolve("node_modules/@playwright/test/index.mjs"),
  ).href;
  writeFileSync(
    join(dir, "fixture.e2e.mjs"),
    `import { test, expect } from ${JSON.stringify(api)};\n${body}\n`,
  );
  const config = join(dir, "config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      testDir: dir,
      testMatch: "*.e2e.mjs",
      workers: 1,
      retries,
      timeout: 5000,
      projects: [{ name: "fixture" }],
    })};\n`,
  );
  const output = join(dir, "run");
  let error;
  try {
    await runBrowserChecks({
      root,
      config,
      output,
      globalTimeoutMs,
      quiet: true,
    });
  } catch (e) {
    error = e;
  }
  return { output, error };
}

test("real CLI writes exact inventory, first-pass receipt, JSON and incremental completion", async (t) => {
  const { output, error } = await fixtureRun(
    t,
    `test('first', () => expect(1).toBe(1)); test('second', () => {});`,
  );
  assert.ifError(error);
  const r = JSON.parse(readFileSync(join(output, "coverage-receipt.json")));
  assert.equal(r.actual.length, 2);
  assert.equal(r.status, "passed");
  assert.equal(
    JSON.parse(readFileSync(join(output, "results.json"))).stats.expected,
    2,
  );
  const events = readFileSync(join(output, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((e) => e.event === "test-end").length, 2);
  assert.equal(events.at(-1).status, "passed");
});

test("real CLI rejects .only during discovery", async (t) => {
  const { error } = await fixtureRun(
    t,
    `test.only('focused', () => {}); test('omitted', () => {});`,
  );
  assert.match(error?.message ?? "", /discovery failed/);
});

test("real CLI cannot accept an unapproved dynamic skip", async (t) => {
  const { output, error } = await fixtureRun(
    t,
    `test('unexpected skip', () => { test.skip(true, 'new skip'); });`,
  );
  assert.ok(error);
  const r = JSON.parse(readFileSync(join(output, "coverage-receipt.json")));
  assert.equal(r.status, "failed");
  assert.match(r.errors.join(), /Unexpected skip/);
});

test("real CLI retry-only success stays blocking and both attempts remain recorded", async (t) => {
  const { output, error } = await fixtureRun(
    t,
    `test('flaky', ({}, info) => expect(info.retry).toBe(1));`,
    { retries: 1 },
  );
  assert.ok(error);
  const r = JSON.parse(readFileSync(join(output, "coverage-receipt.json")));
  assert.equal(r.status, "failed");
  assert.equal(r.actual[0].results.length, 2);
});

test("suite deadline writes interrupted results and journal before outer termination", async (t) => {
  const { output, error } = await fixtureRun(
    t,
    `test('never finishes', async () => { await new Promise(() => {}); });`,
    { globalTimeoutMs: 1200 },
  );
  assert.ok(error);
  const r = JSON.parse(readFileSync(join(output, "coverage-receipt.json")));
  assert.equal(r.status, "failed");
  assert.match(
    readFileSync(join(output, "events.jsonl"), "utf8"),
    /"event":"end"/,
  );
  assert.ok(readFileSync(join(output, "results.json")).length);
});

test("real two-project/two-shard artifacts merge exactly and reject the wrong configuration or a missing receipt", async (t) => {
  const root = process.cwd(),
    dir = mkdtempSync(join(tmpdir(), "browsersdr-shards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixtures = join(dir, "fixtures"),
    artifacts = join(dir, "artifacts"),
    blobs = join(dir, "blobs");
  for (const path of [fixtures, artifacts, blobs]) mkdirSync(path);
  const api = pathToFileURL(
    resolve("node_modules/@playwright/test/index.mjs"),
  ).href;
  for (const name of ["first", "second"])
    writeFileSync(
      join(fixtures, `${name}.e2e.mjs`),
      `import { test, expect } from ${JSON.stringify(api)}; test('${name}', () => expect(1).toBe(1));\n`,
    );
  const config = join(dir, "config.mjs");
  const projects = ["chromium-dev", "chromium-production"];
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      testDir: fixtures,
      testMatch: "*.e2e.mjs",
      fullyParallel: false,
      workers: 1,
      retries: 1,
      timeout: 20000,
      expect: { timeout: 7000 },
      projects: projects.map((name) => ({ name })),
    })};\n`,
  );
  const outputs = [];
  for (const project of projects)
    for (const current of [1, 2]) {
      const output = join(artifacts, `${project}-${current}`);
      outputs.push(output);
      await runBrowserChecks({
        root,
        config,
        project,
        shard: { current, total: 2 },
        output,
        quiet: true,
      });
      for (const name of readdirSync(join(output, "blob"))) {
        assert.equal(
          existsSync(join(blobs, name)),
          false,
          "Blob names must be unique across projects/shards",
        );
        copyFileSync(join(output, "blob", name), join(blobs, name));
      }
    }
  const summary = verifyBrowserShards(artifacts, { root, config });
  assert.equal(summary.tests, 4);
  assert.equal(summary.shards, 4);
  assert.throws(
    () => verifyBrowserShards(artifacts),
    /current verification inputs/,
  );
  const merged = join(dir, "merged.json");
  const result = await execute(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "merge-reports",
      "--reporter=json",
      blobs,
    ],
    {
      cwd: root,
      quiet: true,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: merged },
      logFile: join(dir, "merge.log"),
    },
  );
  assert.equal(result.code, 0);
  const report = JSON.parse(readFileSync(merged));
  assert.equal(report.stats.expected, 4);
  assert.equal(report.stats.unexpected, 0);
  rmSync(join(outputs[0], "coverage-receipt.json"));
  assert.throws(
    () => verifyBrowserShards(artifacts, { root, config }),
    /Missing/,
  );
});
