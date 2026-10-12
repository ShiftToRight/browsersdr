import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
const root = resolve(process.argv[2] ?? "dist");
const budgets = JSON.parse(readFileSync(new URL("../src/performanceBudgets.json", import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const initialFiles = [...new Set([...html.matchAll(/(?:src|href)="\.\/([^"?#]+\.js)"/g)].map(m => m[1]))];
if (!initialFiles.length) throw new Error("No initial script entries found.");
const assets = readdirSync(join(root, "assets"));
const overview = assets.find(name => /^natural-earth-110m-.*\.svg$/.test(name));
if (!overview) throw new Error("Local overview map missing.");
const optionalFiles = assets.filter(name => /^natural-earth-10m-.*\.(svg|js)$/.test(name));
const measured = {
  initialJsGzipBytes: initialFiles.reduce((sum, file) => sum + gzipSync(readFileSync(join(root, file))).length, 0),
  overviewMapGzipBytes: gzipSync(readFileSync(join(root, "assets", overview))).length,
  optionalMapRawBytes: optionalFiles.reduce((sum, file) => sum + readFileSync(join(root, "assets", file)).length, 0),
};
console.log(JSON.stringify({ scope: "Build artifact bytes; gzip estimates, not server compression or runtime timings", initialFiles, optionalFiles, measured, budgets }, null, 2));
for (const [name, value] of Object.entries(measured)) if (value > budgets[name]) throw new Error(`${name}: ${value} exceeds ${budgets[name]}`);
