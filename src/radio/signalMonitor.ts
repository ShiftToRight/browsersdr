import {
  associateAdaptive,
  stableCenter,
  CENTER_EVIDENCE_LIMIT,
  MAX_GROUP_COMPONENTS,
  type CenterEvidence,
  type AdaptiveGroup,
} from "./adaptiveGrouping";
import {
  MONITOR_PRESETS,
  validateMonitorAnalysis,
  type MonitorAnalysis,
} from "./monitorDetection";
import {
  createSurveyRunSnapshot,
  validateSurveyProfile,
  type SurveyProfile,
  type SurveyRunSnapshot,
} from "./fieldSurvey";
import {
  planSpectrumScan,
  type ScanWindowPlan,
  type ScanWindowResult,
  type SignalCandidate,
} from "./spectrumScan";
import {
  targetContains,
  validateMonitorTargets,
  customMonitorProfile,
  type MonitorTarget,
} from "./customMonitor";
import { validateSourceFrequency } from "./sourceCapabilities";
import type { SourceSessionMetadata } from "./types";

export const MONITOR_MAX_SIGNALS = 512;
export const MONITOR_MAX_WINDOWS = 256;
export const MONITOR_HISTORY_LENGTH = 24;
export interface MonitorWindow {
  id: string;
  bandId: string;
  plan: ScanWindowPlan;
  visits: number;
  validMs: number;
  status: "unobserved" | "complete" | "insufficient" | "failed";
  lastAttemptAt?: string;
  lastValidAt?: string;
  revisitMs?: number;
  coverage: number;
  error?: string;
}
export interface MonitorObservation {
  at: string;
  seen: boolean;
  snrDb?: number;
}
export interface MonitorSignal {
  group?: AdaptiveGroup;
  centerEvidence?: CenterEvidence[];
  centerSpreadHz?: number;
  id: string;
  bandId: string;
  targetIds?: string[];
  lowerFrequencyHz?: number;
  upperFrequencyHz?: number;
  peakFrequencyHz?: number;
  lowerEdgeClipped?: boolean;
  upperEdgeClipped?: boolean;
  confirmed?: boolean;
  changeStreak?: number;
  frequencyHz: number;
  bandwidthHz: number;
  peakDb: number;
  noiseFloorDb: number;
  firstSeen: string;
  lastSeen: string;
  lastVisited: string;
  detections: number;
  misses: number;
  validMs: number;
  activeMs: number;
  baseline: { frequencyHz: number; bandwidthHz: number; snrDb: number };
  change: "new" | "known" | "changed" | "returning";
  inBaseline: boolean;
  caution?: string;
  history: MonitorObservation[];
}
export interface MonitorSession {
  version: 1 | 2 | 3 | 4;
  analysis?: MonitorAnalysis;
  discardedCandidates?: number;
  targets?: MonitorTarget[];
  id: string;
  snapshot: SurveyRunSnapshot;
  context: string;
  status: "running" | "paused" | "stopped" | "interrupted" | "failed";
  updatedAt: string;
  baselineAt: string;
  sweeps: number;
  nextWindow: number;
  omittedSignals: number;
  windows: MonitorWindow[];
  signals: MonitorSignal[];
  message: string;
}

