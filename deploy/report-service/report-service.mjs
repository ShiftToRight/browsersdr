import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const MAX_COMPRESSED_BYTES = 128 * 1024;
export const MAX_EXPANDED_BYTES = 512 * 1024;
const EVENT_AREAS = new Set([
  "receiver",
  "usb",
  "analysis",
  "channel",
  "audio",
  "graphics",
  "decoder",
  "recording",
  "application",
]);
const EVENT_SEVERITIES = new Set(["info", "warning", "error", "fatal"]);
const TRIGGERS = new Set(["manual", "error", "automatic"]);
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "reportId",
  "createdAt",
  "trigger",
  "autoSubmitted",
  "build",
  "environment",
  "receiver",
  "description",
  "events",
  "snapshots",
  "redaction",
]);
const COMPATIBILITY_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "reportType",
  "reportId",
  "createdAt",
  "build",
  "environment",
  "receiver",
  "observations",
  "notes",
  "redaction",
]);
const COMPATIBILITY_SERVICES = new Set([
  "connection",
  "spectrum",
  "tuning",
  "audio",
  "rds",
  "dab",
  "digital-decode",
  "recording-export",
  "replay",
]);
const COMPATIBILITY_RESULTS = new Set(["working", "degraded", "not-working"]);
const COMPATIBILITY_RECEIVER_FIELDS = new Set([
  "lifecycle",
  "source",
  "deviceProfile",
  "mode",
  "sampleRateHz",
  "nativeSampleRateHz",
  "bandwidthHz",
  "squelch",
  "gainMode",
  "gainDb",
  "lnaGainCode",
  "vgaGainDb",
  "rfAmplifierEnabled",
  "antennaPowerEnabled",
  "firmwareVersion",
  "usbApiVersion",
  "protocolProfile",
  "recordingActive",
  "audioState",
  "exactFrequencyHz",
]);
const FORBIDDEN_KEYS =
  /serial|iqSamples|sampleBuffer|audioData|spectrumBins|waterfall|decoded|fileName|metadataText|surveySite|latitude|longitude|urlQuery|cookie|localStorage/i;

function boundedString(value, maximum) {
  return typeof value === "string"
    ? value
        .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/gi, "$1")
        .slice(0, maximum)
    : undefined;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function safeScalarRecord(value, maximumFields = 32) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !FORBIDDEN_KEYS.test(key) &&
          (["string", "number", "boolean"].includes(typeof item) ||
            item === null),
      )
      .slice(0, maximumFields)
      .map(([key, item]) => [
        key.slice(0, 64),
        typeof item === "string" ? item.slice(0, 500) : item,
      ]),
  );
}

export function validateReport(value) {
  if (value?.reportType === "compatibility")
    return validateCompatibilityReport(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Report must be an object.";
  const unknown = Object.keys(value).find((key) => !TOP_LEVEL_FIELDS.has(key));
  if (unknown) return `Unknown top-level field: ${unknown}`;
  if (value.schemaVersion !== 1) return "Unsupported schema version.";
  if (typeof value.reportId !== "string" || value.reportId.length > 64)
    return "Invalid report ID.";
  if (!TRIGGERS.has(value.trigger) || typeof value.autoSubmitted !== "boolean")
    return "Invalid trigger.";
  if (!value.build || !value.environment || !value.receiver || !value.redaction)
    return "Required report section is missing.";
  if (!Array.isArray(value.events) || value.events.length > 100)
    return "Invalid event collection.";
  if (!Array.isArray(value.snapshots) || value.snapshots.length > 60)
    return "Invalid snapshot collection.";
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length > 1000)
  )
    return "Invalid description.";
  for (const event of value.events) {
    if (
      !event ||
      typeof event !== "object" ||
      !EVENT_AREAS.has(event.area) ||
      !EVENT_SEVERITIES.has(event.severity) ||
      typeof event.code !== "string"
    )
      return "Invalid diagnostic event.";
  }
  return null;
}

