import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function testIdentity(test, rootDir) {
  const titles = [test.title];
  for (let suite = test.parent; suite; suite = suite.parent)
    if (suite.type === "describe") titles.unshift(suite.title);
  const identity = {
    project: test.parent.project()?.name ?? "",
    file: relative(rootDir, test.location.file).replaceAll("\\", "/"),
    titles,
    repeat: test.repeatEachIndex,
  };
  return { ...identity, id: digest(identity) };
}

// Hash runtime, tests and verification inputs without reading optional credentials,
// recordings, private operator files, generated results or installed dependencies.
export function verificationDigest(root) {
  const hashes = [];
  function visit(path) {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true,
    })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        hashes.push([
          name,
          digest(readFileSync(join(root, name)).toString("base64")),
        ]);
      else throw new Error(`Unexpected verification input: ${name}`);
    }
  }
  for (const path of [
    "src",
    "e2e",
    "scripts",
    "public",
    "deploy/report-service",
    ".github",
  ])
    visit(path);
  for (const name of readdirSync(root).filter((name) =>
    /^(package(?:-lock)?\.json|index\.html|tsconfig(?:\.[^.]+)*\.json|.*config\.(?:ts|json|js)|\.(?:nvmrc|gitignore|dockerignore|prettierignore|prettierrc\.json))$/.test(
      name,
    ),
  ))
    hashes.push([
      name,
      digest(readFileSync(join(root, name)).toString("base64")),
    ]);
  return digest(hashes.sort(([a], [b]) => a.localeCompare(b)));
}

export function assertInventory(tests) {
  if (!Array.isArray(tests) || !tests.length)
    throw new Error("Empty browser inventory");
  const ids = new Set();
  for (const { id, ...identity } of tests) {
    if (id !== digest(identity) || ids.has(id))
      throw new Error("Invalid or duplicate test identity");
    ids.add(id);
  }
  return ids;
}

export function assertSameIds(expected, actual) {
  const wanted = assertInventory(expected),
    found = assertInventory(actual);
  if (wanted.size !== found.size || [...wanted].some((id) => !found.has(id)))
    throw new Error(
      "Browser inventory mismatch: missing, extra or filtered cases",
    );
}

export function allowedSkips(tests, policy, env = process.env) {
  return Object.fromEntries(
    tests.flatMap((test) => {
      const rule = policy.find(
        (rule) =>
          rule.file === test.file &&
          JSON.stringify(rule.titles) === JSON.stringify(test.titles),
      );
      return rule && !env[rule.requiredEnvironment]
        ? [[test.id, rule.reason]]
        : [];
    }),
  );
}

export function assertComplete(manifest, actual, status, errors = []) {
  assertSameIds(
    manifest.selected,
    actual.map(({ identity }) => identity),
  );
  if (status !== "passed" || errors.length)
    throw new Error(`Browser run did not pass: ${status}`);
  for (const test of actual) {
    const label = `${test.identity.file}: ${test.identity.titles.join(" > ")}`;
    if (test.results.length !== 1)
      throw new Error(`Missing attempt or retry: ${label}`);
    const attempt = test.results[0];
    if (attempt.retry !== 0) throw new Error(`Retried case: ${label}`);
    if (attempt.status === "skipped") {
      const reason = manifest.allowedSkips[test.identity.id];
      if (
        !reason ||
        !test.annotations.some(
          (a) => a.type === "skip" && a.description === reason,
        )
      )
        throw new Error(`Unexpected skip: ${label}`);
    } else if (
      attempt.status !== "passed" ||
      test.expectedStatus !== "passed"
    ) {
      throw new Error(`Unsuccessful or expected-failure case: ${label}`);
    }
  }
}

export function assertShardUnion(receipts, projects, total = 2) {
  if (receipts.some((receipt) => receipt.schemaVersion !== 1))
    throw new Error("Unsupported shard receipt schema");
  if (receipts.length !== projects.length * total)
    throw new Error("Missing or extra shard receipts");
  const inputs = new Set(
    receipts.map((r) =>
      JSON.stringify([r.inputDigest, r.configurationDigest, r.environment]),
    ),
  );
  if (inputs.size !== 1)
    throw new Error("Shard source/configuration/tool/environment mismatch");
  for (const project of projects) {
    const group = receipts.filter((r) => r.project === project);
    if (
      group.length !== total ||
      new Set(group.map((r) => r.shard?.current)).size !== total ||
      group.some(
        (r) =>
          r.shard?.total !== total ||
          r.shard.current < 1 ||
          r.shard.current > total,
      )
    )
      throw new Error(`Missing or duplicate shards: ${project}`);
    const full = group[0].full;
    if (
      new Set(group.map((r) => JSON.stringify(r.testedArtifact ?? null)))
        .size !== 1
    )
      throw new Error(`Shard tested artifact mismatch: ${project}`);
    if (full.some((test) => test.project !== project))
      throw new Error(`Wrong project in full inventory: ${project}`);
    for (const receipt of group) {
      assertSameIds(full, receipt.full);
      assertComplete(receipt, receipt.actual, receipt.status, receipt.errors);
    }
    assertSameIds(
      full,
      group.flatMap((r) => r.selected),
    );
  }
}