/** Center/channel/generation change during sweeps; all acquisition settings stay comparable. */
export function monitorContext(
  profile: SurveyProfile,
  receiver: SourceSessionMetadata,
  targets?: MonitorTarget[],
  analysis?: MonitorAnalysis,
): string {
  profile = validateSurveyProfile(profile);
  return JSON.stringify({
    ...(analysis ? { analysis: validateMonitorAnalysis(analysis) } : {}),
    ...(targets ? { targets: validateMonitorTargets(targets) } : {}),
    profile: {
      ...profile,
      site: {
        ...profile.site,
        location: profile.site.location
          ? {
              ...profile.site.location,
              snapshotAt: undefined,
              stale: undefined,
            }
          : undefined,
      },
    },
    source: receiver.source,
    rate: receiver.actualSampleRateHz,
    gain: receiver.gainDb,
    hackrf: receiver.hackrf
      ? {
          identity: receiver.hackrf.capabilities.identity,
          rate: receiver.hackrf.nativeSampleRateHz,
          effectiveRate: receiver.hackrf.effectiveSampleRateHz,
          adcRate: receiver.hackrf.adcSampleRateHz,
          lna: receiver.hackrf.captureSettings.rxLnaGainCode,
          vga: receiver.hackrf.captureSettings.rxVgaGainDb,
          amplifier: receiver.hackrf.captureSettings.rfAmplifierEnabled,
          bandwidth:
            receiver.hackrf.captureSettings.requestedBasebandBandwidthHz,
        }
      : undefined,
    bladerf: receiver.bladerf
      ? {
          identity: receiver.bladerf.identity,
          rate: receiver.bladerf.acceptedSampleRateHz,
          bandwidth: receiver.bladerf.acceptedBandwidthHz,
          mode: receiver.bladerf.gainMode,
          input: receiver.bladerf.rxInput,
          gain: receiver.bladerf.requestedGainDb,
        }
      : undefined,
    usrp: receiver.usrpB205
      ? {
          capabilities: receiver.usrpB205.capabilities,
          rate: receiver.usrpB205.configuration.acceptedSampleRateHz,
          bandwidth: receiver.usrpB205.configuration.acceptedBandwidthHz,
          mode: receiver.usrpB205.configuration.acceptedGainMode,
        }
      : undefined,
    mode: receiver.mode,
    bandwidth: receiver.channelBandwidthHz,
    squelch: receiver.squelch,
    srd: receiver.srd,
    textModem: receiver.textModem,
  });
}
export function createMonitorSession(
  profile: SurveyProfile,
  receiver: SourceSessionMetadata,
  now = new Date().toISOString(),
  targets?: MonitorTarget[],
  analysis?: MonitorAnalysis,
): MonitorSession {
  if (receiver.source === "replay")
    throw new Error("Replay cannot monitor a tunable band.");
  if (receiver.mode === "ADS-B")
    throw new Error(
      "Choose Spectrum only or another receiver mode before monitoring bands.",
    );
  const validTargets = targets ? validateMonitorTargets(targets) : undefined;
  const valid = validTargets
    ? customMonitorProfile(profile, profile.bands[0]!, validTargets, receiver)
    : validateSurveyProfile(profile);
  if (
    analysis &&
    valid.bands.some(
      (b) => (b.dwellMs * receiver.actualSampleRateHz) / 1000 > 256 * 4096 * 4,
    )
  )
    throw new Error(
      "Dwell exceeds the bounded measurement buffer at this sample rate. Reduce dwell or sample rate before monitoring.",
    );
  const windows = valid.bands.flatMap((band) =>
    planSpectrumScan(
      band.startFrequencyHz,
      band.endFrequencyHz,
      receiver.actualSampleRateHz,
      receiver.source,
    ).map((plan): MonitorWindow => ({
      id: `${band.id}:${plan.index}`,
      bandId: band.id,
      plan,
      visits: 0,
      validMs: 0,
      status: "unobserved",
      coverage: 0,
    })),
  );
  if (windows.length > MONITOR_MAX_WINDOWS)
    throw new Error(
      `Monitor up to ${MONITOR_MAX_WINDOWS} tuning windows; narrow the enabled bands.`,
    );
  // Offset narrow custom acquisitions within their guarded passband, where source limits permit.
  if (validTargets)
    for (const w of windows) {
      const spare =
        receiver.actualSampleRateHz * 0.75 -
        (w.plan.upperFrequencyHz - w.plan.lowerFrequencyHz);
      const offset = Math.floor(
        Math.min(receiver.actualSampleRateHz * 0.08, spare / 2),
      );
      const currentCenter = receiver.hardwareCenterFrequencyHz;
      const usableHalf = receiver.actualSampleRateHz * 0.375;
      const currentFits =
        w.plan.lowerFrequencyHz >= currentCenter - usableHalf &&
        w.plan.upperFrequencyHz <= currentCenter + usableHalf;
      const nearTargetCenter = validTargets.some(
        (t) =>
          t.kind === "frequency" &&
          Math.abs(
            (t.startFrequencyHz + t.endFrequencyHz) / 2 - currentCenter,
          ) <=
            receiver.actualSampleRateHz / 2048,
      );
      const centers =
        currentFits && !nearTargetCenter
          ? [
              currentCenter,
              w.plan.centerFrequencyHz + offset,
              w.plan.centerFrequencyHz - offset,
            ]
          : [
              w.plan.centerFrequencyHz + offset,
              w.plan.centerFrequencyHz - offset,
            ];
      let placed = false;
      for (const center of centers) {
        try {
          validateSourceFrequency(
            receiver.source,
            center,
            receiver.actualSampleRateHz,
            receiver.hackrf?.capabilities.identity,
          );
          w.plan = { ...w.plan, centerFrequencyHz: center };
          placed = true;
          break;
        } catch {
          /* Try the other offset near a source limit. */
        }
      }
      if (!placed)
        throw new Error(
          "The custom acquisition passband does not fit this source. Move the target farther from its tuning limit or lower the sample rate.",
        );
    }
  const snapshot = createSurveyRunSnapshot(valid, valid.bands, receiver, now);
  return {
    version: analysis ? (analysis.version === 2 ? 4 : 3) : validTargets ? 2 : 1,
    ...(analysis
      ? { analysis: validateMonitorAnalysis(analysis), discardedCandidates: 0 }
      : {}),
    ...(validTargets ? { targets: validTargets } : {}),
    id: snapshot.sessionId,
    snapshot,
    context: monitorContext(valid, receiver, validTargets, analysis),
    status: "paused",
    updatedAt: now,
    baselineAt: now,
    sweeps: 0,
    nextWindow: 0,
    omittedSignals: 0,
    windows,
    signals: [],
    message: "Ready to monitor.",
  };
}

