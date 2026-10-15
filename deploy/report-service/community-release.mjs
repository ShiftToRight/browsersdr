import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createCommunityStore } from "./report-service.mjs";

/** Trusted operator operation. Atomically register audited metadata; never rewrite votes. */
export function registerCommunityRelease(
  database,
  metadata,
  historicalBuilds = [],
) {
  const check = metadata.communityCarryCheck;
  const id = metadata.release ?? metadata.id;
  if (
    !check ||
    !Array.isArray(check.features) ||
    !check.features.length ||
    !/^https:\/\/(github\.com|browsersdr\.com)\//.test(check.evidence ?? "") ||
    !Number.isFinite(Date.parse(check.checkedAt)) ||
    Date.parse(check.checkedAt) < Date.parse(metadata.builtAt) ||
    Date.parse(check.checkedAt) > Date.now() ||
    !check.features.every((f) =>
      /^[a-f0-9]{64}$/.test(metadata.evidenceFingerprints?.[f] ?? ""),
    )
  )
    throw new Error(
      "Release requires fingerprints and a completed target integration check after builtAt",
    );
  const store = createCommunityStore(database, { communityReleasePath: null });
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const build of [...historicalBuilds, metadata]) {
      if (!store.registerBuild(build))
        throw new Error("Conflicting immutable build/fingerprint metadata");
    }
    const results = [];
    for (const feature of check.features) {
      const previous = database
        .prepare(
          "SELECT * FROM community_equivalences WHERE target_build=? AND feature=?",
        )
        .get(id, feature);
      if (previous) {
        if (!previous.active) {
          results.push({ feature, status: "revoked" });
          continue;
        }
        if (previous.fingerprint !== metadata.evidenceFingerprints[feature])
          throw new Error("Existing link fingerprint conflict");
        results.push({
          feature,
          status: "retained",
          sourceBuildId: previous.source_build,
        });
        continue;
      }
      // Original, non-expired votes only. Never choose an intermediate carried projection.
      // Maximize compatible setup coverage, then prefer newer originals; never sum builds.
      const source = database
        .prepare(
          `SELECT v.build_id, count(DISTINCT v.cell_key) AS coverage
        FROM community_votes v JOIN community_builds b ON b.id=v.build_id
        JOIN community_fingerprints f ON f.build_id=v.build_id AND f.feature=v.feature
        WHERE v.feature=? AND f.fingerprint=? AND julianday(b.built_at)<julianday(?) AND julianday(v.expires_at)>julianday(?) AND v.review!='excluded'
        GROUP BY v.build_id ORDER BY coverage DESC,julianday(b.built_at) DESC,v.build_id LIMIT 1`,
        )
        .get(
          feature,
          metadata.evidenceFingerprints[feature],
          metadata.builtAt,
          new Date().toISOString(),
        );
      if (!source) {
        results.push({ feature, status: "no-matching-original" });
        continue;
      }
      if (
        !store.registerEquivalence({
          sourceBuildId: source.build_id,
          targetBuildId: id,
          feature,
          fingerprint: metadata.evidenceFingerprints[feature],
          checkedAt: check.checkedAt,
          evidence: check.evidence,
        })
      )
        throw new Error("Equivalence rejected");
      results.push({
        feature,
        status: "registered",
        sourceBuildId: source.build_id,
        setups: source.coverage,
      });
    }
    database.exec("COMMIT");
    return { buildId: id, results };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function verifyCommunityRelease(metadata, receipt, matrix) {
  const id = metadata.release ?? metadata.id;
  if (
    receipt.buildId !== id ||
    matrix.buildId !== id ||
    matrix.schemaVersion !== 2
  )
    throw new Error("Live projection identity mismatch");
  for (const result of receipt.results) {
    if (!["registered", "retained"].includes(result.status)) continue;
    if (
      !matrix.cells.some(
        (cell) =>
          cell.feature === result.feature &&
          cell.carried?.build.id === result.sourceBuildId &&
          cell.carried.equivalence.fingerprint ===
            metadata.evidenceFingerprints[result.feature],
      )
    )
      throw new Error(
        `Registered evidence missing from live projection: ${result.feature}`,
      );
  }
  return {
    buildId: id,
    verified: true,
    carriedCells: matrix.cells.filter((cell) => cell.carried).length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "--verify") {
    const metadata = JSON.parse(readFileSync(process.argv[3], "utf8")),
      receipt = JSON.parse(readFileSync(process.argv[4], "utf8"));
    const response = await fetch(process.argv[5], {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !/no-store/.test(response.headers.get("cache-control")))
      throw new Error("Projection unavailable or cacheable");
    console.log(
      JSON.stringify(
        verifyCommunityRelease(metadata, receipt, await response.json()),
        null,
        2,
      ),
    );
  } else {
    const metadata = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const historical = process.argv[3]
      ? JSON.parse(readFileSync(process.argv[3], "utf8"))
      : [];
    const database = new DatabaseSync(
      process.env.BROWSERSDR_REPORT_DB ??
        "/var/lib/browsersdr-reports/reports.sqlite",
    );
    try {
      database.exec("PRAGMA busy_timeout=5000");
      console.log(
        JSON.stringify(
          registerCommunityRelease(database, metadata, historical),
          null,
          2,
        ),
      );
    } finally {
      database.close();
    }
  }
}
