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
let pendingWrite: Promise<void> = Promise.resolve();

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
    request.onerror = () => reject(request.error ?? new Error("Could not open survey storage."));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveLatestSurveyRun(
  run: Omit<PersistedSurveyRun, "version" | "key" | "savedAt">,
): Promise<void> {
  const stored = {
    ...structuredClone(run),
    version: 1,
    key: LATEST_RUN_KEY,
    savedAt: new Date().toISOString(),
  } satisfies PersistedSurveyRun;
  const write = pendingWrite.catch(() => undefined).then(async () => {
    const database = await openSurveyDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(stored);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("Could not save survey results."),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("Saving survey results was aborted."),
          );
      });
    } finally {
      database.close();
    }
  });
  pendingWrite = write;
  return write;
}

export async function loadLatestSurveyRun(): Promise<PersistedSurveyRun | undefined> {
  const database = await openSurveyDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(LATEST_RUN_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not load survey results."));
    });
    if (!value || typeof value !== "object") return undefined;
    const run = value as Partial<PersistedSurveyRun>;
    if (
      run.version !== 1 ||
      !run.snapshot ||
      !Array.isArray(run.windows) ||
      !Array.isArray(run.records) ||
      !run.progress
    )
      return undefined;
    return structuredClone(run as PersistedSurveyRun);
  } finally {
    database.close();
  }
}
