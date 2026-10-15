import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";

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
  /serial|iqSamples|sampleBuffer|audioData|spectrumBins|waterfall|decoded|fileName|metadataText|surveySite|latitude|longitude|urlQuery|cookie|localStorage|ipAddress|remoteAddress|clientAddress|forwardedFor|xForwardedFor|^ip$/i;

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
  if (value?.schemaVersion === 2) return validateCommunityReport(value);
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
  if (value.schemaVersion === 2) return sanitizeCommunityReport(value);
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
  if (report.schemaVersion === 2 && report.reportType === "compatibility")
    return digest(
      JSON.stringify([
        report.build.id,
        report.setup,
        report.environment,
        report.observations,
      ]),
    );
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

export const COMMUNITY_HARDWARE = {
  "rtl-nesdr-smart-v5": "rtl-sdr",
  "rtl-blog-v3": "rtl-sdr",
  "rtl-blog-v4": "rtl-sdr",
  "rtl-unknown": "rtl-sdr",
  "hackrf-pro": "hackrf",
  "hackrf-one": "hackrf",
  "bladerf-xa4": "bladerf",
  "bladerf-xa5": "bladerf",
  "bladerf-xa9": "bladerf",
  "bladerf-unknown": "bladerf",
  "usrp-b205-mini": "usrp-b205",
  "usrp-b205mini-i": "usrp-b205",
  "usrp-unknown": "usrp-b205",
  replay: "replay",
  synthetic: "synthetic",
};
export const COMMUNITY_FEATURE_MODES = {
  wbfm: "WBFM",
  nbfm: "NBFM",
  am: "AM",
  usb: "USB",
  lsb: "LSB",
  cw: "CW",
  rds: "WBFM",
  "dab-discovery": "DAB",
  "dab-audio": "DAB",
  "dab-plus-audio": "DAB",
  adsb: "ADS-B",
  ais: "AIS",
  rtty: "RTTY",
  psk31: "PSK31",
  navtex: "NAVTEX",
  acars: "ACARS",
  wefax: "WEFAX",
  sstv: "SSTV",
  "cw-text": "CW-TEXT",
  aprs: "APRS",
  rs41: "RS41",
  "srd-acurite": "SRD",
  "srd-wh51": "SRD",
  access: null,
  processing: null,
  "audio-output": null,
  display: null,
  storage: null,
  export: null,
  replay: null,
  tuning: null,
};
const RUNTIME_FEATURES = new Set([
  "processing",
  "audio-output",
  "display",
  "storage",
]);
const COMMUNITY_PROFILES = new Set([
  null,
  "hackrf-pro-standard-7f96cc8-v1",
  "hackrf-pro-stable-2026-v1",
  "hackrf-one-stable-2026-v1",
  "bladerf2-xa4-fpga-rfic-35174c3-v1",
  "bladerf2-xa5-fpga-rfic-35174c3-v1",
  "bladerf2-xa9-fpga-rfic-35174c3-v1",
  "usrp-b205-mini-uhd-4.9.0.0-rx-v2",
]);
const COMMUNITY_OS = new Set([
  "Linux",
  "Windows",
  "macOS",
  "ChromeOS",
  "Android",
  "iOS",
  "Unknown",
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const objectWithKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const dateString = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const buildIdValid = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
  !["development", "unknown"].includes(value);

export function validateCommunityReport(value) {
  if (
    !objectWithKeys(value, [
      "schemaVersion",
      "reportType",
      "reportId",
      "createdAt",
      "build",
      "participantToken",
      "setup",
      "environment",
      "durationMinutes",
      "testScope",
      "observations",
      "notes",
      "receiverDetails",
      "browserCapabilities",
    ]) ||
    value.schemaVersion !== 2 ||
    value.reportType !== "compatibility"
  )
    return "Invalid community report.";
  if (
    typeof value.reportId !== "string" ||
    !/^BC-[a-f0-9-]{10,50}$/i.test(value.reportId) ||
    !dateString(value.createdAt) ||
    typeof value.participantToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.participantToken)
  )
    return "Invalid report identity.";
  if (
    !objectWithKeys(value.build, ["id", "version", "builtAt"]) ||
    !buildIdValid(value.build.id) ||
    typeof value.build.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.build.version) ||
    value.build.version.length > 40 ||
    !dateString(value.build.builtAt)
  )
    return "This build is not eligible for community reporting.";
  const s = value.setup;
  if (
    !objectWithKeys(s, [
      "source",
      "hardwareId",
      "mode",
      "srdProtocol",
      "rateHz",
      "nativeRateHz",
      "protocolProfile",
      "firmwareVersion",
      "origin",
    ]) ||
    !Object.hasOwn(COMMUNITY_HARDWARE, s.hardwareId) ||
    COMMUNITY_HARDWARE[s.hardwareId] !== s.source ||
    ![
      "OFF",
      ...Object.values(COMMUNITY_FEATURE_MODES).filter(Boolean),
    ].includes(s.mode) ||
    !(s.mode === "SRD"
      ? ["none", "acurite-592txr", "fineoffset-wh51"].includes(s.srdProtocol)
      : s.srdProtocol === null) ||
    !Number.isFinite(s.rateHz) ||
    s.rateHz <= 0 ||
    s.rateHz > 100_000_000 ||
    !(
      s.nativeRateHz === null ||
      (Number.isFinite(s.nativeRateHz) &&
        s.nativeRateHz > 0 &&
        s.nativeRateHz <= 200_000_000)
    ) ||
    !COMMUNITY_PROFILES.has(s.protocolProfile) ||
    (s.protocolProfile === "hackrf-one-stable-2026-v1" &&
      !(
        (s.source === "hackrf" && s.hardwareId === "hackrf-one") ||
        (s.source === "replay" && s.hardwareId === "replay")
      )) ||
    (s.hardwareId === "hackrf-one" &&
      s.protocolProfile !== null &&
      s.protocolProfile !== "hackrf-one-stable-2026-v1") ||
    !(
      s.firmwareVersion === null ||
      (typeof s.firmwareVersion === "string" &&
        /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:-[a-zA-Z0-9.-]{1,20})?$/.test(
          s.firmwareVersion,
        ))
    ) ||
    s.origin !==
      (s.source === "replay"
        ? "replay"
        : s.source === "synthetic"
          ? "synthetic"
          : "live")
  )
    return "Invalid receiver setup.";
  if (value.receiverDetails !== undefined) {
    const r = value.receiverDetails;
    const nullableNumber = (v, min, max, integer = false) =>
      v === null ||
      (typeof v === "number" &&
        Number.isFinite(v) &&
        v >= min &&
        v <= max &&
        (!integer || Number.isInteger(v)));
    if (
      !objectWithKeys(r, [
        "lifecycle",
        "bandwidthHz",
        "squelch",
        "gainMode",
        "gainDb",
        "lnaGainCode",
        "vgaGainDb",
        "rfAmplifierEnabled",
        "antennaPowerEnabled",
        "usbApiVersion",
        "recordingActive",
        "audioState",
      ]) ||
      ![
        "idle",
        "connecting",
        "connected",
        "requesting-permission",
        "starting",
        "tuning",
        "running",
        "stopping",
        "disconnecting",
        "error",
      ].includes(r.lifecycle) ||
      !nullableNumber(r.bandwidthHz, 0, 100000000) ||
      r.bandwidthHz === null ||
      !nullableNumber(r.squelch, 0, 100) ||
      r.squelch === null ||
      ![
        "automatic",
        "manual",
        "staged",
        "slow-attack-agc",
        "fast-attack-agc",
        "hybrid-agc",
        "not-applicable",
      ].includes(r.gainMode) ||
      !nullableNumber(r.gainDb, -100, 100) ||
      !nullableNumber(r.lnaGainCode, 0, 255, true) ||
      !nullableNumber(r.vgaGainDb, 0, 100) ||
      ![null, true, false].includes(r.rfAmplifierEnabled) ||
      ![null, true, false].includes(r.antennaPowerEnabled) ||
      !nullableNumber(r.usbApiVersion, 0, 65535, true) ||
      typeof r.recordingActive !== "boolean" ||
      ![null, "running", "suspended", "closed", "interrupted"].includes(
        r.audioState,
      )
    )
      return "Invalid private receiver details.";
  }
  if (
    value.browserCapabilities !== undefined &&
    (!objectWithKeys(value.browserCapabilities, [
      "secureContext",
      "webUsb",
      "webGpu",
      "webAssembly",
    ]) ||
      ["secureContext", "webUsb", "webGpu", "webAssembly"].some(
        (k) => typeof value.browserCapabilities[k] !== "boolean",
      ))
  )
    return "Invalid private browser capabilities.";
  const e = value.environment;
  if (
    !objectWithKeys(e, ["browser", "operatingSystem", "renderer"]) ||
    !/^(?:Chrome|Edge|Firefox|Safari) \d{1,4}$|^Unknown browser$/.test(
      e.browser ?? "",
    ) ||
    !COMMUNITY_OS.has(e.operatingSystem) ||
    !["webgpu", "canvas2d", "unknown"].includes(e.renderer)
  )
    return "Invalid platform.";
  if (
    !Number.isFinite(value.durationMinutes) ||
    value.durationMinutes < 0 ||
    value.durationMinutes > 10080 ||
    !["smoke", "sustained"].includes(value.testScope)
  )
    return "Invalid test duration or scope.";
  if (
    value.notes !== undefined &&
    (typeof value.notes !== "string" || value.notes.length > 1000)
  )
    return "Invalid private notes.";
  if (
    !Array.isArray(value.observations) ||
    !value.observations.length ||
    value.observations.length > 24
  )
    return "Select tested features.";
  const seen = new Set();
  for (const o of value.observations) {
    if (
      !objectWithKeys(o, ["feature", "result"]) ||
      !Object.hasOwn(COMMUNITY_FEATURE_MODES, o.feature) ||
      !COMPATIBILITY_RESULTS.has(o.result) ||
      seen.has(o.feature) ||
      (COMMUNITY_FEATURE_MODES[o.feature] &&
        COMMUNITY_FEATURE_MODES[o.feature] !== s.mode) ||
      (o.feature === "access" && s.origin !== "live")
    )
      return "Invalid feature observation for this setup.";
    if (
      (o.feature === "srd-acurite" && s.srdProtocol !== "acurite-592txr") ||
      (o.feature === "srd-wh51" && s.srdProtocol !== "fineoffset-wh51")
    )
      return "SRD protocol does not match the exercised decoder.";
    seen.add(o.feature);
  }
  return null;
}

