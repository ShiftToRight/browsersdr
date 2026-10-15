import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMUNITY_FEATURE_MODES } from "../deploy/report-service/report-service.mjs";

const configFiles = [
  "package.json",
  "package-lock.json",
  ".nvmrc",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "index.html",
  "scripts/build-wasm.sh",
  "scripts/build-usrp-b205-no-os.sh",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;

/** Conservative default: every runtime source, including integration/UI and compiled WASM.
 * Reviewed exclusions are explicit, hashed into the policy and must match existing paths.
 * This detects changed inputs; only a trusted integration-check record authorizes reuse.
 */
export function fingerprintCommunityEvidence(root, manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.features ||
    typeof manifest.features !== "object" ||
    Array.isArray(manifest.features)
  )
    throw new Error("Expected a schemaVersion 1 feature dependency manifest.");
  root = realpathSync(root);
  const paths = [];
  const walk = (name) => {
    const path = resolve(root, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(
        `Dependency symlink requires an explicit reviewed source copy: ${name}`,
      );
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (["target", "node_modules", ".git"].includes(child)) continue;
        walk(`${name}/${child}`);
      }
    } else if (
      stat.isFile() &&
      !/\.(?:test|spec)\.[^/]+$/.test(name) &&
      !name.startsWith("src/testing/")
    )
      paths.push(name);
  };
  for (const directory of ["src", "wasm", "third_party"]) walk(directory);
  paths.push(...configFiles);
  const evidenceFingerprints = {},
    dependencies = {},
    sourceDependencies = {};
  for (const [feature, policy] of Object.entries(manifest.features)) {
    if (
      !Object.hasOwn(COMMUNITY_FEATURE_MODES, feature) ||
      !policy ||
      typeof policy !== "object" ||
      Array.isArray(policy) ||
      !policy.buildContext ||
      typeof policy.buildContext !== "object" ||
      Array.isArray(policy.buildContext)
    )
      throw new Error(
        `Unknown feature or missing reviewed buildContext: ${feature}`,
      );
    const exclude = policy.exclude ?? [];
    const optionalExclude = policy.optionalExclude ?? [];
    const include = policy.include ?? [];
    const validPath = (name) =>
      typeof name === "string" &&
      /^(?:src|wasm|third_party)\//.test(name) &&
      !name.includes("..") &&
      !name.includes("\\");
    if (
      !Array.isArray(optionalExclude) ||
      !optionalExclude.every(validPath) ||
      !Array.isArray(include) ||
      !include.every((name) => validPath(name) && paths.includes(name))
    )
      throw new Error(
        `Invalid optional exclusions or required inclusion: ${feature}`,
      );
    const variants = policy.reviewedVariants ?? {};
    if (!variants || typeof variants !== "object" || Array.isArray(variants))
      throw new Error("Invalid reviewed variants");
    for (const [name, rule] of Object.entries(variants)) {
      if (
        (!validPath(name) && !configFiles.includes(name)) ||
        !paths.includes(name) ||
        !rule ||
        !/^[a-f0-9]{64}$/.test(rule.anchor) ||
        !Array.isArray(rule.hashes) ||
        !rule.hashes.includes(rule.anchor) ||
        rule.hashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) ||
        typeof rule.reason !== "string" ||
        rule.reason.length < 30
      )
        throw new Error(`Invalid reviewed file equivalence: ${name}`);
    }
    if (
      !Array.isArray(exclude) ||
      exclude.some(
        (name) =>
          typeof name !== "string" ||
          !/^(?:src|wasm|third_party)\//.test(name) ||
          name.includes("..") ||
          name.includes("\\") ||
          !paths.some((path) => path === name || path.startsWith(name + "/")),
      )
    )
      throw new Error(`Invalid or unmatched dependency exclusion: ${feature}`);
    sourceDependencies[feature] = [];
    const entries = paths
      .filter((name) => {
        if (
          feature !== "display" &&
          (name.endsWith(".css") || name.startsWith("src/assets/"))
        )
          return false;
        return (
          include.includes(name) ||
          ![...exclude, ...optionalExclude].some(
            (prefix) => name === prefix || name.startsWith(prefix + "/"),
          )
        );
      })
      .sort()
      .map((name) => {
        let bytes = readFileSync(resolve(root, name));
        if (name === "package.json" || name === "package-lock.json") {
          const value = JSON.parse(bytes.toString());
          // Release numbers alone do not alter dependencies. All other lock/config bytes count.
          delete value.version;
          if (name === "package-lock.json" && value.packages?.[""])
            delete value.packages[""].version;
          bytes = JSON.stringify(stable(value));
        }
        const digest = hash(bytes);
        const rule = variants[name];
        sourceDependencies[feature].push([
          name,
          hash(readFileSync(resolve(root, name))),
        ]);
        return [name, rule?.hashes.includes(digest) ? rule.anchor : digest];
      });
    dependencies[feature] = entries;
    evidenceFingerprints[feature] = hash(
      JSON.stringify(
        stable({
          policyVersion: 1,
          feature,
          exclude: [...exclude].sort(),
          ...(optionalExclude.length
            ? { optionalExclude: [...optionalExclude].sort() }
            : {}),
          ...(include.length ? { include: [...include].sort() } : {}),
          ...(Object.keys(variants).length
            ? {
                reviewedVariantAnchors: Object.fromEntries(
                  Object.entries(variants).map(([name, rule]) => [
                    name,
                    rule.anchor,
                  ]),
                ),
              }
            : {}),
          buildContext: policy.buildContext,
          node: process.version,
          entries,
        }),
      ),
    );
  }
  return { evidenceFingerprints, dependencies, sourceDependencies };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [root, manifestFile, outputFile] = process.argv.slice(2);
  if (!root || !manifestFile || !outputFile)
    throw new Error(
      "Usage: node scripts/community-evidence-fingerprint.mjs FROZEN_SOURCE_ROOT REVIEWED_MANIFEST_JSON OUTPUT_JSON",
    );
  // Refuse accidental overwrite; the output is a new evidence artifact.
  const result = fingerprintCommunityEvidence(
    root,
    JSON.parse(readFileSync(manifestFile, "utf8")),
  );
  if (!relative(resolve(root), resolve(outputFile)).startsWith(".."))
    throw new Error(
      "Write fingerprint evidence outside the frozen source root.",
    );
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
}
