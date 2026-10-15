import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createReportServer } from "./report-service.mjs";
import {
  registerCommunityRelease,
  verifyCommunityRelease,
} from "./community-release.mjs";
const hash = "a".repeat(64);
function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = createReportServer({
    database: db,
    communityReleasePath: null,
  }).community;
  const source = {
    id: "release-source-original",
    version: "1.0.0",
    builtAt: new Date(Date.now() - 120000).toISOString(),
    evidenceFingerprints: { access: hash },
  };
  const target = {
    id: "release-target-current",
    version: "1.1.0",
    builtAt: new Date(Date.now() - 60000).toISOString(),
    evidenceFingerprints: { access: hash },
    communityCarryCheck: {
      features: ["access"],
      checkedAt: new Date().toISOString(),
      evidence: "https://browsersdr.com/community-evidence/target.json",
    },
  };
  store.registerBuild(source);
  const report = {
    schemaVersion: 2,
    reportType: "compatibility",
    reportId: "BC-11111111-1111-4111-a111-111111111111",
    createdAt: new Date().toISOString(),
    build: { id: source.id, version: source.version, builtAt: source.builtAt },
    participantToken: "a".repeat(64),
    setup: {
      source: "rtl-sdr",
      hardwareId: "rtl-unknown",
      mode: "WBFM",
      srdProtocol: null,
      rateHz: 2400000,
      nativeRateHz: 2400000,
      protocolProfile: null,
      firmwareVersion: null,
      origin: "live",
    },
    environment: {
      browser: "Chrome 154",
      operatingSystem: "Linux",
      renderer: "canvas2d",
    },
    durationMinutes: 10,
    testScope: "smoke",
    observations: [{ feature: "access", result: "working" }],
    notes: "Synthetic admin regression only",
  };
  assert.equal(store.accept(report).status, 202);
  return { db, store, source, target, report };
}
test("automatic release registration preserves original rows, produces carried counts and is idempotent", () => {
  const { db, store, source, target } = fixture();
  try {
    const before = db.prepare("SELECT * FROM community_votes").all();
    const result = registerCommunityRelease(db, target);
    assert.equal(result.results[0].sourceBuildId, source.id);
    assert.deepEqual(db.prepare("SELECT * FROM community_votes").all(), before);
    const matrix = store.matrix(target.id);
    assert.equal(verifyCommunityRelease(target, result, matrix).verified, true);
    assert.throws(
      () => verifyCommunityRelease(target, result, { ...matrix, cells: [] }),
      /missing/,
    );
    assert.equal(matrix.cells[0].eligibleWorking, 0);
    assert.equal(matrix.cells[0].carried.eligibleWorking, 1);
    assert.equal(
      registerCommunityRelease(db, target).results[0].status,
      "retained",
    );
  } finally {
    db.close();
  }
});
test("changed inputs, expired/excluded originals and intermediate carried builds cannot provide inherited evidence", () => {
  const { db, store, target } = fixture();
  try {
    const intermediate = { ...target, id: "release-intermediate" };
    registerCommunityRelease(db, intermediate);
    db.prepare("UPDATE community_votes SET expires_at=?").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const result = registerCommunityRelease(db, target);
    assert.equal(result.results[0].status, "no-matching-original");
    assert.equal(store.matrix(target.id).cells.length, 0);
  } finally {
    db.close();
  }
});
test("unknown fingerprint and excluded evidence produce explicit no-match decisions", () => {
  const { db, target } = fixture();
  try {
    db.prepare("UPDATE community_votes SET review='excluded'").run();
    assert.equal(
      registerCommunityRelease(db, target).results[0].status,
      "no-matching-original",
    );
  } finally {
    db.close();
  }
  const f = fixture();
  try {
    f.target.evidenceFingerprints.access = "b".repeat(64);
    assert.equal(
      registerCommunityRelease(f.db, f.target).results[0].status,
      "no-matching-original",
    );
  } finally {
    f.db.close();
  }
});
test("future or missing checks cannot register; conflicts roll back complete metadata batch", () => {
  const { db, target, source } = fixture();
  try {
    assert.throws(
      () =>
        registerCommunityRelease(db, {
          ...target,
          communityCarryCheck: undefined,
        }),
      /completed/,
    );
    assert.throws(
      () =>
        registerCommunityRelease(db, {
          ...target,
          communityCarryCheck: {
            ...target.communityCarryCheck,
            checkedAt: new Date(Date.now() + 60000).toISOString(),
          },
        }),
      /completed/,
    );
    const before = db.prepare("SELECT * FROM community_builds").all();
    assert.throws(
      () =>
        registerCommunityRelease(db, target, [
          { ...source, id: "valid-batch-insertion" },
          { ...source, version: "9.9.9" },
        ]),
      /Conflicting/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM community_builds").all(),
      before,
    );
  } finally {
    db.close();
  }
});
test("revoked links stay revoked on automatic retries", () => {
  const { db, store, target } = fixture();
  try {
    registerCommunityRelease(db, target);
    store.revokeEquivalence(target.id, "access");
    assert.equal(
      registerCommunityRelease(db, target).results[0].status,
      "revoked",
    );
    assert.equal(store.matrix(target.id).cells.length, 0);
  } finally {
    db.close();
  }
});

test("source selection uses one original with the most setup coverage, never stacks builds", () => {
  const { db, store, source, target, report } = fixture();
  try {
    const newer = {
      ...source,
      id: "release-newer-original",
      builtAt: new Date(Date.now() - 90000).toISOString(),
    };
    assert.equal(store.registerBuild(newer), true);
    assert.equal(
      store.accept({
        ...report,
        build: newer,
        reportId: "BC-22222222-2222-4222-a222-222222222222",
        participantToken: "b".repeat(64),
      }).status,
      202,
    );
    assert.equal(
      store.accept({
        ...report,
        reportId: "BC-33333333-3333-4333-a333-333333333333",
        setup: { ...report.setup, rateHz: 1024000, nativeRateHz: 1024000 },
        participantToken: "c".repeat(64),
      }).status,
      202,
    );
    const receipt = registerCommunityRelease(db, target);
    assert.equal(receipt.results[0].sourceBuildId, source.id);
    assert.equal(receipt.results[0].setups, 2);
    assert.equal(store.matrix(target.id).cells.length, 2);
  } finally {
    db.close();
  }
});
