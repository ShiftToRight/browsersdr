export interface OfflineState {
  supported: boolean;
  preparing: boolean;
  ready: boolean;
  updateReady: boolean;
  error: boolean;
  needsReopen: boolean;
}

let state: OfflineState = { supported: import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext, preparing: false, ready: false, updateReady: false, error: false, needsReopen: false };
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | undefined;
let pending: Promise<void> | undefined;
let initialized = false;
let revision = 0;
const preference = "browsersdr.offline.enabled.v1";

function publish(next: Partial<OfflineState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
export const offlineState = () => state;
export function subscribeOffline(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function isComplete(worker: ServiceWorker): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ready: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(ready); };
    const timer = setTimeout(() => finish(false), 4000);
    channel.port1.onmessage = event => finish(event.data?.ready === true);
    try { worker.postMessage({ type: "OFFLINE_STATUS" }, [channel.port2]); }
    catch { finish(false); }
  });
}

async function refresh() {
  const current = ++revision;
  const active = registration?.active;
  const ready = active ? await isComplete(active) : false;
  if (current !== revision) return;
  publish({ ready, preparing: Boolean(registration?.installing), updateReady: Boolean(registration?.waiting), needsReopen: ready && !navigator.serviceWorker.controller });
}

function observe(worker: ServiceWorker) {
  worker.addEventListener("statechange", () => {
    if (worker.state === "redundant") publish({ error: true, preparing: false });
    void refresh();
  });
}

/** Cache preparation is explicit on the website, automatic in installed apps.
 * Default worker waiting is intentional: no takeover, reload or skipWaiting. */
export function prepareOffline(): Promise<void> {
  if (!state.supported) return Promise.resolve();
  if (pending) return pending;
  publish({ preparing: true, error: false });
  try { localStorage.setItem(preference, "true"); } catch { /* Optional persistence. */ }
  pending = (async () => {
    try {
      if (!registration) {
        const base = new URL(import.meta.env.BASE_URL, location.href);
        registration = await navigator.serviceWorker.register(new URL("sw.js", base).href, { scope: base.href, updateViaCache: "none" });
        registration.addEventListener("updatefound", () => {
          if (registration?.installing) observe(registration.installing);
          publish({ preparing: true, error: false });
        });
        if (registration.installing) observe(registration.installing);
      } else {
        await registration.update();
      }
      await refresh();
    } catch {
      publish({ preparing: false, error: true });
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

export function initializeOfflineApp() {
  if (initialized || !state.supported) return;
  initialized = true;
  window.addEventListener("appinstalled", () => { void prepareOffline(); });
  const installed = window.matchMedia?.("(display-mode: standalone)").matches;
  let enabled = false;
  try { enabled = localStorage.getItem(preference) === "true"; } catch { /* Storage may be disabled. */ }
  if (installed || enabled) void prepareOffline();
}
