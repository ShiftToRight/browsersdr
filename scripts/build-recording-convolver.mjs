// Optional generator; normal builds use checked-in bytes. Tool dependencies stay separate.
// Usage: node scripts/build-recording-convolver.mjs /path/to/wabt@1.0.37/index.js
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
if (!process.argv[2])
  throw new Error("Supply wabt@1.0.37/index.js in a separate tools directory.");
const toolUrl = pathToFileURL(process.argv[2]);
if (
  JSON.parse(await readFile(new URL("package.json", toolUrl))).version !==
  "1.0.37"
)
  throw new Error("Use pinned wabt 1.0.37 for reproducible output.");
const wabt = await (await import(toolUrl.href)).default();
const source = await readFile(
  new URL("../wasm/recording-convolver.wat", import.meta.url),
  "utf8",
);
// Specialize the common recording kernels without changing the sequence of
// floating-point operations. Keep generic kernels and scalar tails in the WAT
// as the readable reference and fallback for every other supported tap count.
function specialize(source, kind, tapCounts) {
  const begin = `;; SPECIALIZE ${kind}:begin`;
  const end = `;; SPECIALIZE ${kind}:end`;
  if (source.split(begin).length !== 2 || source.split(end).length !== 2)
    throw new Error(`Expected exactly one ${kind} specialization region.`);
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  if (finish < start) throw new Error("Invalid specialization region.");
  let body = source.slice(start + begin.length, finish);
  const variable = kind === "halfband" ? "$start" : "$n";
  const address = `(i32.shl (local.get ${variable}) (i32.const 2))`;
  const load = (tap) => `(v128.load offset=${512 + tap * 4} ${address})`;
  const phase = (tap) =>
    `(i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27 ${load(tap)} ${load(tap + 4)})`;
  for (const taps of [...tapCounts].reverse()) {
    const pairs = [];
    for (
      let tap = 0;
      tap < Math.floor(taps / 2);
      tap += kind === "halfband" ? 2 : 1
    ) {
      const input = kind === "halfband" ? phase : load;
      pairs.push(`(local.set $sum (f32x4.add (local.get $sum) (f32x4.mul
        (f32x4.add ${input(tap)} ${input(taps - 1 - tap)})
        (v128.load32_splat offset=${tap * 4} (i32.const 0)))))`);
    }
    body = `(if (i32.eq (local.get $taps) (i32.const ${taps}))
      (then ${pairs.join("\n")})
      (else ${body}))`;
  }
  return source.slice(0, start) + body + source.slice(finish + end.length);
}
const compiledSource = specialize(
  specialize(source, "convolve", [95]),
  "halfband",
  [15, 31, 95],
);
const module = wabt.parseWat("recording-convolver.wat", compiledSource, {
  simd: true,
  relaxed_simd: false,
});
module.validate({ simd: true, relaxed_simd: false });
const { buffer } = module.toBinary({
  canonicalize_lebs: true,
  write_debug_names: false,
});
if (!WebAssembly.validate(buffer))
  throw new Error("Recording kernel failed host validation.");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rows = [];
for (let offset = 0; offset < buffer.length; offset += 16)
  rows.push(`  ${Array.from(buffer.slice(offset, offset + 16)).join(", ")},`);
await writeFile(
  new URL("../src/radio/recordingConvolverBytes.ts", import.meta.url),
  `// BrowserSDR recording FIR; generated from wasm/recording-convolver.wat.
// Generator: scripts/build-recording-convolver.mjs with wabt 1.0.37.
// Source SHA-256: ${digest(source)}
// Specialized WAT SHA-256: ${digest(compiledSource)}
// Binary SHA-256: ${digest(buffer)}
export const RECORDING_CONVOLVER = new Uint8Array([\n${rows.join("\n")}\n]);\n`,
);
console.log(
  JSON.stringify({
    sourceSha256: digest(source),
    binarySha256: digest(buffer),
    bytes: buffer.length,
  }),
);
module.destroy();