function regionMatch(
  s: MonitorSignal,
  c: SignalCandidate,
  resolution: number,
): boolean {
  if (
    s.lowerFrequencyHz === undefined ||
    s.upperFrequencyHz === undefined ||
    c.lowerFrequencyHz === undefined ||
    c.upperFrequencyHz === undefined
  )
    return false;
  const overlap =
    Math.min(s.upperFrequencyHz, c.upperFrequencyHz) -
    Math.max(s.lowerFrequencyHz, c.lowerFrequencyHz);
  const touching =
    (s.upperEdgeClipped &&
      c.lowerEdgeClipped &&
      Math.abs(s.upperFrequencyHz - c.lowerFrequencyHz) <= 2 * resolution) ||
    (s.lowerEdgeClipped &&
      c.upperEdgeClipped &&
      Math.abs(s.lowerFrequencyHz - c.upperFrequencyHz) <= 2 * resolution);
  return (
    !!touching ||
    (Math.abs(s.frequencyHz - c.frequencyHz) <= 2 * resolution &&
      Math.max(s.bandwidthHz, c.bandwidthHz) <= 4 * resolution) ||
    (overlap >= 0.6 * Math.min(s.bandwidthHz, c.bandwidthHz) &&
      Math.abs(s.frequencyHz - c.frequencyHz) <=
        Math.max(2 * resolution, 0.6 * Math.max(s.bandwidthHz, c.bandwidthHz)))
  );
}
function signalTargets(
  session: MonitorSession,
  c: SignalCandidate,
): string[] | undefined {
  return session.targets
    ?.filter((t) =>
      session.analysis &&
      c.lowerFrequencyHz !== undefined &&
      c.upperFrequencyHz !== undefined
        ? t.startFrequencyHz < c.upperFrequencyHz &&
          t.endFrequencyHz > c.lowerFrequencyHz
        : targetContains(t, c.frequencyHz),
    )
    .map((t) => t.id);
}
export function monitorSignalRecent(
  session: MonitorSession,
  s: MonitorSignal,
  now = Date.now(),
): boolean {
  const revisit = Math.max(
    0,
    ...session.windows
      .filter((w) => w.bandId === s.bandId)
      .map((w) => w.revisitMs ?? 0),
  );
  return (
    s.misses < 3 && now - Date.parse(s.lastSeen) <= Math.max(30000, revisit * 3)
  );
}
/** Immutable update. Failed/undersampled visits never create absence or occupancy evidence. */
export function recordMonitorVisit(
  session: MonitorSession,
  index: number,
  result: ScanWindowResult,
  measuredMs: number,
  at: string,
): MonitorSession {
  const region = session.windows[index]!;
  const valid = result.status === "complete";
  const elapsed = valid ? measuredMs : 0;
  const regionNext: MonitorWindow = {
    ...region,
    visits: region.visits + 1,
    status: result.status,
    coverage: result.coverage,
    lastAttemptAt: at,
    lastValidAt: valid ? at : region.lastValidAt,
    revisitMs:
      valid && region.lastValidAt
        ? Math.max(0, Date.parse(at) - Date.parse(region.lastValidAt))
        : region.revisitMs,
    validMs: region.validMs + elapsed,
    error: result.error,
  };
  const signals = session.signals.map((signal) => ({ ...signal }));
  const touched = new Set<string>();
  let omittedSignals = session.omittedSignals;
  let discardedCandidates = session.discardedCandidates ?? 0;
  const adaptive = session.analysis?.version === 2;
  const resolutionHz = adaptive
    ? result.binSpacingHz!
    : session.snapshot.receiver.actualSampleRateHz / 4096;
  if (
    adaptive &&
    valid &&
    (!Number.isFinite(resolutionHz) ||
      resolutionHz <= 0 ||
      result.candidates.some(
        (c) => !c.group || c.group.binSpacingHz !== resolutionHz,
      ))
  )
    throw new Error(
      "Adaptive monitoring requires actual FFT spacing and component evidence.",
    );
  const candidates = adaptive
    ? [...result.candidates]
        .filter(
          (c) =>
            c.frequencyHz >= region.plan.lowerFrequencyHz &&
            c.frequencyHz <= region.plan.upperFrequencyHz &&
            (!session.targets || !!signalTargets(session, c)?.length),
        )
        .sort(
          (a, b) =>
            a.frequencyHz - b.frequencyHz || a.bandwidthHz - b.bandwidthHz,
        )
    : result.candidates;
  const associations =
    adaptive && valid
      ? associateAdaptive(
          signals.filter((s) => s.bandId === region.bandId),
          candidates,
          resolutionHz,
        )
      : undefined;
  if (valid) {
    // Nearest one-to-one association prevents a broad overlap from consuming neighboring entries.
    for (const candidate of candidates) {
      if (
        candidate.frequencyHz < region.plan.lowerFrequencyHz ||
        candidate.frequencyHz > region.plan.upperFrequencyHz
      )
        continue;
      const targetIds = signalTargets(session, candidate);
      if (targetIds && !targetIds.length) continue;
      const snrDb = candidate.peakDb - candidate.noiseFloorDb;
      let entry = adaptive
        ? signals.find((s) => s.id === associations?.assigned.get(candidate))
        : signals
            .filter(
              (s) =>
                s.bandId === region.bandId &&
                !touched.has(s.id) &&
                (session.analysis
                  ? regionMatch(s, candidate, resolutionHz)
                  : Math.abs(s.frequencyHz - candidate.frequencyHz) <=
                    Math.max(
                      2 * resolutionHz,
                      Math.min(s.bandwidthHz, candidate.bandwidthHz) * 0.25,
                    )),
            )
            .sort(
              (a, b) =>
                Math.abs(a.frequencyHz - candidate.frequencyHz) -
                Math.abs(b.frequencyHz - candidate.frequencyHz),
            )[0];
      const caution =
        Math.abs(candidate.frequencyHz - region.plan.centerFrequencyHz) <=
          resolutionHz * 2 && candidate.bandwidthHz <= resolutionHz * 4
          ? "Near receiver center: possible DC response; verify with an offset-center observation."
          : snrDb <
              session.snapshot.profile.bands.find(
                (b) => b.id === region.bandId,
              )!.thresholdDb +
                3
            ? "Low detection margin; confirm on further visits."
            : undefined;
      if (!entry) {
        if (signals.length >= MONITOR_MAX_SIGNALS) {
          const stale = session.analysis
            ? signals
                .filter(
                  (s) =>
                    !s.confirmed &&
                    !touched.has(s.id) &&
                    (s.misses >= 3 ||
                      Date.parse(at) - Date.parse(s.lastSeen) > 30000),
                )
                .sort(
                  (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen),
                )[0]
            : undefined;
          if (stale) {
            signals.splice(signals.indexOf(stale), 1);
            discardedCandidates++;
          } else {
            omittedSignals++;
            continue;
          }
        }
        entry = {
          id: session.analysis
            ? crypto.randomUUID()
            : `${session.id}:${session.sweeps}:${index}:${signals.length}`,
          bandId: region.bandId,
          ...candidate,
          firstSeen: at,
          lastSeen: at,
          lastVisited: at,
          detections: 0,
          misses: 0,
          validMs: 0,
          activeMs: 0,
          baseline: {
            frequencyHz: candidate.frequencyHz,
            bandwidthHz: candidate.bandwidthHz,
            snrDb,
          },
          change: "new",
          inBaseline: false,
          history: [],
        };
        signals.push(entry);
      }
      const priorMisses = entry.misses;
      const centerEvidence = adaptive
        ? [
            ...(entry.centerEvidence ?? []),
            ...(!candidate.lowerEdgeClipped && !candidate.upperEdgeClipped
              ? [
                  {
                    at,
                    lowerHz: candidate.lowerFrequencyHz!,
                    upperHz: candidate.upperFrequencyHz!,
                    binSpacingHz: resolutionHz,
                  },
                ]
              : []),
          ].slice(-CENTER_EVIDENCE_LIMIT)
        : [];
      const stable = stableCenter(centerEvidence);
      const comparisonCenter =
        adaptive && centerEvidence.length
          ? stable.centerHz
          : candidate.frequencyHz;
      const changed =
        Math.abs(snrDb - entry.baseline.snrDb) >= 6 ||
        Math.abs(comparisonCenter - entry.baseline.frequencyHz) >
          (session.analysis
            ? Math.max(resolutionHz * 2, entry.baseline.bandwidthHz * 0.15)
            : resolutionHz * 2) ||
        Math.max(
          candidate.bandwidthHz / entry.baseline.bandwidthHz,
          entry.baseline.bandwidthHz / candidate.bandwidthHz,
        ) >= 2;
      entry.change =
        entry.misses > 0
          ? "returning"
          : changed
            ? "changed"
            : entry.change === "returning"
              ? "returning"
              : entry.inBaseline
                ? "known"
                : "new";
      if (session.analysis) {
        entry.changeStreak =
          entry.inBaseline && changed ? (entry.changeStreak ?? 0) + 1 : 0;
        entry.change =
          priorMisses >= 3
            ? "returning"
            : entry.changeStreak >= 3
              ? "changed"
              : entry.inBaseline
                ? "known"
                : "new";
        const lower = candidate.lowerEdgeClipped
          ? Math.min(
              entry.lowerFrequencyHz ?? candidate.lowerFrequencyHz!,
              candidate.lowerFrequencyHz!,
            )
          : candidate.lowerFrequencyHz!;
        const upper = candidate.upperEdgeClipped
          ? Math.max(
              entry.upperFrequencyHz ?? candidate.upperFrequencyHz!,
              candidate.upperFrequencyHz!,
            )
          : candidate.upperFrequencyHz!;
        entry.lowerEdgeClipped =
          candidate.lowerEdgeClipped && lower < candidate.lowerFrequencyHz!
            ? entry.lowerEdgeClipped
            : candidate.lowerEdgeClipped;
        entry.upperEdgeClipped =
          candidate.upperEdgeClipped && upper > candidate.upperFrequencyHz!
            ? entry.upperEdgeClipped
            : candidate.upperEdgeClipped;
        entry.lowerFrequencyHz = lower;
        entry.upperFrequencyHz = upper;
        entry.peakFrequencyHz = candidate.peakFrequencyHz;
        entry.frequencyHz =
          adaptive && centerEvidence.length
            ? stable.centerHz
            : (lower + upper) / 2;
        if (adaptive) {
          entry.group = {
            ...structuredClone(candidate.group!),
            ...(associations?.uncertain.has(candidate)
              ? { associationUncertain: true }
              : {}),
          };
          entry.centerEvidence = centerEvidence;
          entry.centerSpreadHz = stable.spreadHz;
        }
        entry.bandwidthHz = upper - lower;
        entry.targetIds = signalTargets(session, entry);
        entry.confirmed =
          !!entry.confirmed ||
          entry.history.slice(-4).filter((h) => h.seen).length + 1 >=
            MONITOR_PRESETS[session.analysis.preset].confirmation;
      } else {
        if (targetIds) entry.targetIds = targetIds;
        entry.frequencyHz = candidate.frequencyHz;
      }
      if (!session.analysis) entry.bandwidthHz = candidate.bandwidthHz;
      entry.peakDb = candidate.peakDb;
      entry.noiseFloorDb = candidate.noiseFloorDb;
      entry.lastSeen = at;
      entry.lastVisited = at;
      entry.detections++;
      entry.misses = 0;
      entry.validMs += elapsed;
      entry.activeMs +=
        elapsed * Math.max(0, Math.min(1, candidate.occupancy ?? 1));
      entry.caution = caution;
      entry.history = [...entry.history, { at, seen: true, snrDb }].slice(
        -MONITOR_HISTORY_LENGTH,
      );
      touched.add(entry.id);
    }
    for (const entry of signals) {
      // Only a fully covered signal can acquire negative evidence on this visit.
      if (
        entry.bandId !== region.bandId ||
        touched.has(entry.id) ||
        (entry.lowerFrequencyHz ?? entry.frequencyHz - entry.bandwidthHz / 2) <
          region.plan.lowerFrequencyHz ||
        (entry.upperFrequencyHz ?? entry.frequencyHz + entry.bandwidthHz / 2) >
          region.plan.upperFrequencyHz
      )
        continue;
      entry.lastVisited = at;
      entry.misses++;
      if (session.analysis) entry.changeStreak = 0;
      entry.validMs += elapsed;
      entry.history = [...entry.history, { at, seen: false }].slice(
        -MONITOR_HISTORY_LENGTH,
      );
    }
  }
  const nextWindow = (index + 1) % session.windows.length;
  return {
    ...session,
    updatedAt: at,
    signals,
    omittedSignals,
    ...(session.analysis ? { discardedCandidates } : {}),
    windows: session.windows.map((w, i) => (i === index ? regionNext : w)),
    nextWindow,
    sweeps: session.sweeps + (nextWindow === 0 ? 1 : 0),
  };
}
export function setMonitorBaseline(
  session: MonitorSession,
  at = new Date().toISOString(),
): MonitorSession {
  return {
    ...session,
    updatedAt: at,
    baselineAt: at,
    signals: session.signals.map((s) => ({
      ...s,
      change: "known",
      inBaseline: true,
      ...(session.analysis ? { changeStreak: 0 } : {}),
      baseline: {
        frequencyHz: s.frequencyHz,
        bandwidthHz: s.bandwidthHz,
        snrDb: s.peakDb - s.noiseFloorDb,
      },
    })),
  };
}

