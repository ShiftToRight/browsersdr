import { execFileSync } from "node:child_process";

// Review tracked AND eligible untracked names: packaging can include both.
const paths = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
).split("\0").filter(Boolean);
const rootFiles = new Set([
  ".dockerignore", ".gitignore", ".nvmrc", ".prettierignore", ".prettierrc.json",
  "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md", "eslint.config.js",
  "index.html", "package-lock.json", "package.json", "playwright.config.ts",
  "tsconfig.app.json", "tsconfig.e2e.json", "tsconfig.json", "tsconfig.node.json",
  "vite.config.ts", "vitest.config.ts",
]);
const softwareRoots = [
  ".github/workflows/", "src/", "e2e/", "wasm/", "third_party/",
  "deploy/report-service/", "scripts/", "assets/", "public/",
];
const privatePaths = /^(?:BrowserSDR(?:\/|$)|docs(?:\/|$)|samples\/|visualizations\/|deploy\/(?:README\.md|apache\/|visitors\/|hosteurope-release\.sh|seo-apache\.py)|scripts\/(?:create-release\.py|verify-production\.mjs))|(?:^|\/)(?:AGENTS\.md|\.obsidian|\.env(?:\.[^/]*)?|\.local|\.agents|\.codex)(?:\/|$)/i;
const privateExtensions = /\.(?:sigmf-data|sigmf-meta|cu8|ci8|ci16|rbf|hex|pem|key|sqlite(?:3|-wal|-shm)?|db|har|log)$/i;
const rejected = [...new Set(paths)].filter(name =>
  (!rootFiles.has(name) && !softwareRoots.some(prefix => name.startsWith(prefix)))
  || privatePaths.test(name) || privateExtensions.test(name)
  || (name.startsWith("public/brand/") && name !== "public/brand/logo-observatory-dish-v3-theme-aligned.png"),
);
if (rejected.length) {
  console.error("Files outside the reviewed public source boundary:");
  rejected.forEach(name => console.error(`  ${name}`));
  process.exitCode = 1;
} else {
  console.log(`Public source boundary passed (${new Set(paths).size} entries).`);
}
