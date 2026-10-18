import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertShardUnion,
  digest,
  verificationDigest,
} from "./browser-coverage.mjs";

export function verifyBrowserShards(
  directory,
  { root = process.cwd(), config = join(root, "playwright.config.ts") } = {},
) {
  const receipts = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.name === "coverage-receipt.json")
        receipts.push(JSON.parse(readFileSync(name)));
    }
  }
  visit(directory);
  assertShardUnion(receipts, ["chromium-dev", "chromium-production"]);
  if (
    receipts[0].inputDigest !== verificationDigest(root) ||
    receipts[0].configurationDigest !==
      digest(readFileSync(config).toString("base64"))
  )
    throw new Error(
      "Shard receipts do not match the current verification inputs",
    );
  return {
    schemaVersion: 1,
    status: "passed",
    inputDigest: receipts[0].inputDigest,
    shards: receipts.length,
    tests: receipts.reduce((n, r) => n + r.actual.length, 0),
    skipped: receipts
      .flatMap((r) => r.actual)
      .filter((t) => t.results[0].status === "skipped").length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: verify-browser-shards.mjs ARTIFACT_DIRECTORY");
  const directory = resolve(process.argv[2]);
  const result = verifyBrowserShards(directory);
  writeFileSync(
    join(directory, "coverage-summary.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