/** Persistence/import boundary: bounded graph, complete fields and a rebuilt canonical plan. */
export function validateMonitorSession(value: unknown): MonitorSession {
  const invalid = () => {
    throw new Error(
      "Saved monitoring history is invalid or unsupported. Export any in-memory history and start a new session.",
    );
  };
  if (
    !value ||
    JSON.stringify(value).length >
      ((value as MonitorSession).version === 4 ? 8_000_000 : 2_000_000)
  )
    invalid();
  const s = value as MonitorSession;
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const count = (v: unknown) =>
    number(v) && Number.isSafeInteger(v) && (v as number) >= 0;
  const date = (v: unknown) =>
    typeof v === "string" && v.length < 64 && Number.isFinite(Date.parse(v));
  const text = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= 500;
  if (
    ![1, 2, 3, 4].includes(s.version) ||
    (s.version >= 3
      ? !s.analysis || !count(s.discardedCandidates)
      : s.analysis !== undefined) ||
    (s.version === 1 && s.targets !== undefined) ||
    (s.version === 2 && !s.targets) ||
    !text(s.id) ||
    !s.snapshot ||
    s.snapshot.sessionId !== s.id ||
    !date(s.snapshot.startedAt) ||
    !date(s.updatedAt) ||
    !date(s.baselineAt) ||
    !["running", "paused", "stopped", "interrupted", "failed"].includes(
      s.status,
    ) ||
    !count(s.sweeps) ||
    !count(s.nextWindow) ||
    !count(s.omittedSignals) ||
    !text(s.message) ||
    !Array.isArray(s.windows) ||
    !s.windows.length ||
    s.windows.length > MONITOR_MAX_WINDOWS ||
    !Array.isArray(s.signals) ||
    s.signals.length > MONITOR_MAX_SIGNALS
  )
    invalid();
  if ((s.version === 4) !== (s.analysis?.version === 2)) invalid();
  const r = s.snapshot.receiver;
  if (
    !r ||
    !number(r.actualSampleRateHz) ||
    r.actualSampleRateHz <= 0 ||
    !number(r.hardwareCenterFrequencyHz) ||
    !number(r.selectedChannelFrequencyHz) ||
    !number(r.channelBandwidthHz) ||
    !number(r.squelch) ||
    !(r.gainDb === null || number(r.gainDb)) ||
    !["synthetic", "rtl-sdr", "hackrf", "bladerf", "usrp-b205"].includes(
      r.source,
    )
  )
    invalid();
  const canonical = createMonitorSession(
    s.snapshot.profile,
    r,
    s.snapshot.startedAt,
    s.targets,
    s.analysis,
  );
  if (
    canonical.context !== s.context ||
    s.nextWindow >= s.windows.length ||
    s.windows.length !== canonical.windows.length
  )
    invalid();
  s.windows.forEach((w, i) => {
    const plan = canonical.windows[i]!;
    if (
      w.id !== plan.id ||
      w.bandId !== plan.bandId ||
      JSON.stringify(w.plan) !== JSON.stringify(plan.plan) ||
      !count(w.visits) ||
      !number(w.validMs) ||
      w.validMs < 0 ||
      !["unobserved", "complete", "insufficient", "failed"].includes(
        w.status,
      ) ||
      !number(w.coverage) ||
      w.coverage < 0 ||
      w.coverage > 1 ||
      (w.lastAttemptAt !== undefined && !date(w.lastAttemptAt)) ||
      (w.lastValidAt !== undefined && !date(w.lastValidAt)) ||
      (w.revisitMs !== undefined &&
        (!number(w.revisitMs) || w.revisitMs < 0)) ||
      (w.error !== undefined && !text(w.error))
    )
      invalid();
  });
  const ids = new Set<string>();
  s.signals.forEach((signal) => {
    const band = s.snapshot.profile.bands.find((b) => b.id === signal.bandId);
    if (
      !text(signal.id) ||
      ids.has(signal.id) ||
      !band ||
      (s.targets !== undefined &&
        JSON.stringify(signal.targetIds) !==
          JSON.stringify(signalTargets(s, signal))) ||
      (s.analysis !== undefined &&
        (!number(signal.lowerFrequencyHz) ||
          !number(signal.upperFrequencyHz) ||
          !number(signal.peakFrequencyHz) ||
          signal.lowerFrequencyHz! < band!.startFrequencyHz ||
          signal.upperFrequencyHz! > band!.endFrequencyHz ||
          signal.lowerFrequencyHz! >= signal.upperFrequencyHz! ||
          Math.abs(
            signal.bandwidthHz -
              (signal.upperFrequencyHz! - signal.lowerFrequencyHz!),
          ) > 0.01 ||
          (s.version !== 4 &&
            Math.abs(
              signal.frequencyHz -
                (signal.upperFrequencyHz! + signal.lowerFrequencyHz!) / 2,
            ) > 0.01) ||
          signal.peakFrequencyHz! < signal.lowerFrequencyHz! ||
          signal.peakFrequencyHz! > signal.upperFrequencyHz! ||
          typeof signal.confirmed !== "boolean" ||
          !count(signal.changeStreak) ||
          typeof signal.lowerEdgeClipped !== "boolean" ||
          typeof signal.upperEdgeClipped !== "boolean")) ||
      !number(signal.frequencyHz) ||
      signal.frequencyHz < band.startFrequencyHz ||
      signal.frequencyHz > band.endFrequencyHz ||
      !number(signal.bandwidthHz) ||
      signal.bandwidthHz <= 0 ||
      !number(signal.peakDb) ||
      !number(signal.noiseFloorDb) ||
      !date(signal.firstSeen) ||
      !date(signal.lastSeen) ||
      !date(signal.lastVisited) ||
      !count(signal.detections) ||
      !count(signal.misses) ||
      !number(signal.validMs) ||
      signal.validMs < 0 ||
      !number(signal.activeMs) ||
      signal.activeMs < 0 ||
      signal.activeMs > signal.validMs ||
      !["new", "known", "changed", "returning"].includes(signal.change) ||
      typeof signal.inBaseline !== "boolean" ||
      !signal.baseline ||
      !number(signal.baseline.frequencyHz) ||
      !number(signal.baseline.bandwidthHz) ||
      signal.baseline.bandwidthHz <= 0 ||
      !number(signal.baseline.snrDb) ||
      (signal.caution !== undefined && !text(signal.caution)) ||
      !Array.isArray(signal.history) ||
      signal.history.length > MONITOR_HISTORY_LENGTH
    )
      invalid();
    if (s.version === 4) {
      const group = signal.group;
      const evidence = signal.centerEvidence;
      if (
        !group ||
        !number(group.binSpacingHz) ||
        group.binSpacingHz <= 0 ||
        !count(group.componentCount) ||
        group.componentCount < 1 ||
        group.componentCount > 4096 ||
        !["contiguous-support", "supported-notch"].includes(group.reason) ||
        (group.associationUncertain !== undefined &&
          typeof group.associationUncertain !== "boolean") ||
        !Array.isArray(group.components) ||
        group.components.length !==
          Math.min(group.componentCount, MAX_GROUP_COMPONENTS) ||
        !Array.isArray(evidence) ||
        evidence.length > CENTER_EVIDENCE_LIMIT ||
        !number(signal.centerSpreadHz) ||
        signal.centerSpreadHz! < 0
      )
        invalid();
      group!.components.forEach((c, i) => {
        if (
          !number(c.lowerHz) ||
          !number(c.upperHz) ||
          c.lowerHz < signal.lowerFrequencyHz! ||
          c.upperHz > signal.upperFrequencyHz! ||
          c.upperHz <= c.lowerHz ||
          !number(c.peakHz) ||
          c.peakHz < c.lowerHz ||
          c.peakHz > c.upperHz ||
          !number(c.peakDb) ||
          (i > 0 && group!.components[i - 1]!.upperHz >= c.lowerHz)
        )
          invalid();
      });
      evidence!.forEach((e) => {
        if (
          !date(e.at) ||
          !number(e.lowerHz) ||
          !number(e.upperHz) ||
          e.lowerHz < band!.startFrequencyHz ||
          e.upperHz > band!.endFrequencyHz ||
          e.upperHz <= e.lowerHz ||
          !number(e.binSpacingHz) ||
          e.binSpacingHz <= 0
        )
          invalid();
      });
      const stable = stableCenter(evidence!);
      const center = evidence!.length
        ? stable.centerHz
        : (signal.lowerFrequencyHz! + signal.upperFrequencyHz!) / 2;
      if (
        Math.abs(center - signal.frequencyHz) > 0.01 ||
        Math.abs(stable.spreadHz - signal.centerSpreadHz!) > 0.01
      )
        invalid();
    } else if (
      signal.group !== undefined ||
      signal.centerEvidence !== undefined ||
      signal.centerSpreadHz !== undefined
    )
      invalid();
    ids.add(signal.id);
    signal.history.forEach((h) => {
      if (
        !date(h.at) ||
        typeof h.seen !== "boolean" ||
        (h.snrDb !== undefined && !number(h.snrDb))
      )
        invalid();
    });
  });
  return structuredClone(s);
}
export function monitorCsv(session: MonitorSession): string {
  const row = (cells: unknown[]) =>
    cells.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",");
  return [
    row([
      "id",
      "band",
      "frequency_hz",
      "bandwidth_hz",
      "first_seen",
      "last_seen",
      "detections",
      "observed_ms",
      "activity_estimate",
      "change",
      "caution",
      "target_ids",
      "target_definitions_json",
      "analysis_version",
      "preset",
      "lower_hz",
      "upper_hz",
      "peak_hz",
      "confirmed",
      "center_spread_hz",
      "reliable_center_visits",
      "component_count",
      "components_json",
      "grouping_reason",
      "bin_spacing_hz",
      "association_uncertain",
    ]),
    ...session.signals.map((s) =>
      row([
        s.id,
        s.bandId,
        s.frequencyHz,
        s.bandwidthHz,
        s.firstSeen,
        s.lastSeen,
        s.detections,
        s.validMs,
        s.validMs ? s.activeMs / s.validMs : "",
        s.change,
        s.caution,
        s.targetIds?.join(";"),
        session.targets
          ? JSON.stringify(
              session.targets.filter((t) => s.targetIds?.includes(t.id)),
            )
          : "",
        session.analysis?.version,
        session.analysis?.preset,
        s.lowerFrequencyHz,
        s.upperFrequencyHz,
        s.peakFrequencyHz,
        s.confirmed,
        s.centerSpreadHz,
        s.centerEvidence?.length,
        s.group?.componentCount,
        s.group ? JSON.stringify(s.group.components) : "",
        s.group?.reason,
        s.group?.binSpacingHz,
        s.group?.associationUncertain,
      ]),
    ),
  ].join("\n");
}

