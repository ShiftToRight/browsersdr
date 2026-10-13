import {
  browserSummary,
  operatingSystem,
} from "../platform/browserEnvironment";
import type { CompatibilityReportContext } from "./compatibilityTypes";
import type {
  CommunityBuild,
  CommunityMatrix,
  CommunityObservation,
  CommunityReport,
} from "./communityTypes";
import {
  COMMUNITY_FEATURES,
  COMMUNITY_HARDWARE,
  type CommunityHardwareId,
} from "./communityCatalog";
import packageInfo from "../../package.json";

export const COMMUNITY_BUILD: CommunityBuild = {
  id: import.meta.env.VITE_BUILD_ID || "development",
  version: packageInfo.version,
  builtAt: import.meta.env.VITE_BUILD_TIMESTAMP || "unknown",
};
const tabParticipants = new Map<string, string>();

/** Created only by an explicit reporting action; scoped to this build, never device-derived. */
export function communityParticipant(buildId: string): string {
  const key = `browsersdr:community-participant:${buildId}`;
  try {
    const previous = localStorage.getItem(key);
    if (previous && /^[a-f0-9]{64}$/.test(previous)) {
      tabParticipants.set(buildId, previous);
      return previous;
    }
  } catch {
    /* A tab-local fallback is visible in the reporting form. */
  }
  const existing = tabParticipants.get(buildId);
  if (existing) return existing;
  const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is optional. */
  }
  if (tabParticipants.size >= 32)
    tabParticipants.delete(tabParticipants.keys().next().value!);
  tabParticipants.set(buildId, value);
  return value;
}

export function communityContextKey(
  context: CompatibilityReportContext,
): string {
  return JSON.stringify([
    context.sessionGeneration,
    context.source,
    context.mode,
    context.sampleRateHz,
    context.nativeSampleRateHz,
    context.protocolProfile,
    context.firmwareVersion,
    context.bandwidthHz,
    context.gainMode,
    context.gainDb,
    context.lnaGainCode,
    context.vgaGainDb,
    context.rfAmplifierEnabled,
    context.antennaPowerEnabled,
    context.squelch,
    context.srdProtocol,
  ]);
}