export function sanitizeCommunityReport(value) {
  // v2 uses explicit nested fields; no generic scalar record reaches public aggregation.
  return {
    schemaVersion: 2,
    reportType: "compatibility",
    reportId: value.reportId,
    createdAt: value.createdAt,
    build: {
      id: value.build.id,
      version: value.build.version,
      builtAt: value.build.builtAt,
    },
    setup: {
      source: value.setup.source,
      hardwareId:
        value.setup.source === "rtl-sdr"
          ? "rtl-unknown"
          : value.setup.hardwareId,
      mode: value.setup.mode,
      srdProtocol: value.setup.srdProtocol,
      rateHz: value.setup.rateHz,
      nativeRateHz: value.setup.nativeRateHz,
      protocolProfile: value.setup.protocolProfile,
      firmwareVersion: value.setup.firmwareVersion,
      origin: value.setup.origin,
    },
    environment: {
      browser: value.environment.browser,
      operatingSystem: value.environment.operatingSystem,
      renderer: value.environment.renderer,
    },
    durationMinutes: value.durationMinutes,
    testScope: value.testScope,
    observations: value.observations.map((o) => ({
      feature: o.feature,
      result: o.result,
    })),
    ...(value.receiverDetails
      ? {
          receiverDetails: Object.fromEntries(
            [
              "lifecycle",
              "bandwidthHz",
              "squelch",
              "gainMode",
              "gainDb",
              "lnaGainCode",
              "vgaGainDb",
              "rfAmplifierEnabled",
              "antennaPowerEnabled",
              "usbApiVersion",
              "recordingActive",
              "audioState",
            ].map((k) => [k, value.receiverDetails[k]]),
          ),
        }
      : {}),
    ...(value.browserCapabilities
      ? {
          browserCapabilities: Object.fromEntries(
            ["secureContext", "webUsb", "webGpu", "webAssembly"].map((k) => [
              k,
              value.browserCapabilities[k],
            ]),
          ),
        }
      : {}),
    ...(value.notes ? { notes: value.notes } : {}),
  };
}

