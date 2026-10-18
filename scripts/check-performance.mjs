import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { gzipSync } from "node:zlib";
import ts from "typescript";
const root = resolve(process.argv[2] ?? "dist");
const budgets = JSON.parse(
  readFileSync(new URL("../src/performanceBudgets.json", import.meta.url)),
);
const html = readFileSync(join(root, "index.html"), "utf8");
const htmlFiles = [
  ...new Set(
    [...html.matchAll(/(?:src|href)="\.\/([^"?#]+\.js)"/g)].map((m) => m[1]),
  ),
];
if (!htmlFiles.length) throw new Error("No initial script entries found.");
const assets = readdirSync(join(root, "assets"));
// A guest loads separately; opening the receiver always loads the lazy App.
// Follow static imports recursively so splitting a required module cannot
// silently remove its bytes from the unchanged receiver bootstrap budget.
const initialFiles = new Set();
function include(file) {
  const absolute = resolve(root, file);
  if (relative(root, absolute).startsWith(".."))
    throw new Error("Build import escapes site.");
  if (initialFiles.has(file)) return;
  initialFiles.add(file);
  const tree = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  for (const statement of tree.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const imported = statement.moduleSpecifier.text;
      if (imported.startsWith(".") && imported.endsWith(".js"))
        include(relative(root, resolve(dirname(absolute), imported)));
    }
  }
}
for (const file of htmlFiles) include(file);
for (const file of assets.filter((name) => /^App-[^/]+\.js$/.test(name)))
  include(join("assets", file));
const overview = assets.find((name) =>
  /^natural-earth-110m-.*\.svg$/.test(name),
);
const optionalFiles = assets.filter((name) =>
  /^natural-earth-10m-.*\.(svg|js)$/.test(name),
);
for (const layer of ["base", "states", "places"])
  if (
    !optionalFiles.some((name) =>
      name.startsWith(`natural-earth-10m-${layer}-`),
    )
  )
    throw new Error(`Detailed map ${layer} missing.`);
const measured = {
  initialJsGzipBytes: [...initialFiles].reduce(
    (sum, file) => sum + gzipSync(readFileSync(join(root, file))).length,
    0,
  ),
  overviewMapGzipBytes: overview
    ? gzipSync(readFileSync(join(root, "assets", overview))).length
    : 0,
  optionalMapRawBytes: optionalFiles.reduce(
    (sum, file) => sum + readFileSync(join(root, "assets", file)).length,
    0,
  ),
};
console.log(
  JSON.stringify(
    {
      scope:
        "Build artifact bytes; gzip estimates, not server compression or runtime timings",
      initialFiles: [...initialFiles],
      optionalFiles,
      measured,
      budgets,
    },
    null,
    2,
  ),
);
for (const [name, value] of Object.entries(measured))
  if (value > budgets[name])
    throw new Error(`${name}: ${value} exceeds ${budgets[name]}`);
