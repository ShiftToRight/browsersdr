import { validatePersistedSurveyRun } from "./surveyStorageValidation";
import type {
  SurveyCandidateRecord,
  SurveyManifest,
  SurveyRunSnapshot,
  SurveyRunStatus,
} from "./fieldSurvey";
import type { ScanWindowResult } from "./spectrumScan";

const DATABASE_NAME = "browsersdr-surveys";
const DATABASE_VERSION = 1;
const STORE_NAME = "survey-runs";
const LATEST_RUN_KEY = "latest";
type SurveyWrite = Omit<PersistedSurveyRun, "version" | "key" | "savedAt">;

/** React snapshots are immutable: retain only the latest reference, clone only when writing. */
export function coalescedWriter<T>(write: (value: T) => Promise<void>) {
  let pending: { value: T } | undefined;
  let draining: Promise<void> | undefined;
  return (value: T): Promise<void> => {
    pending = { value };
    if (!draining) draining = Promise.resolve().then(async () => {
      try {
      let failure: unknown;
      while (pending) {
        const next = pending.value;
        pending = undefined;
        try { await write(next); failure = undefined; } catch (error) { failure = error; }
      }
      if (failure) throw failure;
      } finally { draining = undefined; }
    });
    return draining;
  };
}
const STORAGE_TIMEOUT_MS = 5_000;

export interface PersistedSurveyRun {
  version: 1;
  key: typeof LATEST_RUN_KEY;
  savedAt: string;
  scope: "window" | "band-plan" | "full";
  status: Exclude<SurveyRunStatus, "cancelled"> | "cancelled" | "running";
  snapshot: SurveyRunSnapshot;
  manifest?: SurveyManifest;
  windows: ScanWindowResult[];
  records: SurveyCandidateRecord[];
  progress: { completed: number; total: number };
}

function openSurveyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Survey storage timed out. Export results to keep a copy.")); }, STORAGE_TIMEOUT_MS);
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error("Could not open survey storage.")); };
    request.onblocked = () => { expired = true; clearTimeout(timer); reject(new Error("Survey storage is blocked by another tab. Export results to keep a copy.")); };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
}

export const saveLatestSurveyRun = coalescedWriter<SurveyWrite>(async (run) => {
  const database = await openSurveyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const timer = setTimeout(() => { transaction.abort(); reject(new Error("Saving survey results timed out.")); }, STORAGE_TIMEOUT_MS);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
      transaction.onerror = transaction.onabort = () => {
        clearTimeout(timer); reject(transaction.error ?? new Error("Could not save survey results."));
      };
      // IDB performs the single structured clone here, after previous writes finish.
      try {
        transaction.objectStore(STORE_NAME).put(validatePersistedSurveyRun({ ...run, version: 1, key: LATEST_RUN_KEY, savedAt: new Date().toISOString() }));
      } catch (error) { clearTimeout(timer); transaction.abort(); reject(error); }
    });
  } finally { database.close(); }
});

export async function loadLatestSurveyRun(): Promise<PersistedSurveyRun | undefined> {
  const database = await openSurveyDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(LATEST_RUN_KEY);
      const timer = setTimeout(() => reject(new Error("Loading survey storage timed out.")), STORAGE_TIMEOUT_MS);
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error("Could not load survey results.")); };
    });
    if (value === undefined) return undefined;
    return validatePersistedSurveyRun(value);
  } finally {
    database.close();
  }
}
