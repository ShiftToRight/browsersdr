import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyBuildReceipt,
  writeBuildReceipt,
  treeHashes,
} from "./browser-build.mjs";
import { digest } from "./browser-coverage.mjs";
import { verifyBrowserShards } from "./verify-browser-shards.mjs";

const git = (root, ...args) =>
  execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validateStamp(root, stamp) {
  if (
    JSON.stringify(Object.keys(stamp).sort()) !==
      JSON.stringify(
        [
          "release",
          "commit",
          "version",
          "sourceSha256",
          "workingTreeDirty",
          "builtAt",
          "node",
          "sharingService",
        ].sort(),
      ) ||
    stamp.commit !== git(root, "rev-parse", "HEAD") ||
    Boolean(git(root, "status", "--porcelain")) ||
    stamp.version !==
      JSON.parse(readFileSync(join(root, "package.json"))).version ||
    stamp.node !== "22.23.1" ||
    process.version !== "v22.23.1" ||
    stamp.workingTreeDirty !== false ||
    !hex(stamp.sourceSha256) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(stamp.builtAt) ||
    !Number.isFinite(Date.parse(stamp.builtAt)) ||
    new Date(stamp.builtAt).toISOString() !==
      stamp.builtAt.replace("Z", ".000Z") ||
    stamp.release !==
      `${stamp.builtAt.replaceAll(/[-:]/g, "")}-${stamp.commit.slice(0, 7)}-${stamp.sourceSha256.slice(0, 12)}` ||
    JSON.stringify(Object.keys(stamp.sharingService ?? {}).sort()) !==
      JSON.stringify(["protocol", "sourceSha256", "version"]) ||
    stamp.sharingService.version !== "0.1.0" ||
    stamp.sharingService.protocol !== 1 ||
    !hex(stamp.sharingService.sourceSha256)
  )
    throw new Error("Invalid stamped artifact identity/source/runtime");
  return stamp;
}
export function stampedEnvironment(stamp, env = process.env) {
  if (
    Object.keys(env).some(
      (key) =>
        key.startsWith("VITE_") &&
        !["VITE_BUILD_ID", "VITE_BUILD_TIMESTAMP"].includes(key),
    )
  )
    throw new Error("Custom Vite flags need independent qualification");
  for (const [key, value] of Object.entries({
    VITE_BUILD_ID: stamp.release,
    VITE_BUILD_TIMESTAMP: stamp.builtAt,
  }))
    if (env[key] !== undefined && env[key] !== value)
      throw new Error("Conflicting release stamp flags");
  return {
    ...env,
    VITE_BUILD_ID: stamp.release,
    VITE_BUILD_TIMESTAMP: stamp.builtAt,
  };
}
export function verifyStampedArtifact(root, artifact, receipt, stamp) {
  validateStamp(root, stamp);
  const tested = verifyBuildReceipt(
    root,
    receipt,
    stampedEnvironment(stamp, {}),
    artifact,
  );
  if (
    JSON.stringify(JSON.parse(readFileSync(join(artifact, "release.json")))) !==
    JSON.stringify(stamp)
  )
    throw new Error("Stamped release metadata changed");
  return tested;
}
export function assertServiceBoundary(root) {
  const allowed = new Set([
    "live-sharing.e2e.ts",
    "helpers/sharingSignaling.ts",
  ]);
  const visit = (folder, prefix = "") => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + entry.name,
        path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path, name + "/");
      else if (
        entry.isFile() &&
        /\.[cm]?[jt]sx?$/.test(name) &&
        /BSD_E2E_SHARING_|sharingSignaling|\/api\/v1\/sharing/.test(
          readFileSync(path, "utf8"),
        ) &&
        !allowed.has(name)
      )
        throw new Error(
          `Actual-service dependency scope changed: ${name}; review the promotion boundary`,
        );
    }
  };
  visit(join(root, "e2e"));
}
export function verifyStampedCoverage(root, artifacts, stamp) {
  assertServiceBoundary(root);
  const artifact = join(artifacts, "browser-build", "dist"),
    receipt = join(
      artifacts,
      "browser-build",
      "test-results/browser-build.json",
    ),
    tested = verifyStampedArtifact(root, artifact, receipt, stamp),
    coverage = verifyBrowserShards(artifacts, { root }),
    flags = Object.fromEntries(
      Object.entries(stampedEnvironment(stamp, {}))
        .sort()
        .map(([key, value]) => [key, digest(value)]),
    );
  const production = [];
  for (const project of ["chromium-dev", "chromium-production"])
    for (const shard of [1, 2]) {
      const result = JSON.parse(
        readFileSync(
          join(
            artifacts,
            `browser-check-${project}-${shard}`,
            "coverage-receipt.json",
          ),
        ),
      );
      if (
        JSON.stringify(result.environment.buildFlags) !==
          JSON.stringify(flags) ||
        result.environment.node !== process.version ||
        result.environment.platform !== process.platform ||
        result.environment.arch !== process.arch ||
        result.environment.optionalAtlas ||
        result.environment.optionalBladeRf ||
        result.environment.playwright !==
          JSON.parse(
            readFileSync(
              join(root, "node_modules/@playwright/test/package.json"),
            ),
          ).version
      )
        throw new Error("Unsupported stamped browser environment");
      if (project === "chromium-production") {
        if (JSON.stringify(result.testedArtifact) !== JSON.stringify(tested))
          throw new Error("Production shard tested another artifact");
        production.push(result);
      }
    }
  return { coverage, tested, production };
}