export function validateCompatibilityReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Report must be an object.";
  const unknown = Object.keys(value).find(
    (key) => !COMPATIBILITY_TOP_LEVEL_FIELDS.has(key),
  );
  if (unknown) return `Unknown compatibility report field: ${unknown}`;
  if (value.schemaVersion !== 1 || value.reportType !== "compatibility")
    return "Unsupported compatibility report schema.";
  if (
    typeof value.reportId !== "string" ||
    !value.reportId.startsWith("BC-") ||
    value.reportId.length > 64
  )
    return "Invalid report ID.";
  if (!value.build || !value.environment || !value.receiver || !value.redaction)
    return "Required report section is missing.";
  if (
    !Array.isArray(value.observations) ||
    value.observations.length < 1 ||
    value.observations.length > 12
  )
    return "At least one valid compatibility observation is required.";
  if (
    value.notes !== undefined &&
    (typeof value.notes !== "string" || value.notes.length > 1000)
  )
    return "Invalid notes.";
  const seen = new Set();
  for (const observation of value.observations) {
    if (
      !observation ||
      typeof observation !== "object" ||
      !COMPATIBILITY_SERVICES.has(observation.service) ||
      !COMPATIBILITY_RESULTS.has(observation.result) ||
      seen.has(observation.service)
    )
      return "Invalid compatibility observation.";
    seen.add(observation.service);
  }
  return null;
}

export function sanitizeReport(value) {
  if (value?.reportType === "compatibility")
    return sanitizeCompatibilityReport(value);
  const receiver = safeScalarRecord(value.receiver);
  if (!value.redaction?.exactFrequencyIncluded)
    delete receiver.exactFrequencyHz;
  const events = value.events.slice(-100).map((event) => ({
    id: boundedString(event.id, 64),
    monotonicMs: finite(event.monotonicMs),
    occurredAt: boundedString(event.occurredAt, 40),
    area: event.area,
    code: boundedString(event.code, 80),
    severity: event.severity,
    operation: boundedString(event.operation, 80),
    errorName: boundedString(event.errorName, 100),
    safeMessage: boundedString(event.safeMessage, 500),
    safeStack: Array.isArray(event.safeStack)
      ? event.safeStack.slice(0, 12).map((line) => boundedString(line, 500))
      : undefined,
    context: safeScalarRecord(event.context, 24),
    autoSubmitEligible: event.autoSubmitEligible === true,
    count: Math.max(
      1,
      Math.min(100000, Number.isInteger(event.count) ? event.count : 1),
    ),
  }));
  const snapshots = value.snapshots.slice(-60).map((snapshot) => ({
    monotonicMs: finite(snapshot.monotonicMs),
    lifecycle: boundedString(snapshot.lifecycle, 40),
    visibility: boundedString(snapshot.visibility, 20),
    analysis: safeScalarRecord(snapshot.analysis),
    channel: safeScalarRecord(snapshot.channel),
    ingress: safeScalarRecord(snapshot.ingress),
  }));
  const environment = safeScalarRecord(value.environment, 16);
  environment.capabilities = safeScalarRecord(
    value.environment?.capabilities,
    8,
  );
  return {
    schemaVersion: 1,
    reportId: boundedString(value.reportId, 64),
    createdAt: boundedString(value.createdAt, 40),
    trigger: value.trigger,
    autoSubmitted: value.autoSubmitted === true,
    build: safeScalarRecord(value.build, 10),
    environment,
    receiver,
    ...(value.description
      ? { description: boundedString(value.description, 1000) }
      : {}),
    events,
    snapshots,
    redaction: {
      omitted: Array.isArray(value.redaction?.omitted)
        ? value.redaction.omitted
            .slice(0, 40)
            .map((item) => boundedString(item, 80))
        : [],
      exactFrequencyIncluded: value.redaction?.exactFrequencyIncluded === true,
    },
  };
}

export function sanitizeCompatibilityReport(value) {
  const receiver = Object.fromEntries(
    Object.entries(safeScalarRecord(value.receiver)).filter(([key]) =>
      COMPATIBILITY_RECEIVER_FIELDS.has(key),
    ),
  );
  if (!value.redaction?.exactFrequencyIncluded)
    delete receiver.exactFrequencyHz;
  const environment = safeScalarRecord(value.environment, 16);
  environment.capabilities = safeScalarRecord(
    value.environment?.capabilities,
    8,
  );
  return {
    schemaVersion: 1,
    reportType: "compatibility",
    reportId: boundedString(value.reportId, 64),
    createdAt: boundedString(value.createdAt, 40),
    build: safeScalarRecord(value.build, 10),
    environment,
    receiver,
    observations: value.observations.slice(0, 12).map((observation) => ({
      service: observation.service,
      result: observation.result,
    })),
    ...(value.notes ? { notes: boundedString(value.notes, 1000) } : {}),
    redaction: {
      omitted: Array.isArray(value.redaction?.omitted)
        ? value.redaction.omitted
            .slice(0, 40)
            .map((item) => boundedString(item, 80))
        : [],
      exactFrequencyIncluded: value.redaction?.exactFrequencyIncluded === true,
    },
  };
}