/** A target's latest visit is distinct from any detection's baseline/change state. */
export function monitorTargetObservation(
  session: MonitorSession,
  target: MonitorTarget,
  now = Date.now(),
) {
  const windows = session.windows.filter(
    (w) =>
      w.plan.lowerFrequencyHz < target.endFrequencyHz &&
      w.plan.upperFrequencyHz > target.startFrequencyHz,
  );
  const allObserved = windows.length > 0 && windows.every((w) => w.lastValidAt);
  const lastValid = allObserved
    ? windows.map((w) => w.lastValidAt!).sort()[0]
    : undefined;
  const failed = windows.some(
    (w) => w.status === "failed" || w.status === "insufficient",
  );
  const matches = session.signals.filter((s) =>
    s.targetIds?.includes(target.id),
  );
  const detected = matches.some((s) =>
    windows.some(
      (w) =>
        (session.analysis
          ? w.plan.lowerFrequencyHz < s.upperFrequencyHz! &&
            w.plan.upperFrequencyHz > s.lowerFrequencyHz!
          : w.plan.lowerFrequencyHz <= s.frequencyHz &&
            w.plan.upperFrequencyHz >= s.frequencyHz) &&
        w.lastValidAt === s.lastSeen,
    ),
  );
  const sweepMs = session.windows.reduce(
    (sum, w) =>
      sum +
      (session.snapshot.profile.bands.find((b) => b.id === w.bandId)!.dwellMs +
        120),
    0,
  );
  const stale =
    !!lastValid && now - Date.parse(lastValid) > Math.max(30000, sweepMs * 3);
  const status = failed
    ? "Observation failed / incomplete"
    : stale
      ? "Observation stale"
      : !allObserved
        ? "Not yet observed"
        : detected
          ? "Activity detected"
          : "No activity during last valid visit";
  return { lastValid, status, signalCount: matches.length };
}
export function monitorTargetsCsv(
  session: MonitorSession,
  now = Date.now(),
): string {
  const row = (cells: unknown[]) =>
    cells.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",");
  return [
    row([
      "target_id",
      "kind",
      "label",
      "frequency_hz",
      "watch_width_hz",
      "start_hz",
      "end_hz",
      "observation",
      "last_valid",
      "signal_entries",
    ]),
    ...(session.targets ?? []).map((t) => {
      const observation = monitorTargetObservation(session, t, now);
      return row([
        t.id,
        t.kind,
        t.label,
        t.kind === "frequency"
          ? (t.startFrequencyHz + t.endFrequencyHz) / 2
          : "",
        t.endFrequencyHz - t.startFrequencyHz,
        t.startFrequencyHz,
        t.endFrequencyHz,
        observation.status,
        observation.lastValid,
        observation.signalCount,
      ]);
    }),
  ].join("\n");
}
