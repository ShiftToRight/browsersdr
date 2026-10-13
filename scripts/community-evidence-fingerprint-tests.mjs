import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fingerprintCommunityEvidence } from "./community-evidence-fingerprint.mjs";

test("feature fingerprints separate CSS from processing and include unknown code, WASM, toolchain and flags", () => {
  const root = mkdtempSync(join(tmpdir(), "browsersdr-evidence-"));
  const write = (name, bytes) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  };
  try {
    for (const name of [
      ".nvmrc",
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.app.json",
      "tsconfig.node.json",
      "index.html",
      "scripts/build-wasm.sh",
      "scripts/build-usrp-b205-no-os.sh",
      "src/main.tsx",
      "src/workers/shared.ts",
      "src/graphics/palette.ts",
      "src/ui/theme.css",
      "src/wasm/pkg/engine.wasm",
      "wasm/engine/src/lib.rs",
      "third_party/core.c",
    ])
      write(name, "initial");
    write(
      "package.json",
      JSON.stringify({ version: "1.0.0", dependencies: { engine: "1" } }),
    );
    write(
      "package-lock.json",
      JSON.stringify({
        version: "1.0.0",
        packages: { "": { version: "1.0.0" }, engine: { version: "1" } },
      }),
    );
    const manifest = {
      schemaVersion: 1,
      features: {
        rds: { buildContext: { flags: {}, compiler: "pinned" } },
        display: { buildContext: { flags: {}, compiler: "pinned" } },
      },
    };
    const get = () =>
      fingerprintCommunityEvidence(root, manifest).evidenceFingerprints;
    const original = get();
    write("src/ui/theme.css", "new cosmetic CSS");
    assert.equal(get().rds, original.rds);
    assert.notEqual(get().display, original.display);
    write(
      "package.json",
      JSON.stringify({ version: "1.1.0", dependencies: { engine: "1" } }),
    );
    write(
      "package-lock.json",
      JSON.stringify({
        version: "1.1.0",
        packages: { "": { version: "1.1.0" }, engine: { version: "1" } },
      }),
    );
    assert.equal(get().rds, original.rds);
    write("src/workers/new-unknown.ts", "new integration dependency");
    const withNewCode = get();
    assert.notEqual(withNewCode.rds, original.rds);
    write("src/wasm/pkg/engine.wasm", "new compiled bytes");
    assert.notEqual(get().rds, withNewCode.rds);
    const beforeFlags = get();
    manifest.features.rds.buildContext.flags = { VITE_PROCESSING: "changed" };
    assert.notEqual(get().rds, beforeFlags.rds);
    manifest.features.rds.exclude = ["src/graphics"];
    const reviewed = get();
    write("src/graphics/palette.ts", "new display palette");
    assert.equal(get().rds, reviewed.rds);
    assert.notEqual(get().display, reviewed.display);
    manifest.features.rds.exclude = ["src/typo"];
    assert.throws(get, /unmatched/);
    manifest.features.rds.exclude = ["../private"];
    assert.throws(get, /exclusion/);
    manifest.features.rds.exclude = [];
    symlinkSync("/etc", join(root, "src", "escape"));
    assert.throws(get, /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
