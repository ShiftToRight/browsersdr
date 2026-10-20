import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const runtimeUrl = new URL("../src/offline/service-worker.js", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Only build-owned static files belong here. Live services/metadata are never
// cached, even if a release operator adds them to the site after this build.
export async function writeOfflineWorker(directory) {
  const entries = [];
  async function visit(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await visit(join(folder, entry.name), name + "/");
      else if (
        entry.isFile() &&
        !["sw.js", "visitor-count.json", "release.json"].includes(name) &&
        !name.endsWith(".map")
      ) {
        const bytes = await readFile(join(folder, entry.name));
        // Production redirects index.html aliases to their directory URL.
        entries.push({
          url:
            name === "index.html" || name.endsWith("/index.html")
              ? name.slice(0, -10)
              : name,
          sha256: digest(bytes),
          size: bytes.length,
        });
      }
    }
  }
  await visit(directory);
  entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  if (!entries.some((entry) => entry.url === ""))
    throw new Error("Offline build has no application document");
  const runtime = await readFile(runtimeUrl, "utf8");
  const version = digest(JSON.stringify(entries) + runtime);
  await writeFile(
    join(directory, "sw.js"),
    `const OFFLINE_BUILD = ${JSON.stringify({ version, entries })};\n${runtime}`,
  );
  return { version, entries };
}

export function offlineApp() {
  let output;
  return {
    name: "browsersdr-offline-app",
    apply: "build",
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
    },
    writeBundle: {
      order: "post",
      async handler() {
        await writeOfflineWorker(output);
      },
    },
  };
}