export function fingerprint(report) {
  if (report.reportType === "compatibility")
    return createHash("sha256")
      .update(
        JSON.stringify([
          report.reportType,
          report.build.id,
          report.receiver.source,
          report.receiver.deviceProfile,
          report.receiver.mode,
          report.receiver.sampleRateHz,
          report.environment.browser,
          report.observations,
        ]),
      )
      .digest("hex");
  const primary =
    [...report.events]
      .reverse()
      .find(
        (event) => event.severity === "fatal" || event.severity === "error",
      ) ?? report.events.at(-1);
  return createHash("sha256")
    .update(
      JSON.stringify([
        report.build.id,
        primary?.code,
        primary?.safeStack?.[0],
        report.receiver.source,
        report.receiver.sampleRateHz,
      ]),
    )
    .digest("hex");
}

export function createReportServer(options = {}) {
  const database =
    options.database ??
    new DatabaseSync(
      options.databasePath ??
        process.env.BROWSERSDR_REPORT_DB ??
        "/var/lib/browsersdr-reports/reports.sqlite",
    );
  const allowedOrigin =
    options.allowedOrigin ??
    process.env.BROWSERSDR_REPORT_ORIGIN ??
    "https://browsersdr.com";
  const retentionDays = Number(
    options.retentionDays ?? process.env.BROWSERSDR_REPORT_RETENTION_DAYS ?? 30,
  );
  const rateSecret =
    options.rateSecret ??
    process.env.BROWSERSDR_REPORT_RATE_SECRET ??
    randomBytes(32).toString("hex");
  const aggregateDays = Number(
    options.aggregateDays ?? process.env.BROWSERSDR_REPORT_AGGREGATE_DAYS ?? 90,
  );
  const notifyUrl =
    options.notifyUrl ?? process.env.BROWSERSDR_REPORT_NOTIFY_URL;
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reports (reference TEXT PRIMARY KEY, received_at TEXT NOT NULL, expires_at TEXT NOT NULL, fingerprint TEXT NOT NULL, build_id TEXT, trigger TEXT NOT NULL, report_type TEXT NOT NULL DEFAULT 'diagnostic', status TEXT NOT NULL DEFAULT 'new', body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS reports_fingerprint ON reports(fingerprint); CREATE TABLE IF NOT EXISTS fingerprint_counts (fingerprint TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL, count INTEGER NOT NULL, last_build TEXT, last_code TEXT, status TEXT NOT NULL DEFAULT 'new'); CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
  );
  if (
    !database
      .prepare("PRAGMA table_info(reports)")
      .all()
      .some((column) => column.name === "status")
  )
    database.exec(
      "ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'new'",
    );
  if (
    !database
      .prepare("PRAGMA table_info(reports)")
      .all()
      .some((column) => column.name === "report_type")
  )
    database.exec(
      "ALTER TABLE reports ADD COLUMN report_type TEXT NOT NULL DEFAULT 'diagnostic'",
    );
  const insert = database.prepare(
    "INSERT INTO reports(reference, received_at, expires_at, fingerprint, build_id, trigger, report_type, status, body) VALUES(?, ?, ?, ?, ?, ?, ?, 'new', ?)",
  );
  const aggregateRead = database.prepare(
    "SELECT count FROM fingerprint_counts WHERE fingerprint = ?",
  );
  const aggregateWrite = database.prepare(
    "INSERT INTO fingerprint_counts(fingerprint,first_seen,last_seen,expires_at,count,last_build,last_code,status) VALUES(?,?,?,?,?,?,?,'new') ON CONFLICT(fingerprint) DO UPDATE SET last_seen=excluded.last_seen, expires_at=excluded.expires_at, count=fingerprint_counts.count+1, last_build=excluded.last_build, last_code=excluded.last_code",
  );
  const rateRead = database.prepare(
    "SELECT count, expires_at FROM rate_limits WHERE bucket = ?",
  );
  const rateWrite = database.prepare(
    "INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=excluded.count, expires_at=excluded.expires_at",
  );

  const server = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    const reportType =
      request.url === "/api/v1/compatibility-reports"
        ? "compatibility"
        : request.url === "/api/v1/diagnostic-reports"
          ? "diagnostic"
          : null;
    if (!reportType || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers.origin && request.headers.origin !== allowedOrigin) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
    ) {
      response.writeHead(415);
      response.end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    let closed = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMPRESSED_BYTES) {
        closed = true;
        response.writeHead(413);
        response.end();
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (closed) return;
      try {
        const compressed = Buffer.concat(chunks);
        const expanded =
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES })
            : compressed;
        if (expanded.length > MAX_EXPANDED_BYTES) {
          response.writeHead(413);
          response.end();
          return;
        }
        const parsed = JSON.parse(expanded.toString("utf8"));
        if (
          (reportType === "compatibility") !==
          (parsed.reportType === "compatibility")
        ) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: "Report type does not match the endpoint.",
            }),
          );
          return;
        }
        const validation = validateReport(parsed);
        if (validation) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: validation }));
          return;
        }
        const address = request.socket.remoteAddress ?? "unknown";
        const day = new Date().toISOString().slice(0, 10);
        const bucket = createHmac("sha256", `${rateSecret}:${day}`)
          .update(address)
          .digest("hex");
        const nowSeconds = Math.floor(Date.now() / 1000);
        const current = rateRead.get(bucket);
        const count =
          current && current.expires_at > nowSeconds ? current.count + 1 : 1;
        if (count > 20) {
          response.writeHead(429);
          response.end();
          return;
        }
        rateWrite.run(bucket, count, nowSeconds + 86400);
        const sanitized = sanitizeReport(parsed);
        const reference = `${reportType === "compatibility" ? "BC" : "BR"}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
        const receivedAt = new Date();
        const expiresAt = new Date(
          receivedAt.getTime() + retentionDays * 86400000,
        );
        const reportFingerprint = fingerprint(sanitized);
        const isNewFingerprint = !aggregateRead.get(reportFingerprint);
        insert.run(
          reference,
          receivedAt.toISOString(),
          expiresAt.toISOString(),
          reportFingerprint,
          sanitized.build.id ?? null,
          reportType === "compatibility" ? "compatibility" : sanitized.trigger,
          reportType,
          JSON.stringify(sanitized),
        );
        const primaryCode =
          reportType === "compatibility"
            ? `compatibility:${sanitized.receiver.source ?? "unknown"}:${sanitized.receiver.mode ?? "unknown"}`
            : ([...sanitized.events]
                .reverse()
                .find(
                  (event) =>
                    event.severity === "fatal" || event.severity === "error",
                )?.code ??
              sanitized.events.at(-1)?.code ??
              null);
        aggregateWrite.run(
          reportFingerprint,
          receivedAt.toISOString(),
          receivedAt.toISOString(),
          new Date(
            receivedAt.getTime() + aggregateDays * 86400000,
          ).toISOString(),
          1,
          sanitized.build.id ?? null,
          primaryCode,
        );
        database
          .prepare("DELETE FROM reports WHERE expires_at < ?")
          .run(receivedAt.toISOString());
        database
          .prepare("DELETE FROM fingerprint_counts WHERE expires_at < ?")
          .run(receivedAt.toISOString());
        database
          .prepare("DELETE FROM rate_limits WHERE expires_at < ?")
          .run(nowSeconds);
        response.writeHead(202, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ reference }));
        if (isNewFingerprint && notifyUrl)
          queueMicrotask(() => {
            void fetch(notifyUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                reference,
                fingerprint: reportFingerprint,
                buildId: sanitized.build.id ?? null,
                code: primaryCode,
              }),
            }).catch(() => undefined);
          });
      } catch (error) {
        response.writeHead(error?.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400);
        response.end();
      }
    });
  });
  return { server, database };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server } = createReportServer();
  const port = Number(process.env.BROWSERSDR_REPORT_PORT ?? 8787);
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `BrowserSDR report service listening on 127.0.0.1:${port}\n`,
    ),
  );
}
