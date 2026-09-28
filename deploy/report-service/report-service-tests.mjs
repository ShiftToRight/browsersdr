import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createReportServer,
  fingerprint,
  sanitizeReport,
  validateReport,
} from "./report-service.mjs";

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