export function verifyReleaseEnvelope(site, testedFiles, stamp) {
  const files = treeHashes(site),
    auditPath = `community-evidence/${stamp.release}.json`;
  const metadata = JSON.parse(readFileSync(join(site, "release.json")));
  const { communityCarryCheck, evidenceFingerprints, ...identity } = metadata;
  if (
    JSON.stringify(identity) !== JSON.stringify(stamp) ||
    !communityCarryCheck ||
    !evidenceFingerprints
  )
    throw new Error("Release envelope identity or carry metadata changed");
  const audit = JSON.parse(readFileSync(join(site, auditPath)));
  if (
    JSON.stringify(audit.build) !== JSON.stringify(stamp) ||
    JSON.stringify(audit.check) !== JSON.stringify(communityCarryCheck) ||
    JSON.stringify(audit.evidenceFingerprints) !==
      JSON.stringify(evidenceFingerprints) ||
    communityCarryCheck.testedSiteSha256 !== digest(testedFiles)
  )
    throw new Error(
      "Release envelope evidence does not bind the tested artifact",
    );
  const executable = { ...files };
  delete executable[auditPath];
  executable["release.json"] = testedFiles["release.json"];
  if (JSON.stringify(executable) !== JSON.stringify(testedFiles))
    throw new Error(
      "Sealing changed tested HTML/executable/assets or added files",
    );
  return {
    schemaVersion: 1,
    testedSiteSha256: digest(testedFiles),
    finalSiteSha256: digest(files),
    auditPath,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode] = process.argv.slice(2),
    root = process.cwd();
  const raw = process.env.BSD_RELEASE_STAMP;
  if (mode === "env") {
    if (raw) {
      const stamp = validateStamp(root, JSON.parse(raw));
      const env = stampedEnvironment(stamp);
      appendFileSync(
        process.env.GITHUB_ENV,
        `VITE_BUILD_ID=${env.VITE_BUILD_ID}\nVITE_BUILD_TIMESTAMP=${env.VITE_BUILD_TIMESTAMP}\n`,
      );
    }
  } else if (mode === "build") {
    const stamp = raw ? validateStamp(root, JSON.parse(raw)) : undefined;
    const env = stamp ? stampedEnvironment(stamp) : process.env;
    const result = spawnSync(
      process.execPath,
      ["scripts/browser-build.mjs", "build"],
      { cwd: root, env, stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
    if (stamp) {
      const receipt = join(root, "test-results/browser-build.json");
      const before = JSON.parse(readFileSync(receipt));
      verifyBuildReceipt(root, receipt, env);
      writeFileSync(
        join(root, "dist/release.json"),
        JSON.stringify(stamp, null, 2) + "\n",
        { flag: "wx" },
      );
      const pending = receipt + ".stamped";
      const final = writeBuildReceipt(root, pending, env);
      if (JSON.stringify(before.context) !== JSON.stringify(final.context))
        throw new Error("Source/tools changed while stamping the artifact");
      renameSync(pending, receipt);
    }
  } else
    throw new Error(
      "Usage: browser-stamped-artifact.mjs env|build (BSD_RELEASE_STAMP JSON)",
    );
}
