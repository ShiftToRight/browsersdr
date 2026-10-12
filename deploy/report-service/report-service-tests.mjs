import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createReportServer,
  fingerprint,
  sanitizeReport,
  validateReport,
  validateCommunityReport,
} from "./report-service.mjs";

const communityBuild = {
  id: "community-test-build",
  version: "1.0.0-rc.1",
  builtAt: "2026-10-12T00:00:00.000Z",
};
function communityFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    reportType: "compatibility",
    reportId: "BC-11111111-1111-4111-a111-111111111111",
    createdAt: "2026-10-12T00:01:00.000Z",
    build: { ...communityBuild },
    participantToken: "a".repeat(64),
    setup: {
      source: "rtl-sdr",
      hardwareId: "rtl-nesdr-smart-v5",
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
    observations: [{ feature: "rds", result: "working" }],
    notes: "PRIVATE-MARKER not real RF evidence.",
    ...overrides,
  };
}
function communityService() {
  const database = new DatabaseSync(":memory:");
  const service = createReportServer({
    database,
    communityReleasePath: null,
    communityBuilds: [communityBuild],
    allowedOrigin: "https://browsersdr.test",
  });
  return { database, ...service };
}

function fixture() {
  return {
    schemaVersion: 1,
    reportId: "BR-TEST",
    createdAt: new Date().toISOString(),
    trigger: "manual",
    autoSubmitted: false,
    build: { id: "abc" },
    environment: { browser: "Chrome 1" },
    receiver: {
      source: "hackrf",
      sampleRateHz: 9600000,
      exactFrequencyHz: 91400000,
      usbSerial: "secret",
      ipAddress: "192.0.2.12",
    },
    events: [
      {
        id: "1",
        area: "receiver",
        code: "RECEIVER_TERMINAL_FAILURE",
        severity: "error",
        count: 1,
        safeMessage: "stopped",
        context: { fileName: "secret.cu8", forwardedFor: "192.0.2.12" },
      },
    ],
    snapshots: [],
    redaction: { omitted: ["usbSerial"], exactFrequencyIncluded: false },
  };
}

function compatibilityFixture() {
  return {
    schemaVersion: 1,
    reportType: "compatibility",
    reportId: "BC-TEST",
    createdAt: new Date().toISOString(),
    build: { id: "abc" },
    environment: { browser: "Chrome 1", capabilities: { webUsb: true } },
    receiver: {
      source: "hackrf",
      deviceProfile: "HackRF Pro",
      mode: "WBFM",
      sampleRateHz: 9600000,
      lnaGainCode: 16,
      vgaGainDb: 20,
      rfAmplifierEnabled: false,
      exactFrequencyHz: 91400000,
      usbSerial: "secret",
    },
    observations: [{ service: "rds", result: "working" }],
    notes: "Stable for ten minutes.",
    redaction: {
      omitted: ["usbSerial", "exactFrequencyHz"],
      exactFrequencyIncluded: false,
    },
  };
}

test("validates and applies server-side redaction", () => {
  const input = fixture();
  assert.equal(validateReport(input), null);
  const output = sanitizeReport(input);
  assert.equal(output.receiver.exactFrequencyHz, undefined);
  assert.equal(output.receiver.usbSerial, undefined);
  assert.equal(output.receiver.ipAddress, undefined);
  assert.equal(output.events[0].context.fileName, undefined);
  assert.equal(output.events[0].context.forwardedFor, undefined);
  assert.equal(fingerprint(output).length, 64);
});

test("rejects unknown top-level fields and oversized collections", () => {
  assert.match(validateReport({ ...fixture(), samples: [] }), /Unknown/);
  assert.match(
    validateReport({
      ...fixture(),
      events: Array(101).fill(fixture().events[0]),
    }),
    /event collection/,
  );
});