// Trusted operator metadata only. Report intake cannot register equivalence.
function createEvidenceRegistry(database, features) {
  database.exec(`CREATE TABLE IF NOT EXISTS community_fingerprints(build_id TEXT NOT NULL, feature TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(build_id,feature));
    CREATE TABLE IF NOT EXISTS community_equivalences(target_build TEXT NOT NULL, feature TEXT NOT NULL, source_build TEXT NOT NULL, fingerprint TEXT NOT NULL, checked_at TEXT NOT NULL, evidence TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(target_build,feature));`);
  const known = (feature) => Object.hasOwn(features, feature);
  const hash = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const getFingerprint = database.prepare(
    "SELECT fingerprint FROM community_fingerprints WHERE build_id=? AND feature=?",
  );
  const validateFingerprints = (id, value) => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    return Object.entries(value).every(([feature, fingerprint]) => {
      const previous = getFingerprint.get(id, feature);
      return (
        known(feature) &&
        hash(fingerprint) &&
        (!previous || previous.fingerprint === fingerprint)
      );
    });
  };
  const storeFingerprints = (id, value) => {
    const insert = database.prepare(
      "INSERT INTO community_fingerprints VALUES(?,?,?) ON CONFLICT DO NOTHING",
    );
    for (const [feature, fingerprint] of Object.entries(value ?? {}))
      insert.run(id, feature, fingerprint);
  };
  const registerEquivalence = (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !==
        "checkedAt,evidence,feature,fingerprint,sourceBuildId,targetBuildId" ||
      !known(value.feature) ||
      !hash(value.fingerprint) ||
      typeof value.checkedAt !== "string" ||
      value.checkedAt.length > 40 ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.evidence !== "string" ||
      value.evidence.length > 300 ||
      !/^https:\/\/(?:github\.com|browsersdr\.com)\//.test(value.evidence) ||
      typeof value.sourceBuildId !== "string" ||
      typeof value.targetBuildId !== "string"
    )
      return false;
    const source = database
      .prepare("SELECT built_at FROM community_builds WHERE id=?")
      .get(value.sourceBuildId);
    const target = database
      .prepare("SELECT built_at FROM community_builds WHERE id=?")
      .get(value.targetBuildId);
    if (
      !source ||
      !target ||
      Date.parse(source.built_at) >= Date.parse(target.built_at) ||
      Date.parse(value.checkedAt) < Date.parse(target.built_at) ||
      Date.parse(value.checkedAt) > Date.now() ||
      getFingerprint.get(value.sourceBuildId, value.feature)?.fingerprint !==
        value.fingerprint ||
      getFingerprint.get(value.targetBuildId, value.feature)?.fingerprint !==
        value.fingerprint
    )
      return false;
    const previous = database
      .prepare(
        "SELECT * FROM community_equivalences WHERE target_build=? AND feature=?",
      )
      .get(value.targetBuildId, value.feature);
    // One original source per feature. Re-enabling the same audited record is explicit.
    if (
      previous &&
      (previous.source_build !== value.sourceBuildId ||
        previous.fingerprint !== value.fingerprint ||
        previous.checked_at !== value.checkedAt ||
        previous.evidence !== value.evidence)
    )
      return false;
    database
      .prepare(
        `INSERT INTO community_equivalences VALUES(?,?,?,?,?,?,1)
      ON CONFLICT(target_build,feature) DO UPDATE SET active=1`,
      )
      .run(
        value.targetBuildId,
        value.feature,
        value.sourceBuildId,
        value.fingerprint,
        value.checkedAt,
        value.evidence,
      );
    return true;
  };
  const revokeEquivalence = (target, feature) => {
    if (typeof target !== "string" || !known(feature)) return false;
    return (
      database
        .prepare(
          "UPDATE community_equivalences SET active=0 WHERE target_build=? AND feature=? AND active=1",
        )
        .run(target, feature).changes > 0
    );
  };
  const forTarget = (target) =>
    database
      .prepare(
        `SELECT e.feature, e.source_build AS sourceBuildId, e.fingerprint, e.checked_at AS checkedAt, e.evidence,
      b.version, b.built_at AS builtAt, b.engine_checks AS engineChecks
    FROM community_equivalences e JOIN community_builds b ON b.id=e.source_build
    JOIN community_fingerprints s ON s.build_id=e.source_build AND s.feature=e.feature AND s.fingerprint=e.fingerprint
    JOIN community_fingerprints t ON t.build_id=e.target_build AND t.feature=e.feature AND t.fingerprint=e.fingerprint
    WHERE e.target_build=? AND e.active=1 ORDER BY e.feature`,
      )
      .all(target);
  return {
    validateFingerprints,
    storeFingerprints,
    registerEquivalence,
    revokeEquivalence,
    forTarget,
  };
}

