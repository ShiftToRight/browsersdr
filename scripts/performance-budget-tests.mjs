import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("./check-performance.mjs", import.meta.url),
);
function fixture(t, sources) {
  const root = mkdtempSync(join(tmpdir(), "browsersdr-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"));
  writeFileSync(
    join(root, "index.html"),
    '<script src="./assets/index-test.js"></script>',
  );
  for (const layer of ["base", "states", "places"])
    writeFileSync(
      join(root, "assets", `natural-earth-10m-${layer}-test.svg`),
      "<svg/>",
    );
  for (const [name, contents] of Object.entries(sources))
    writeFileSync(join(root, "assets", name), contents);
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}
test("receiver bootstrap includes lazy App and all static shared imports once, with cycles bounded", (t) => {
  const result = fixture(t, {
    "index-test.js":
      'import "./shared-test.js"; export const load=()=>import("./App-test.js");',
    "App-test.js": 'import "./shared-test.js"; import "./decoder-test.js";',
    "shared-test.js": 'import "./index-test.js";',
    "decoder-test.js": "export default 42;",
    "LiveGuest-test.js": "export default 'guest only';",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    new Set(JSON.parse(result.stdout).initialFiles),
    new Set([
      "assets/index-test.js",
      "assets/App-test.js",
      "assets/shared-test.js",
      "assets/decoder-test.js",
    ]),
  );
});
test("a tiny HTML entry cannot hide an over-budget lazy receiver dependency", (t) => {
  const result = fixture(t, {
    "index-test.js": 'export const load=()=>import("./App-test.js");',
    "App-test.js": 'import "./large-test.js";',
    "large-test.js": `export default "${randomBytes(600_000).toString("hex")}";`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /initialJsGzipBytes.*exceeds 350000/);
});
test("a missing required receiver module fails the guard", (t) => {
  const result = fixture(t, { "index-test.js": 'import "./missing-test.js";' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
});