test("accepts, re-redacts and stores a report through the HTTP boundary", async () => {
  const database = new DatabaseSync(":memory:");
  const service = createReportServer({
    database,
    allowedOrigin: "https://browsersdr.test",
  });
  await new Promise((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = service.server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/diagnostic-reports`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://browsersdr.test",
        },
        body: JSON.stringify(fixture()),
      },
    );
    assert.equal(response.status, 202);
    assert.match((await response.json()).reference, /^BR-/);
    const stored = database.prepare("SELECT body FROM reports").get();
    assert.ok(stored);
    const body = JSON.parse(stored.body);
    assert.equal(body.receiver.usbSerial, undefined);
    assert.equal(body.receiver.ipAddress, undefined);
    assert.equal(body.receiver.exactFrequencyHz, undefined);
    assert.equal(
      database.prepare("SELECT count FROM fingerprint_counts").get().count,
      1,
    );
    const rateBucket = database.prepare("SELECT bucket FROM rate_limits").get();
    assert.match(rateBucket.bucket, /^global:\d+$/);
    assert.equal(rateBucket.bucket.includes("127.0.0.1"), false);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
    database.close();
  }
});

test("accepts compatibility evidence on its dedicated endpoint", async () => {
  const database = new DatabaseSync(":memory:");
  const service = createReportServer({
    database,
    allowedOrigin: "https://browsersdr.test",
  });
  await new Promise((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = service.server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/compatibility-reports`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://browsersdr.test",
        },
        body: JSON.stringify(compatibilityFixture()),
      },
    );
    assert.equal(response.status, 202);
    assert.match((await response.json()).reference, /^BC-/);
    const stored = database
      .prepare("SELECT report_type, trigger, body FROM reports")
      .get();
    assert.equal(stored.report_type, "compatibility");
    assert.equal(stored.trigger, "compatibility");
    const body = JSON.parse(stored.body);
    assert.equal(body.receiver.usbSerial, undefined);
    assert.equal(body.receiver.exactFrequencyHz, undefined);
    assert.deepEqual(body.observations, [
      { service: "rds", result: "working" },
    ]);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
    database.close();
  }
});

