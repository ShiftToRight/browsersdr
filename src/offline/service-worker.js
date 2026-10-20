/* global OFFLINE_BUILD */
// This source is prefixed with the exact static build manifest by Vite.
// No skipWaiting, clients.claim, runtime caching, or reload messages: a new
// version can activate only after every window using its predecessor closes.
const scope = self.registration.scope;
const prefix = `browsersdr-offline:${scope}:`;
const cacheName = prefix + OFFLINE_BUILD.version;
const completeUrl = new URL("__offline_complete__", scope).href;
const entries = new Map(OFFLINE_BUILD.entries.map(entry => [new URL(entry.url, scope).href, entry]));

async function verify(response, entry) {
  if (!response.ok || response.type === "opaque") throw new Error("Offline file unavailable");
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== entry.size) throw new Error("Offline file size mismatch");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== entry.sha256) throw new Error("Offline file version mismatch");
  return response;
}

async function verifiedResponse(url, entry) {
  return verify(await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error" }), entry);
}

async function installBuild() {
  const cache = await caches.open(cacheName);
  try {
    const previous = await Promise.all((await caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.open(name)));
    // Sequential fetches bound network/hash/storage work and peak file memory.
    for (const [url, entry] of entries) {
      let response;
      for (const old of previous) {
        const candidate = await old.match(url);
        if (!candidate) continue;
        try { response = await verify(candidate, entry); break; }
        catch { /* Changed or damaged bytes cannot enter the new build. */ }
      }
      await cache.put(url, response ?? await verifiedResponse(url, entry));
    }
    await cache.put(completeUrl, new Response(OFFLINE_BUILD.version));
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

self.addEventListener("install", event => event.waitUntil(installBuild()));
self.addEventListener("activate", event => {
  // Browser lifecycle guarantees that the predecessor has no controlled pages.
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.delete(name)))));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!url.href.startsWith(scope)) return;
  // Preserve navigation query/hash state in the address bar, using the exact
  // cached document. No shell fallback for APIs, redirects or unknown paths.
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/index.html")) url.pathname = url.pathname.slice(0, -10);
  const entry = entries.get(url.href);
  if (!entry) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(url.href);
    // Serving the complete 200 response also safely ignores an optional Range
    // header for these static assets. Recordings/services are outside this map.
    if (cached) return cached;
    // Eviction must never turn a stable URL into another version's file.
    try {
      const response = await verifiedResponse(url.href, entry);
      await cache.put(url.href, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "OFFLINE_STATUS" || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map(request => request.url));
    event.ports[0].postMessage({
      version: OFFLINE_BUILD.version,
      ready: keys.has(completeUrl) && [...entries.keys()].every(url => keys.has(url)),
    });
  })());
});
