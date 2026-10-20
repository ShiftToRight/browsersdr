import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
// Input is the output of Atlas's `signal-atlas-public-frequencies export`.
// BrowserSDR does not maintain a second frequency catalog.
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: node scripts/update-frequency-snapshot.mjs ATLAS-EXPORT.json",
  );
const raw = readFileSync(path);
if (raw.length > 8 * 1024 * 1024) throw new Error("Catalog exceeds 8 MiB");
const snapshot = JSON.parse(raw);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
if (
  snapshot.schema_version !== "public-frequency-catalog-v1" ||
  !Array.isArray(snapshot.profiles) ||
  snapshot.profiles.length > 5000 ||
  !Number.isFinite(Date.parse(snapshot.published_at)) ||
  new Set(snapshot.profiles.map((p) => p.id)).size !==
    snapshot.profiles.length ||
  createHash("sha256").update(canonical(snapshot.profiles)).digest("hex") !==
    snapshot.revision
)
  throw new Error("Invalid Atlas export");
const { profiles, ...metadata } = snapshot;
writeFileSync(
  new URL("../src/radio/shared-frequency-guides.json", import.meta.url),
  JSON.stringify(profiles, null, 2) + "\n",
);
writeFileSync(
  new URL("../src/radio/shared-frequency-snapshot.json", import.meta.url),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    revision: snapshot.revision,
    profiles: profiles.length,
    published_at: snapshot.published_at,
  }),
);
