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
const module = wabt.parseWat("recording-convolver.wat", source, {
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
