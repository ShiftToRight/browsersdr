import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function sourceDigest(root) {
  const names = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const rows = [];
  for (const name of names) {
    // Match the release source boundary, including eligible untracked inputs.
    if (name.split("/").includes(".obsidian")) continue;
    let ancestor = dirname(name),
      nested = false;
    while (ancestor !== ".") {
      try {
        if (lstatSync(join(root, ancestor)).isSymbolicLink()) {
          nested = true;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      ancestor = dirname(ancestor);
    }
    if (nested) continue;
    let stat;
    try {
      stat = lstatSync(join(root, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported source input: ${name}`);
    rows.push([
      name,
      stat.mode & 0o111 ? "executable" : "regular",
      stat.isSymbolicLink()
        ? ["link", readlinkSync(join(root, name))]
        : hash(readFileSync(join(root, name))),
    ]);
  }
  return hash(JSON.stringify(rows));
}

export function treeHashes(root) {
  const files = {};
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files[relative(root, path).replaceAll("\\", "/")] = hash(
          readFileSync(path),
        );
      else throw new Error(`Unsupported built artifact entry: ${path}`);
    }
  }
  visit(root);
  if (!files["index.html"]) throw new Error("Built artifact has no index.html");
  return files;
}

function context(root, env) {
  return {
    sourceDigest: sourceDigest(root),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    flags: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith("VITE_"))
        .sort()
        .map(([key, value]) => [key, hash(value)]),
    ),
    tools: Object.fromEntries(
      ["vite", "@playwright/test", "@typescript/native"].map((name) => [
        name,
        JSON.parse(
          readFileSync(join(root, "node_modules", name, "package.json")),
        ).version,
      ]),
    ),
  };
}
export function writeBuildReceipt(root, path, env = process.env) {
  const receipt = {
    schemaVersion: 1,
    context: context(root, env),
    files: treeHashes(join(root, "dist")),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}
export function verifyBuildReceipt(
  root,
  path,
  env = process.env,
  artifact = join(root, "dist"),
) {
  const receipt = JSON.parse(readFileSync(path));
  if (
    receipt.schemaVersion !== 1 ||
    JSON.stringify(receipt.context) !== JSON.stringify(context(root, env))
  )
    throw new Error(
      "Prebuilt source/tool/build flags changed; build a fresh artifact",
    );
  if (JSON.stringify(receipt.files) !== JSON.stringify(treeHashes(artifact)))
    throw new Error("Prebuilt artifact bytes or inventory changed");
  return { receiptSha256: hash(readFileSync(path)), files: receipt.files };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, path = "test-results/browser-build.json"] =
      process.argv.slice(2),
    root = process.cwd();
  if (mode === "build") {
    // A new build deliberately replaces only its own previous build receipt.
    const before = context(root, process.env);
    const result = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    if (JSON.stringify(before) !== JSON.stringify(context(root, process.env)))
      throw new Error("Source/tools changed while building");
    const receipt = {
      schemaVersion: 1,
      context: before,
      files: treeHashes(join(root, "dist")),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
  } else if (mode === "verify") verifyBuildReceipt(root, path);
  else throw new Error("Usage: browser-build.mjs build|verify [receipt]");
}