test("rejects compatibility reports sent to the diagnostic endpoint", async () => {
  const database = new DatabaseSync(":memory:");
  const service = createReportServer({
    database,
    allowedOrigin: "https://browsersdr.test",
  });
  await new Promise((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = service.server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/diagnostic-reports`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://browsersdr.test",
        },
        body: JSON.stringify(compatibilityFixture()),
      },
    );
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
    database.close();
  }
});

test("expires reports and aggregates while idle and clears its retention timer on close", async (t) => {
  const database = new DatabaseSync(":memory:");
  const { server } = createReportServer({ database, cleanupIntervalMs: 10 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  database
    .prepare(
      "INSERT INTO reports(reference, received_at, expires_at, fingerprint, trigger, body) VALUES(?,?,?,?,?,?)",
    )
    .run("expired", "2000-01-01", "2000-01-02", "old", "manual", "{}");
  database
    .prepare(
      "INSERT INTO fingerprint_counts(fingerprint,first_seen,last_seen,expires_at,count) VALUES(?,?,?,?,?)",
    )
    .run("old", "2000-01-01", "2000-01-01", "2000-01-02", 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM reports").get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM fingerprint_counts").get()
      .count,
    0,
  );
});

test("two reviewed independent shared-decoder positives combine across platforms, while access stays separate", async () => {
  const service = communityService();
  await new Promise((resolve) =>
    service.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const post = async (value) => {
      const r = await fetch(`${base}/api/v1/compatibility-reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://browsersdr.test",
        },
        body: JSON.stringify(value),
      });
      assert.equal(r.status, 202);
      return r.json();
    };
    const one = await post(
      communityFixture({
        observations: [
          { feature: "rds", result: "working" },
          { feature: "access", result: "working" },
        ],
      }),
    );
    const two = await post(
      communityFixture({
        participantToken: "b".repeat(64),
        environment: {
          browser: "Edge 154",
          operatingSystem: "Windows",
          renderer: "webgpu",
        },
        observations: [
          { feature: "rds", result: "working" },
          { feature: "access", result: "working" },
        ],
      }),
    );
    let matrix = await (
      await fetch(`${base}/api/v1/compatibility-matrix`)
    ).json();
    assert.equal(matrix.cells.find((c) => c.feature === "rds").working, 2);
    assert.equal(
      matrix.cells.find((c) => c.feature === "rds").status,
      "working",
    );
    assert.equal(service.community.review(one.reference, "accepted"), true);
    assert.equal(service.community.review(two.reference, "accepted"), true);
    matrix = await (await fetch(`${base}/api/v1/compatibility-matrix`)).json();
    const decoder = matrix.cells.find((c) => c.feature === "rds");
    assert.equal(decoder.status, "confirmed");
    assert.equal(decoder.eligibleWorking, 2);
    assert.equal(matrix.cells.filter((c) => c.feature === "access").length, 2);
    assert.equal(
      matrix.cells
        .filter((c) => c.feature === "access")
        .every((c) => c.status === "working"),
      true,
    );
    const json = JSON.stringify(matrix);
    for (const privateValue of [
      "PRIVATE-MARKER",
      "participantToken",
      "receipt",
      one.reference,
      "reportId",
    ])
      assert.equal(json.includes(privateValue), false);
    const stored = JSON.parse(
      service.database.prepare("SELECT body FROM reports LIMIT 1").get().body,
    );
    assert.equal(stored.participantToken, undefined);
    assert.match(stored.notes, /PRIVATE-MARKER/);
    assert.equal(
      (await fetch(`${base}/api/v1/compatibility-matrix?build=unknown`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/compatibility-matrix?build=x&build=y`))
        .status,
      400,
    );
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
    service.database.close();
  }
});

test("idempotent retries and another platform do not inflate one participant; rates, scopes, modes and builds do not merge", () => {
  const s = communityService();
  try {
    const first = s.community.accept(communityFixture());
    assert.equal(first.status, 202);
    assert.deepEqual(s.community.accept(communityFixture()).body, first.body);
    assert.equal(
      s.community.accept(communityFixture({ notes: "changed" })).status,
      409,
    );
    const otherPlatform = s.community.accept(
      communityFixture({
        reportId: "BC-22222222-2222-4222-a222-222222222222",
        environment: {
          browser: "Edge 154",
          operatingSystem: "Windows",
          renderer: "unknown",
        },
      }),
    );
    s.community.review(otherPlatform.body.reference, "accepted");
    assert.equal(s.community.matrix().cells[0].working, 1);
    const differentRate = s.community.accept(
      communityFixture({
        participantToken: "b".repeat(64),
        setup: {
          ...communityFixture().setup,
          rateHz: 1024000,
          nativeRateHz: 1024000,
        },
      }),
    );
    s.community.review(differentRate.body.reference, "accepted");
    const sustained = s.community.accept(
      communityFixture({
        participantToken: "c".repeat(64),
        testScope: "sustained",
        durationMinutes: 30,
      }),
    );
    s.community.review(sustained.body.reference, "accepted");
    s.community.accept(
      communityFixture({
        participantToken: "d".repeat(64),
        observations: [{ feature: "wbfm", result: "working" }],
      }),
    );
    assert.equal(s.community.matrix().cells.length, 4);
    assert.equal(
      s.community.matrix().cells.some((c) => c.status === "confirmed"),
      false,
    );
    assert.equal(
      s.community.accept(
        communityFixture({ build: { ...communityBuild, id: "unregistered" } }),
      ).status,
      400,
    );
    const newer = {
      ...communityBuild,
      id: "community-next-build",
      builtAt: "2026-10-12T01:00:00.000Z",
    };
    s.community.registerBuild(newer);
    assert.deepEqual(s.community.matrix(newer.id).cells, []);
    assert.equal(
      s.community.registerBuild({ ...newer, version: "1.0.0" }),
      false,
    );
  } finally {
    s.database.close();
  }
});

test("short observations cannot confirm, and a corrected positive does not erase an unresolved issue", () => {
  const s = communityService();
  try {
    const short = s.community.accept(communityFixture({ durationMinutes: 1 }));
    s.community.review(short.body.reference, "accepted");
    const second = s.community.accept(
      communityFixture({ participantToken: "b".repeat(64) }),
    );
    s.community.review(second.body.reference, "accepted");
    assert.equal(s.community.matrix().cells[0].eligibleWorking, 1);
    const issue = s.community.accept(
      communityFixture({
        participantToken: "a".repeat(64),
        reportId: "BC-33333333-3333-4333-a333-333333333333",
        observations: [{ feature: "rds", result: "degraded" }],
      }),
    );
    assert.equal(issue.status, 202);
    assert.equal(s.community.matrix().cells[0].status, "issue");
    const repaired = s.community.accept(
      communityFixture({ reportId: "BC-44444444-4444-4444-a444-444444444444" }),
    );
    s.community.review(repaired.body.reference, "accepted");
    assert.equal(s.community.matrix().cells[0].status, "issue");
    assert.equal(s.community.review(repaired.body.reference, "resolved"), true);
    assert.equal(s.community.matrix().cells[0].status, "confirmed");
    assert.equal(
      s.database
        .prepare("SELECT COUNT(*) AS count FROM community_revisions")
        .get().count,
      4,
    );
  } finally {
    s.database.close();
  }
});

test("withdrawal receipt and expiry recompute counts without exposing private records or resurrecting a previous verdict", () => {
  const s = communityService();
  try {
    const first = s.community.accept(communityFixture());
    s.community.review(first.body.reference, "accepted");
    const second = s.community.accept(
      communityFixture({ participantToken: "b".repeat(64) }),
    );
    s.community.review(second.body.reference, "accepted");
    assert.equal(s.community.matrix().cells[0].status, "confirmed");
    assert.equal(
      s.community.withdraw({ ...second.body, receipt: "c".repeat(64) }),
      false,
    );
    assert.equal(s.community.withdraw(second.body), true);
    assert.equal(s.community.matrix().cells[0].status, "working");
    s.database
      .prepare("UPDATE community_votes SET expires_at='2000-01-01'")
      .run();
    s.purgeExpired(new Date());
    assert.deepEqual(s.community.matrix().cells, []);
  } finally {
    s.database.close();
  }
});

test("v2 rejects malformed private fields, origin/feature mismatches and unregistered identity; legacy evidence never contributes", () => {
  const input = communityFixture();
  assert.equal(validateCommunityReport(input), null);
  for (const bad of [
    { ...input, setup: { ...input.setup, usbSerial: "private" } },
    { ...input, environment: { ...input.environment, location: "private" } },
    {
      ...input,
      environment: {
        ...input.environment,
        browser: "https://private.invalid/",
      },
    },
    { ...input, build: { ...input.build, id: "development" } },
    { ...input, setup: { ...input.setup, origin: "replay" } },
    { ...input, observations: [{ feature: "adsb", result: "working" }] },
    { ...input, durationMinutes: null },
    { ...input, setup: [] },
    { ...input, participantToken: {} },
  ])
    assert.notEqual(validateCommunityReport(bad), null);
  const s = communityService();
  try {
    s.database
      .prepare(
        "INSERT INTO reports(reference,received_at,expires_at,fingerprint,trigger,report_type,body) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "legacy",
        new Date().toISOString(),
        "2099-01-01",
        "legacy",
        "compatibility",
        "compatibility",
        JSON.stringify(compatibilityFixture()),
      );
    assert.deepEqual(s.community.matrix().cells, []);
    assert.deepEqual(s.community.matrix().engineChecks, []);
    s.community.registerBuild({
      ...communityBuild,
      engineChecks: [
        {
          feature: "rds",
          result: "passed",
          checkedAt: communityBuild.builtAt,
          evidence: "https://github.com/cybearde/BrowserSDR/actions/runs/1",
        },
        {
          feature: "rds",
          result: "passed",
          checkedAt: communityBuild.builtAt,
          evidence: "file:///private",
        },
      ],
    });
    assert.equal(s.community.matrix().engineChecks.length, 1);
  } finally {
    s.database.close();
  }
});

test("withdrawal shares the write throttle and retains origin and receipt checks", async () => {
  const service = createReportServer({
    database: new DatabaseSync(":memory:"),
    communityBuilds: [communityBuild],
    communityReleasePath: null,
    allowedOrigin: "https://browsersdr.test",
    maxReportsPerMinute: 1,
  });
  await new Promise((resolve) =>
    service.server.listen(0, "127.0.0.1", resolve),
  );
  const endpoint = `http://127.0.0.1:${service.server.address().port}/api/v1/compatibility-reports/withdraw`;
  const receipt = service.community.accept(communityFixture()).body;
  try {
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://other.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(receipt),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://browsersdr.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...receipt, receipt: "c".repeat(64) }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://browsersdr.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(receipt),
        })
      ).status,
      429,
    );
    assert.equal(service.community.matrix().cells.length, 1);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("runtime rates and actual display renderers stay separate; SRD cannot claim an unselected protocol", () => {
  const s = communityService();
  try {
    const one = communityFixture({
      observations: [{ feature: "display", result: "working" }],
    });
    const two = communityFixture({
      participantToken: "b".repeat(64),
      setup: { ...one.setup, rateHz: 1024000, nativeRateHz: 1024000 },
      observations: one.observations,
    });
    for (const report of [one, two]) {
      const ack = s.community.accept(report);
      s.community.review(ack.body.reference, "accepted");
    }
    const three = communityFixture({
      participantToken: "c".repeat(64),
      environment: { ...one.environment, renderer: "webgpu" },
      observations: one.observations,
    });
    const ack = s.community.accept(three);
    s.community.review(ack.body.reference, "accepted");
    const cells = s.community.matrix().cells;
    assert.equal(cells.length, 3);
    assert.equal(
      cells.every((c) => c.eligibleWorking === 1 && c.status !== "confirmed"),
      true,
    );
    const srd = communityFixture({
      setup: { ...one.setup, mode: "SRD", srdProtocol: "fineoffset-wh51" },
      observations: [{ feature: "srd-acurite", result: "working" }],
    });
    assert.notEqual(validateCommunityReport(srd), null);
    srd.observations = [{ feature: "srd-wh51", result: "working" }];
    assert.equal(validateCommunityReport(srd), null);
  } finally {
    s.database.close();
  }
});
