import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const revision = "b5f7d71c5e9b5a76093ba55c515968dc40f92804";
const [checkout, outputArgument] = process.argv.slice(2);
if (!checkout)
  throw new Error(
    "Usage: node scripts/check-pocsag-reference.mjs PINNED_CHECKOUT [OUTPUT_DIRECTORY]",
  );
const root = resolve(checkout),
  output = resolve(outputArgument ?? ".local/pocsag-reference");
mkdirSync(output, { recursive: true });
const run = (name, args, options = {}) =>
  execFileSync(name, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
if (run("git", ["-C", root, "rev-parse", "HEAD"]).trim() !== revision)
  throw new Error("POCSAG reference revision mismatch");
if (run("git", ["-C", root, "diff", "--name-only"]).trim())
  throw new Error("POCSAG reference source is modified");
const build = join(output, "native-build");
const env = { ...process.env, CCACHE_DISABLE: "1" };
writeFileSync(
  join(output, "build.log"),
  run(
    "cmake",
    [
      "-S",
      root,
      "-B",
      build,
      "-DPULSE_AUDIO_SUPPORT=OFF",
      "-DX11_SUPPORT=OFF",
      "-DBUILD_GEN_NG=ON",
    ],
    { env },
  ) + run("cmake", ["--build", build, "--parallel", "2"], { env }),
);
writeFileSync(
  join(output, "ctest.log"),
  run("ctest", ["--test-dir", build, "--output-on-failure"]),
);
const binary = join(build, "multimon-ng"),
  generator = join(build, "gen-ng");
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const cases = [];
function reference(id, rate, input, extra = []) {
  const args = [
    "-q",
    "-c",
    "-a",
    `POCSAG${rate}`,
    "-P",
    "auto",
    "-b",
    "2",
    "-C",
    "US",
    "-f",
    "alpha",
    "--json",
    "-t",
    "raw",
    input,
    ...extra,
  ];
  const stdout = run(binary, args);
  const rows = stdout.trim()
    ? stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  writeFileSync(join(output, `${id}.jsonl`), stdout);
  cases.push({ id, rate, inputSha256: sha(input), reference: rows, args });
}
for (const rate of [512, 1200, 2400]) {
  const input = join(output, `${rate}.s16le`),
    source = join(root, "test/samples", `POCSAG_sample_-_${rate}_bps.flac`);
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-ac",
    "1",
    "-ar",
    "22050",
    "-f",
    "s16le",
    input,
  ]);
  reference(String(rate), rate, input);
  const id = `generated-${rate}`,
    generated = join(output, `${id}.s16le`);
  run(generator, [
    "-t",
    "raw",
    "-P",
    `BROWSER POCSAG ${rate}`,
    "-A",
    "123456",
    "-B",
    String(rate),
    generated,
  ]);
  reference(id, rate, generated);
}
for (const name of [
  "pocsag_clean",
  "pocsag_1bit",
  "pocsag_2bit",
  "pocsag_inv_clean",
  "pocsag_inv_1bit",
  "pocsag_inv_2bit",
]) {
  const path = join(output, `${name}.s16le`);
  copyFileSync(join(root, "test/samples/bch_reference", `${name}.raw`), path);
  reference(name, 1200, path);
}
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      schema: "browsersdr-pocsag-reference-v1",
      inspectedAt: new Date().toISOString(),
      revision,
      binarySha256: sha(binary),
      node: process.version,
      endianness: "LE required by s16le comparison fixtures",
      cases,
      knownDifference: {
        fixture: "1200",
        referenceOnly: { address: 671968, function: 1 },
        invalidBatchBoundary: "0xffffffff instead of 0x7cd215d8",
        policy:
          "Intentional framing difference: native tracing finds an information word at the required next batch-sync position before this address. BrowserSDR rejects that invalid continuation. Both result lists remain asserted; the original RF transmission is unknown.",
      },
    },
    null,
    2,
  ) + "\n",
);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "src/pocsag/reference.test.ts",
    "--reporter=verbose",
  ],
  { stdio: "inherit", env: { ...process.env, POCSAG_REFERENCE_DIR: output } },
);
process.exitCode = result.status ?? 1;