export function buildCommunityReport(
  context: CompatibilityReportContext,
  options: {
    hardwareId: CommunityHardwareId;
    participantToken: string;
    durationMinutes: number;
    testScope?: "smoke" | "sustained";
    observations: CommunityObservation[];
    notes?: string;
    reportId?: string;
    renderer?: "webgpu" | "canvas2d" | "unknown";
  },
): CommunityReport {
  return {
    schemaVersion: 2,
    reportType: "compatibility",
    reportId: options.reportId ?? `BC-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    build: { ...COMMUNITY_BUILD },
    participantToken: options.participantToken,
    setup: {
      source: context.source,
      hardwareId:
        context.source === "rtl-sdr" ? "rtl-unknown" : options.hardwareId,
      mode: context.mode,
      srdProtocol:
        context.mode === "SRD" ? (context.srdProtocol ?? "none") : null,
      rateHz: context.sampleRateHz,
      nativeRateHz: context.nativeSampleRateHz,
      protocolProfile: context.protocolProfile,
      firmwareVersion:
        context.firmwareVersion &&
        /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:-[a-zA-Z0-9.-]{1,20})?$/.test(
          context.firmwareVersion,
        )
          ? context.firmwareVersion
          : null,
      origin:
        context.source === "replay"
          ? "replay"
          : context.source === "synthetic"
            ? "synthetic"
            : "live",
    },
    environment: {
      browser: browserSummary(),
      operatingSystem: operatingSystem(),
      renderer: options.renderer ?? "unknown",
    },
    receiverDetails: {
      lifecycle: context.lifecycle,
      bandwidthHz: context.bandwidthHz,
      squelch: context.squelch,
      gainMode: context.gainMode,
      gainDb: context.gainDb,
      lnaGainCode: context.lnaGainCode,
      vgaGainDb: context.vgaGainDb,
      rfAmplifierEnabled: context.rfAmplifierEnabled,
      antennaPowerEnabled: context.antennaPowerEnabled,
      usbApiVersion: context.usbApiVersion,
      recordingActive: context.recordingActive,
      audioState: context.audioState,
    },
    browserCapabilities: {
      secureContext: window.isSecureContext === true,
      webUsb: "usb" in navigator,
      webGpu: "gpu" in navigator,
      webAssembly: typeof WebAssembly === "object",
    },
    durationMinutes: options.durationMinutes,
    testScope: options.testScope ?? "smoke",
    observations: options.observations.map((o) => ({ ...o })),
    ...(options.notes?.trim()
      ? { notes: options.notes.trim().slice(0, 1000) }
      : {}),
  };
}

export async function sendCommunityReport(
  report: CommunityReport,
  signal?: AbortSignal,
): Promise<{ reference: string; receipt: string }> {
  const body = JSON.stringify(report);
  if (new TextEncoder().encode(body).byteLength > 32 * 1024)
    throw new Error("Report exceeds the 32 KiB limit.");
  const response = await fetch(
    import.meta.env.VITE_COMPATIBILITY_ENDPOINT?.trim() ||
      "/api/v1/compatibility-reports",
    {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Too many reports. Keep a downloaded copy and try later."
        : `Report service rejected the request (${response.status}).`,
    );
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("reference" in result) ||
    typeof result.reference !== "string" ||
    !("receipt" in result) ||
    typeof result.receipt !== "string"
  )
    throw new Error("Invalid report acknowledgement.");
  return { reference: result.reference, receipt: result.receipt };
}

export async function readCommunityMatrix(
  buildId?: string,
  signal?: AbortSignal,
): Promise<CommunityMatrix> {
  const endpoint =
    import.meta.env.VITE_COMPATIBILITY_MATRIX_ENDPOINT?.trim() ||
    "/api/v1/compatibility-matrix";
  const response = await fetch(
    endpoint + (buildId ? `?build=${encodeURIComponent(buildId)}` : ""),
    { credentials: "omit", signal },
  );
  if (!response.ok)
    throw new Error(`Community reports are unavailable (${response.status}).`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
    throw new Error("Community matrix exceeds the response limit.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Community reports are unavailable. The service did not return a valid matrix.",
    );
  }
  if (!isCommunityMatrix(data))
    throw new Error("Invalid community matrix response.");
  return data as CommunityMatrix;
}

const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const shortString = (v: unknown, max = 160): v is string =>
  typeof v === "string" && v.length <= max;
const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const date = (v: unknown) =>
  shortString(v, 40) && Number.isFinite(Date.parse(v));
const feature = (v: unknown) => COMMUNITY_FEATURES.some((f) => f.id === v);
const setup = (v: unknown) =>
  record(v) &&
  COMMUNITY_HARDWARE.some(
    (h) => h.id === v.hardwareId && h.source === v.source,
  ) &&
  [null, "none", "acurite-592txr", "fineoffset-wh51"].includes(
    v.srdProtocol as null | string,
  ) &&
  shortString(v.mode, 20) &&
  typeof v.rateHz === "number" &&
  Number.isFinite(v.rateHz) &&
  v.rateHz > 0 &&
  (v.nativeRateHz === null ||
    (typeof v.nativeRateHz === "number" && Number.isFinite(v.nativeRateHz))) &&
  (v.protocolProfile === null || shortString(v.protocolProfile, 80)) &&
  (v.firmwareVersion === null || shortString(v.firmwareVersion, 40)) &&
  ["live", "replay", "synthetic"].includes(String(v.origin));
const environment = (v: unknown) =>
  record(v) &&
  shortString(v.browser, 40) &&
  shortString(v.operatingSystem, 20) &&
  ["webgpu", "canvas2d", "unknown"].includes(String(v.renderer));
const publicBuild = (v: unknown) =>
  record(v) &&
  shortString(v.id) &&
  shortString(v.version, 40) &&
  date(v.builtAt);
const evidenceLink = (v: unknown) =>
  shortString(v, 300) && /^https:\/\/(?:github\.com|browsersdr\.com)\//.test(v);
const equivalence = (v: unknown) =>
  record(v) &&
  typeof v.fingerprint === "string" &&
  /^[a-f0-9]{64}$/.test(v.fingerprint) &&
  date(v.checkedAt) &&
  evidenceLink(v.evidence);
const publicReport = (r: unknown) =>
  record(r) &&
  ["working", "degraded", "not-working"].includes(String(r.result)) &&
  typeof r.durationMinutes === "number" &&
  Number.isFinite(r.durationMinutes) &&
  r.durationMinutes >= 0 &&
  date(r.receivedAt) &&
  (r.expiresAt === undefined || date(r.expiresAt)) &&
  environment(r.environment) &&
  setup(r.setup) &&
  ["accepted", "pending"].includes(String(r.review));
const publicCounts = (v: unknown) =>
  record(v) &&
  count(v.working) &&
  count(v.eligibleWorking) &&
  count(v.problems) &&
  Number(v.eligibleWorking) <= Number(v.working) &&
  date(v.lastAt) &&
  Array.isArray(v.reports) &&
  v.reports.length <= 6 &&
  v.reports.every(publicReport);
const engineCheck = (c: unknown) =>
  record(c) &&
  feature(c.feature) &&
  ["passed", "failed"].includes(String(c.result)) &&
  date(c.checkedAt) &&
  evidenceLink(c.evidence);
export function isCommunityMatrix(v: unknown): v is CommunityMatrix {
  if (
    !record(v) ||
    !(v.schemaVersion === 1 || v.schemaVersion === 2) ||
    !date(v.generatedAt) ||
    !(v.buildId === null || shortString(v.buildId)) ||
    !Array.isArray(v.builds) ||
    v.builds.length > 24 ||
    !Array.isArray(v.cells) ||
    v.cells.length > 1000 ||
    !Array.isArray(v.engineChecks) ||
    v.engineChecks.length > 24
  )
    return false;
  if (
    v.schemaVersion === 1 &&
    (v.carriedEngineChecks !== undefined ||
      v.cells.some((c) => record(c) && c.carried !== undefined))
  )
    return false;
  return (
    v.builds.every(publicBuild) &&
    v.cells.every((c) => {
      if (
        !record(c) ||
        !shortString(c.key, 64) ||
        !feature(c.feature) ||
        !setup(c.setup) ||
        c.hardwareId !== (c.setup as Record<string, unknown>).hardwareId ||
        !["smoke", "sustained"].includes(String(c.testScope)) ||
        !(c.platform === null || shortString(c.platform, 80)) ||
        !publicCounts(c)
      )
        return false;
      const carried = c.carried;
      if (
        carried !== undefined &&
        (!record(carried) ||
          !publicBuild(carried.build) ||
          (carried.build as Record<string, unknown>).id === v.buildId ||
          !equivalence(carried.equivalence) ||
          !publicCounts(carried) ||
          !(carried.reports as unknown[]).every(
            (r) => record(r) && date(r.expiresAt),
          ))
      )
        return false;
      const inherited = record(carried) ? carried : undefined;
      const status =
        c.problems || inherited?.problems
          ? "issue"
          : Number(c.eligibleWorking) >= 2 ||
              Number(inherited?.eligibleWorking ?? 0) >= 2
            ? "confirmed"
            : c.working || inherited?.working
              ? "working"
              : "untested";
      return c.status === status;
    }) &&
    v.engineChecks.every(engineCheck) &&
    (v.carriedEngineChecks === undefined ||
      (Array.isArray(v.carriedEngineChecks) &&
        v.carriedEngineChecks.length <= 24 &&
        v.carriedEngineChecks.every(
          (c) =>
            engineCheck(c) &&
            record(c) &&
            publicBuild(c.build) &&
            (c.build as Record<string, unknown>).id !== v.buildId &&
            equivalence(c.equivalence),
        )))
  );
}

export function downloadCommunityReport(
  report: CommunityReport | object,
  name = "community-test.json",
): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
