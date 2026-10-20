import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sourceDigest,
  writeBuildReceipt,
  verifyBuildReceipt,
} from "./browser-build.mjs";
import { browserServers } from "./browser-servers.mjs";
import { riskGroups, assertRiskInventory } from "./browser-release-risk.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bsd-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const name of [
    "dist",
    "test-results",
    ".local",
    "node_modules/vite",
    "node_modules/@playwright/test",
    "node_modules/@typescript/native",
  ])
    mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules/\ndist/\ntest-results/\n.local/\n",
  );
  writeFileSync(join(root, "app.js"), "source");
  writeFileSync(join(root, "dist/index.html"), "built");
  for (const name of ["vite", "@playwright/test", "@typescript/native"])
    writeFileSync(
      join(root, "node_modules", name, "package.json"),
      JSON.stringify({ version: "1" }),
    );
  const receipt = join(root, "test-results/build.json");
  writeBuildReceipt(root, receipt, {});
  return { root, receipt };
}
test("build reuse binds complete artifact bytes, source, tools and build flags", (t) => {
  const { root, receipt } = fixture(t);
  verifyBuildReceipt(root, receipt, {});
  const original = readFileSync(join(root, "dist/index.html"));
  for (const change of ["tamper", "extra", "missing", "link"]) {
    if (change === "tamper")
      writeFileSync(join(root, "dist/index.html"), "changed");
    if (change === "extra") writeFileSync(join(root, "dist/extra"), "extra");
    if (change === "missing") rmSync(join(root, "dist/index.html"));
    if (change === "link") symlinkSync("/tmp", join(root, "dist/link"));
    assert.throws(() => verifyBuildReceipt(root, receipt, {}));
    rmSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.html"), original);
  }
  assert.throws(
    () => verifyBuildReceipt(root, receipt, { VITE_FEATURE: "enabled" }),
    /flags changed/,
  );
  writeFileSync(join(root, "new-source.js"), "new");
  assert.throws(() => verifyBuildReceipt(root, receipt, {}), /flags changed/);
  rmSync(join(root, "new-source.js"));
  writeFileSync(join(root, ".local/private-note"), "excluded");
  verifyBuildReceipt(root, receipt, {});
  writeFileSync(
    join(root, "node_modules/vite/package.json"),
    JSON.stringify({ version: "2" }),
  );
  assert.throws(() => verifyBuildReceipt(root, receipt, {}), /flags changed/);
});
test("source identities cover tracked deletion and executable mode", (t) => {
  const { root } = fixture(t);
  execFileSync("git", ["add", "app.js", ".gitignore"], { cwd: root });
  const before = sourceDigest(root);
  chmodSync(join(root, "app.js"), 0o755);
  assert.notEqual(sourceDigest(root), before);
  rmSync(join(root, "app.js"));
  assert.notEqual(sourceDigest(root), before);
});
test("single-target browser runs start only the required server and verify prebuilt production", (t) => {
  const { root, receipt } = fixture(t);
  assert.equal(
    browserServers(root, { BSD_E2E_TARGET: "chromium-dev" }).length,
    1,
  );
  const prod = browserServers(root, {
    BSD_E2E_TARGET: "chromium-production",
    BSD_E2E_BUILD_RECEIPT: receipt,
  });
  assert.equal(prod.length, 1);
  assert.match(prod[0].command, /^npm run preview/);
  assert.equal(prod[0].reuseExistingServer, false);
  assert.equal(browserServers(root, {}).length, 2);
  assert.throws(() => browserServers(root, { BSD_E2E_TARGET: "unknown" }));
  assert.throws(() => browserServers(root, { BSD_E2E_DEV_PORT: "0" }));
  writeFileSync(join(root, "dist/index.html"), "tampered");
  assert.throws(() =>
    browserServers(root, {
      BSD_E2E_TARGET: "chromium-production",
      BSD_E2E_BUILD_RECEIPT: receipt,
    }),
  );
});
test("early risk inventory requires all nine exact cases including cold repeats and full catalog capture", () => {
  let count = 0;
  for (const group of riskGroups) {
    const cases = group.cases.flatMap(([file, title]) =>
      Array.from({ length: group.repeats }, (_, repeat) => ({
        file,
        titles: [title],
        repeat,
      })),
    );
    count += cases.length;
    assertRiskInventory(cases, group);
    assert.throws(() => assertRiskInventory(cases.slice(1), group));
    assert.throws(() => assertRiskInventory([...cases, cases[0]], group));
    const wrong = structuredClone(cases);
    wrong[0].titles = ["renamed"];
    assert.throws(() => assertRiskInventory(wrong, group));
  }
  assert.equal(count, 9);
});
