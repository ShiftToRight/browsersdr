import { normalizeDiagnosticError } from "./errorNormalize";
import type { DiagnosticEvent, DiagnosticEventInput, DiagnosticSnapshot } from "./diagnosticTypes";

export const AUTO_REPORT_KEY = "browsersdr.diagnostics.auto-report";
export const MAX_DIAGNOSTIC_EVENTS = 100;
export const MAX_DIAGNOSTIC_SNAPSHOTS = 60;

type Listener = (event: DiagnosticEvent) => void;

function randomId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(36).padStart(2, "0")).join("").toUpperCase()}`;
}

export class DiagnosticRecorder {
  private readonly events: DiagnosticEvent[] = [];
  private readonly snapshots: DiagnosticSnapshot[] = [];
  private readonly listeners = new Set<Listener>();

  record(input: DiagnosticEventInput): DiagnosticEvent {
    const normalized = normalizeDiagnosticError(input);
    const fingerprint = [input.area, input.code, input.operation ?? "", normalized.errorName ?? "", normalized.safeStack?.[0] ?? ""].join("|");
    const previous = this.events.at(-1);
    if (previous && (previous.context?.fingerprint === fingerprint)) {
      previous.count += 1;
      previous.occurredAt = new Date().toISOString();
      previous.monotonicMs = performance.now();
      for (const listener of this.listeners) listener({ ...previous });
      return { ...previous };
    }
    const event: DiagnosticEvent = {
      id: randomId("EV"),
      monotonicMs: performance.now(),
      occurredAt: new Date().toISOString(),
      area: input.area,
      code: input.code,
      severity: input.severity,
      ...(input.operation ? { operation: input.operation } : {}),
      ...normalized,
      context: { ...input.context, fingerprint },
      autoSubmitEligible: input.autoSubmitEligible === true,
      count: 1,
    };
    this.events.push(event);
    if (this.events.length > MAX_DIAGNOSTIC_EVENTS) this.events.splice(0, this.events.length - MAX_DIAGNOSTIC_EVENTS);
    for (const listener of this.listeners) listener({ ...event });
    return { ...event };
  }

  addSnapshot(snapshot: Omit<DiagnosticSnapshot, "monotonicMs">): void {
    this.snapshots.push({ ...snapshot, monotonicMs: performance.now() });
    if (this.snapshots.length > MAX_DIAGNOSTIC_SNAPSHOTS) this.snapshots.splice(0, this.snapshots.length - MAX_DIAGNOSTIC_SNAPSHOTS);
  }

  getEvents(): DiagnosticEvent[] { return this.events.map((event) => ({ ...event, context: event.context ? { ...event.context } : undefined })); }
  getSnapshots(): DiagnosticSnapshot[] { return this.snapshots.map((snapshot) => ({ ...snapshot, analysis: { ...snapshot.analysis }, channel: snapshot.channel ? { ...snapshot.channel } : undefined, ingress: snapshot.ingress ? { ...snapshot.ingress } : undefined })); }
  getLatestEvent(): DiagnosticEvent | undefined { const event = this.events.at(-1); return event ? { ...event } : undefined; }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  clear(): void { this.events.length = 0; this.snapshots.length = 0; }
}

export const defaultDiagnosticRecorder = new DiagnosticRecorder();

export function loadAutoReportPreference(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try { return storage.getItem(AUTO_REPORT_KEY) !== "false"; } catch { return true; }
}

export function saveAutoReportPreference(enabled: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(AUTO_REPORT_KEY, String(enabled)); } catch { /* Optional preference only. */ }
}

export function installGlobalDiagnosticHandlers(recorder = defaultDiagnosticRecorder): () => void {
  const error = (event: ErrorEvent) => recorder.record({ area: "application", code: "UNCAUGHT_EXCEPTION", severity: "fatal", operation: "window", error: event.error ?? event.message, autoSubmitEligible: true });
  const rejection = (event: PromiseRejectionEvent) => recorder.record({ area: "application", code: "UNHANDLED_REJECTION", severity: "fatal", operation: "promise", error: event.reason, autoSubmitEligible: true });
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
}