// Exactly the existing vote scope, without its build identity. Reused for carry matching.
function communityVoteContext(
  feature,
  setup,
  platform,
  renderer,
  scope,
  runtime,
) {
  return runtime
    ? {
        feature,
        platform,
        renderer: feature === "display" ? renderer : null,
        origin: setup.origin,
        rateHz: setup.rateHz,
        nativeRateHz: setup.nativeRateHz,
        scope,
      }
    : {
        feature,
        platform,
        setup:
          feature === "access"
            ? { ...setup, mode: "OFF", srdProtocol: null }
            : setup,
        scope,
      };
}

export function createCommunityStore(database, options = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS community_builds(id TEXT PRIMARY KEY, version TEXT NOT NULL, built_at TEXT NOT NULL, engine_checks TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS community_submissions(reference TEXT PRIMARY KEY, report_id TEXT NOT NULL, participant TEXT NOT NULL, receipt TEXT NOT NULL, body_hash TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(report_id, participant));
    CREATE TABLE IF NOT EXISTS community_votes(cell_key TEXT NOT NULL, participant TEXT NOT NULL, reference TEXT NOT NULL, build_id TEXT NOT NULL, feature TEXT NOT NULL, setup TEXT NOT NULL, platform TEXT, environment TEXT NOT NULL, scope TEXT NOT NULL, duration REAL NOT NULL, result TEXT NOT NULL, has_issue INTEGER NOT NULL, review TEXT NOT NULL DEFAULT 'pending', received_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(cell_key, participant));
    CREATE INDEX IF NOT EXISTS community_votes_build ON community_votes(build_id);
    CREATE TABLE IF NOT EXISTS community_revisions(reference TEXT NOT NULL, cell_key TEXT NOT NULL, result TEXT NOT NULL, received_at TEXT NOT NULL, expires_at TEXT NOT NULL);`);
  const evidenceRegistry = createEvidenceRegistry(
    database,
    COMMUNITY_FEATURE_MODES,
  );
  const registerBuild = (build) => {
    if (!build || typeof build !== "object" || Array.isArray(build))
      return false;
    const id = build.id ?? build.release;
    if (
      !buildIdValid(id) ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(build.version ?? "") ||
      (build.version ?? "").length > 40 ||
      !dateString(build.builtAt) ||
      !evidenceRegistry.validateFingerprints(id, build.evidenceFingerprints)
    )
      return false;
    const checks = (Array.isArray(build.engineChecks) ? build.engineChecks : [])
      .filter(
        (c) =>
          c &&
          typeof c === "object" &&
          Object.hasOwn(COMMUNITY_FEATURE_MODES, c.feature) &&
          COMMUNITY_FEATURE_MODES[c.feature] &&
          ["passed", "failed"].includes(c.result) &&
          dateString(c.checkedAt) &&
          typeof c.evidence === "string" &&
          /^https:\/\/(?:github\.com|browsersdr\.com)\//.test(c.evidence) &&
          c.evidence.length <= 300,
      )
      .slice(0, 24)
      .map((c) => ({
        feature: c.feature,
        result: c.result,
        checkedAt: c.checkedAt,
        evidence: c.evidence,
      }));
    const existing = database
      .prepare("SELECT version, built_at FROM community_builds WHERE id=?")
      .get(id);
    if (
      existing &&
      (existing.version !== build.version ||
        existing.built_at !== build.builtAt)
    )
      return false;
    if (existing && Array.isArray(build.engineChecks))
      database
        .prepare("UPDATE community_builds SET engine_checks=? WHERE id=?")
        .run(JSON.stringify(checks), id);
    database
      .prepare(
        "INSERT INTO community_builds(id,version,built_at,engine_checks) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, build.version, build.builtAt, JSON.stringify(checks));
    evidenceRegistry.storeFingerprints(id, build.evidenceFingerprints);
    return true;
  };
  for (const build of options.communityBuilds ?? []) registerBuild(build);
  const discoverBuild = () => {
    const path =
      options.communityReleasePath === null
        ? null
        : (options.communityReleasePath ??
          process.env.BROWSERSDR_REPORT_RELEASE_JSON ??
          "/var/www/browsersdr.com/current/release.json");
    if (!path) return;
    try {
      if (statSync(path).size <= 64 * 1024)
        registerBuild(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* A local/dev service can have no registered release. */
    }
  };
  const purge = (now) => {
    for (const table of [
      "community_votes",
      "community_revisions",
      "community_submissions",
    ])
      database.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
  };
  const accept = (input) => {
    discoverBuild();
    const build = database
      .prepare("SELECT version, built_at FROM community_builds WHERE id=?")
      .get(input.build.id);
    if (
      !build ||
      build.version !== input.build.version ||
      build.built_at !== input.build.builtAt
    )
      return {
        status: 400,
        body: { error: "Build is not registered by the report service." },
      };
    const body = sanitizeCommunityReport(input),
      participant = digest(input.build.id + "|" + input.participantToken);
    const bodyHash = digest(JSON.stringify({ ...body, createdAt: undefined }));
    const previous = database
      .prepare(
        "SELECT * FROM community_submissions WHERE report_id=? AND participant=?",
      )
      .get(input.reportId, participant);
    if (previous)
      return previous.body_hash === bodyHash
        ? {
            status: 202,
            body: { reference: previous.reference, receipt: previous.receipt },
          }
        : {
            status: 409,
            body: {
              error:
                "Report already submitted; open a new report for a correction.",
            },
          };
    const now = new Date().toISOString(),
      expiry = new Date(Date.now() + 90 * 86400000).toISOString();
    const reference = `BC-${randomBytes(12).toString("hex")}`,
      receipt = randomBytes(32).toString("hex");
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          "INSERT INTO reports(reference,received_at,expires_at,fingerprint,build_id,trigger,report_type,body) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          reference,
          now,
          new Date(Date.now() + 30 * 86400000).toISOString(),
          fingerprint(body),
          body.build.id,
          "compatibility",
          "compatibility",
          JSON.stringify(body),
        );
      database
        .prepare("INSERT INTO community_submissions VALUES(?,?,?,?,?,?)")
        .run(reference, input.reportId, participant, receipt, bodyHash, expiry);
      for (const o of body.observations) {
        const runtime = RUNTIME_FEATURES.has(o.feature),
          platform =
            runtime || o.feature === "access"
              ? `${body.environment.browser} / ${body.environment.operatingSystem}`
              : null;
        const scope = body.testScope;
        const context = communityVoteContext(
          o.feature,
          body.setup,
          platform,
          body.environment.renderer,
          scope,
          runtime,
        );
        const key = digest(JSON.stringify([body.build.id, context]));
        database
          .prepare(
            `INSERT INTO community_votes(cell_key,participant,reference,build_id,feature,setup,platform,environment,scope,duration,result,has_issue,received_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(cell_key,participant) DO UPDATE SET reference=excluded.reference, environment=excluded.environment, setup=excluded.setup, duration=excluded.duration, result=excluded.result, has_issue=MAX(community_votes.has_issue,excluded.has_issue), review='pending', received_at=excluded.received_at, expires_at=excluded.expires_at`,
          )
          .run(
            key,
            participant,
            reference,
            body.build.id,
            o.feature,
            JSON.stringify(body.setup),
            platform,
            JSON.stringify(body.environment),
            scope,
            body.durationMinutes,
            o.result,
            o.result === "working" ? 0 : 1,
            now,
            expiry,
          );
        database
          .prepare("INSERT INTO community_revisions VALUES(?,?,?,?,?)")
          .run(reference, key, o.result, now, expiry);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { status: 202, body: { reference, receipt } };
  };
  const matrix = (requested) => {
    discoverBuild();
    purge(new Date().toISOString());
    const builds = database
      .prepare(
        "SELECT id,version,built_at AS builtAt FROM community_builds ORDER BY built_at DESC LIMIT 24",
      )
      .all();
    const buildId = requested || builds[0]?.id || null;
    const build = buildId
      ? database
          .prepare("SELECT * FROM community_builds WHERE id=?")
          .get(buildId)
      : null;
    if (requested && !build) return null;
    if (build && !builds.some((b) => b.id === buildId)) {
      if (builds.length === 24) builds.pop();
      builds.push({
        id: build.id,
        version: build.version,
        builtAt: build.built_at,
      });
    }
    const cells = new Map();
    const collect = (testedBuild, feature, carry) => {
      const query = feature
        ? database.prepare(
            "SELECT * FROM community_votes WHERE build_id=? AND feature=? AND review != 'excluded' ORDER BY received_at DESC",
          )
        : database.prepare(
            "SELECT * FROM community_votes WHERE build_id=? AND review != 'excluded' ORDER BY received_at DESC",
          );
      const votes = feature
        ? query.iterate(testedBuild, feature)
        : query.iterate(testedBuild);
      for (const vote of votes) {
        const setup = JSON.parse(vote.setup),
          environment = JSON.parse(vote.environment);
        const context = communityVoteContext(
          vote.feature,
          setup,
          vote.platform,
          environment.renderer,
          vote.scope,
          RUNTIME_FEATURES.has(vote.feature),
        );
        const key = digest(JSON.stringify([buildId, context]));
        let cell = cells.get(key);
        if (!cell) {
          if (cells.size >= 1000) continue;
          cell = {
            key,
            hardwareId: setup.hardwareId,
            feature: vote.feature,
            setup,
            testScope: vote.scope,
            platform: vote.platform,
            working: 0,
            eligibleWorking: 0,
            problems: 0,
            status: "untested",
            lastAt: vote.received_at,
            reports: [],
          };
          cells.set(key, cell);
        }
        let counts = cell;
        if (carry) {
          cell.carried ??= {
            ...carry,
            working: 0,
            eligibleWorking: 0,
            problems: 0,
            lastAt: vote.received_at,
            reports: [],
          };
          counts = cell.carried;
        }
        if (vote.result === "working") counts.working++;
        if (
          vote.result === "working" &&
          vote.duration >= (vote.scope === "sustained" ? 30 : 5)
        )
          counts.eligibleWorking++;
        if (vote.has_issue) counts.problems++;
        if (Date.parse(vote.received_at) > Date.parse(counts.lastAt))
          counts.lastAt = vote.received_at;
        if (counts.reports.length < 6)
          counts.reports.push({
            result: vote.result,
            durationMinutes: vote.duration,
            receivedAt: vote.received_at,
            expiresAt: vote.expires_at,
            environment,
            setup,
            review: vote.review,
          });
      }
    };
    if (buildId) collect(buildId);
    const carriedEngineChecks = [];
    for (const link of buildId ? evidenceRegistry.forTarget(buildId) : []) {
      const carry = {
        build: {
          id: link.sourceBuildId,
          version: link.version,
          builtAt: link.builtAt,
        },
        equivalence: {
          fingerprint: link.fingerprint,
          checkedAt: link.checkedAt,
          evidence: link.evidence,
        },
      };
      // Read original current votes only: no chains, copies, refreshed dates or renewed expiry.
      collect(link.sourceBuildId, link.feature, carry);
      for (const check of JSON.parse(link.engineChecks)) {
        if (check.feature === link.feature && carriedEngineChecks.length < 24)
          carriedEngineChecks.push({ ...check, ...carry });
      }
    }
    for (const cell of cells.values()) {
      cell.status =
        cell.problems || cell.carried?.problems
          ? "issue"
          : cell.eligibleWorking >= 2 ||
              (cell.carried?.eligibleWorking ?? 0) >= 2
            ? "confirmed"
            : cell.working || cell.carried?.working
              ? "working"
              : "untested";
    }
    return {
      // Older clients must not present carried confirmation as fresh exact-build votes.
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      builds,
      buildId,
      cells: [...cells.values()],
      engineChecks: build ? JSON.parse(build.engine_checks) : [],
      carriedEngineChecks,
    };
  };
  const review = (reference, state) => {
    if (!["accepted", "excluded", "resolved"].includes(state)) return false;
    if (state === "resolved")
      return (
        database
          .prepare(
            "UPDATE community_votes SET has_issue=0 WHERE reference=? AND result='working'",
          )
          .run(reference).changes > 0
      );
    return (
      database
        .prepare("UPDATE community_votes SET review=? WHERE reference=?")
        .run(state, reference).changes > 0
    );
  };
  const withdraw = (value) => {
    if (
      !objectWithKeys(value, ["reference", "receipt"]) ||
      !/^BC-[a-f0-9]{24}$/.test(value.reference ?? "") ||
      !/^[a-f0-9]{64}$/.test(value.receipt ?? "")
    )
      return false;
    const record = database
      .prepare("SELECT receipt FROM community_submissions WHERE reference=?")
      .get(value.reference);
    if (!record || record.receipt !== value.receipt) return false;
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("DELETE FROM community_votes WHERE reference=?")
        .run(value.reference);
      database
        .prepare("DELETE FROM reports WHERE reference=?")
        .run(value.reference);
      database
        .prepare("DELETE FROM community_revisions WHERE reference=?")
        .run(value.reference);
      database
        .prepare("DELETE FROM community_submissions WHERE reference=?")
        .run(value.reference);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return true;
  };
  return {
    accept,
    matrix,
    registerBuild,
    review,
    withdraw,
    purge,
    registerEquivalence: evidenceRegistry.registerEquivalence,
    revokeEquivalence: evidenceRegistry.revokeEquivalence,
  };
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
  const maxReportsPerMinute = Number(
    options.maxReportsPerMinute ??
      process.env.BROWSERSDR_REPORT_MAX_REPORTS_PER_MINUTE ??
      120,
  );
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

  const community = createCommunityStore(database, options);

  const purgeExpired = (now = new Date()) => {
    community.purge(now.toISOString());
    database
      .prepare("DELETE FROM reports WHERE expires_at <= ?")
      .run(now.toISOString());
    database
      .prepare("DELETE FROM fingerprint_counts WHERE expires_at <= ?")
      .run(now.toISOString());
    database
      .prepare("DELETE FROM rate_limits WHERE expires_at <= ?")
      .run(Math.floor(now.getTime() / 1000));
  };
  purgeExpired();
  // Run even when no reports arrive. Start only while the server owns the DB.
  let retentionTimer;
  const allowWrite = (response) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const minute = Math.floor(nowSeconds / 60);
    const bucket = `global:${minute}`;
    const current = rateRead.get(bucket);
    const count =
      current && current.expires_at > nowSeconds ? current.count + 1 : 1;
    if (count > maxReportsPerMinute) {
      response.writeHead(429);
      response.end();
      return false;
    }
    rateWrite.run(bucket, count, (minute + 2) * 60);
    return true;
  };
  const server = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      url.pathname === "/api/v1/compatibility-matrix" &&
      request.method === "GET"
    ) {
      if (
        [...url.searchParams.keys()].some((key) => key !== "build") ||
        url.searchParams.getAll("build").length > 1
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      const matrix = community.matrix(url.searchParams.get("build"));
      response.writeHead(matrix ? 200 : 404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(matrix ?? { error: "Unknown build." }));
      return;
    }
    const withdrawal = request.url === "/api/v1/compatibility-reports/withdraw";
    const reportType =
      request.url === "/api/v1/compatibility-reports" || withdrawal
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
        if (withdrawal) {
          if (!allowWrite(response)) return;
          const result = community.withdraw(parsed);
          response.writeHead(result ? 200 : 404, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(
            JSON.stringify(
              result ? { withdrawn: true } : { error: "Invalid receipt." },
            ),
          );
          return;
        }
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
        if (!allowWrite(response)) return;
        if (parsed.schemaVersion === 2 && reportType === "compatibility") {
          const result = community.accept(parsed);
          response.writeHead(result.status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify(result.body));
          return;
        }
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
        purgeExpired(receivedAt);
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
  server.on("listening", () => {
    retentionTimer = setInterval(
      () => {
        try {
          purgeExpired();
        } catch (error) {
          console.error("Report retention cleanup failed", error);
        }
      },
      options.cleanupIntervalMs ?? 60 * 60 * 1000,
    );
    retentionTimer.unref();
  });
  server.on("close", () => clearInterval(retentionTimer));
  return { server, database, purgeExpired, community };
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
