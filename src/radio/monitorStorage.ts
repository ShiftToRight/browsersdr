import { coalescedWriter } from "./surveyStorage";
import { validateMonitorSession, type MonitorSession } from "./signalMonitor";

const DATABASE = "browsersdr-monitoring";
const STORE = "sessions";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    let expired = false;
    const request = indexedDB.open(DATABASE, 1);
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Monitoring storage timed out"));
    }, 5000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onblocked = () => {
      expired = true;
      clearTimeout(timer);
      reject(new Error("Monitoring storage blocked by another tab"));
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) request.result.close();
      else resolve(request.result);
    };
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const timer = setTimeout(() => {
        tx.abort();
        reject(new Error("Monitoring checkpoint timed out"));
      }, 5000);
      let value: T;
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(value);
      };
      tx.onabort = tx.onerror = () => {
        clearTimeout(timer);
        reject(tx.error ?? new Error("Monitoring checkpoint failed"));
      };
      try {
        const request = action(tx.objectStore(STORE));
        request.onsuccess = () => {
          value = request.result;
        };
      } catch (error) {
        clearTimeout(timer);
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}
export async function loadMonitorSession(): Promise<
  MonitorSession | undefined
> {
  const value = await transaction("readonly", (store) => store.get("latest"));
  if (value === undefined) return undefined;
  const session = validateMonitorSession(value);
  return session.status === "running"
    ? {
        ...session,
        status: "interrupted",
        message:
          "Recovered interrupted monitoring. Resume manually; the gap is unobserved.",
      }
    : session;
}
export const saveMonitorSession = coalescedWriter<MonitorSession>(
  async (session) => {
    await transaction("readwrite", (store) =>
      store.put(validateMonitorSession(session), "latest"),
    );
  },
);
