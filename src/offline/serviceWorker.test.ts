import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { writeOfflineWorker } from "../../scripts/offline-build.mjs";

const scope = "https://radio.example/app/";
const prefix = `browsersdr-offline:${scope}:`;
type Store = Map<string, Map<string, Response>>;

async function worker(files: Record<string, string>, version = "a", store: Store = new Map()) {
  const handlers = new Map<string, (event: unknown) => void>();
  const network = { ...files };
  const fetcher = vi.fn((url: string) => {
    let name = url.slice(scope.length);
    if (!name || name.endsWith("/")) name += "index.html";
    return Promise.resolve(network[name] === undefined ? new Response("missing", { status: 404 }) : new Response(network[name]));
  });
  const cacheStorage = {
    keys: () => Promise.resolve([...store.keys()]),
    delete: (name: string) => Promise.resolve(store.delete(name)),
    open: (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name)!;
      return Promise.resolve({
        put: (url: string, response: Response) => { cache.set(url, response.clone()); return Promise.resolve(); },
        match: (url: string) => Promise.resolve(cache.get(url)?.clone()),
        keys: () => Promise.resolve([...cache.keys()].map(url => new Request(url))),
      });
    },
  };
  const skipWaiting = vi.fn(), claim = vi.fn();
  const context = createContext({
    self: { registration: { scope }, addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler), skipWaiting, clients: { claim } },
    OFFLINE_BUILD: { version, entries: Object.entries(files).map(([url, bytes]) => ({ url: url.endsWith("index.html") ? url.slice(0, -10) : url, size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") })) },
    caches: cacheStorage, fetch: fetcher, URL, Response, Request, crypto: webcrypto, Uint8Array,
  });
  runInContext(await readFile(new URL("./service-worker.js", import.meta.url), "utf8"), context);
  const lifetime = async (type: string) => {
    let promise: Promise<unknown> | undefined;
    handlers.get(type)!({ waitUntil: (task: Promise<unknown>) => { promise = task; } });
    await promise;
  };
  const request = (url: string, options: RequestInit = {}, mode?: string) => {
    let response: Promise<Response> | undefined;
    const request = new Request(new URL(url, scope), options);
    if (mode) Object.defineProperty(request, "mode", { value: mode });
    handlers.get("fetch")!({ request, respondWith: (task: Promise<Response>) => { response = task; } });
    return response;
  };
  const status = async () => {
    let result: { ready: boolean; version: string } | undefined;
    let task: Promise<unknown> | undefined;
    handlers.get("message")!({ data: { type: "OFFLINE_STATUS" }, ports: [{ postMessage: (value: typeof result) => { result = value; } }], waitUntil: (promise: Promise<unknown>) => { task = promise; } });
    await task;
    return result;
  };
  return { lifetime, request, status, store, network, fetcher, skipWaiting, claim };
}

describe("offline build and worker", () => {
  it("creates deterministic complete manifests and excludes mutable site metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browsersdr-offline-manifest-"));
    try {
      for (const [name, data] of Object.entries({ "index.html": "app", "lazy.js": "decoder", "visitor-count.json": "live", "release.json": "operator", "debug.js.map": "source" })) await writeFile(join(directory, name), data);
      const a = await writeOfflineWorker(directory);
      expect(a.entries.map(entry => entry.url)).toEqual(["", "lazy.js"]);
      expect(await writeOfflineWorker(directory)).toEqual(a);
      await writeFile(join(directory, "lazy.js"), "updated decoder");
      expect((await writeOfflineWorker(directory)).version).not.toBe(a.version);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("installs complete verified versions including lazy assets and preserves deep-link queries", async () => {
    const w = await worker({ "index.html": "old document", "assets/lazy.js": "old decoder", "guide/index.html": "guide" });
    await w.lifetime("install");
    expect(await w.status()).toEqual({ ready: true, version: "a" });
    expect(await (await w.request("?settings=keep", {}, "navigate"))!.text()).toBe("old document");
    expect(await (await w.request("guide/", {}, "navigate"))!.text()).toBe("guide");
    expect(await (await w.request("assets/lazy.js"))!.text()).toBe("old decoder");
    expect(w.fetcher).toHaveBeenCalledTimes(3);
    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.claim).not.toHaveBeenCalled();
  });

  it("rejects a changed deployment or failed download without damaging the active cache", async () => {
    const a = await worker({ "index.html": "old" });
    await a.lifetime("install");
    const b = await worker({ "index.html": "new" }, "b", a.store);
    b.network["index.html"] = "bad";
    await expect(b.lifetime("install")).rejects.toThrow("version mismatch");
    expect(a.store.has(prefix + "b")).toBe(false);
    expect(await a.status()).toEqual({ ready: true, version: "a" });
    b.fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(b.lifetime("install")).rejects.toThrow("offline");
    expect(a.store.has(prefix + "a")).toBe(true);
  });

  it("reuses previous files only after checking their hashes against the new version", async () => {
    const a = await worker({ "index.html": "old", "assets/lazy.js": "same" });
    await a.lifetime("install");
    const b = await worker({ "index.html": "new", "assets/lazy.js": "same" }, "b", a.store);
    await b.lifetime("install");
    expect(b.fetcher).toHaveBeenCalledTimes(1);
    expect(b.fetcher.mock.calls[0]![0]).toBe(scope);
    expect(await b.status()).toEqual({ ready: true, version: "b" });
    expect(await (await a.request("index.html"))!.text()).toBe("old");
  });

  it("never substitutes new bytes for evicted old files, and reports incomplete storage", async () => {
    const w = await worker({ "index.html": "old", "assets/lazy.js": "v1" });
    await w.lifetime("install");
    w.network["assets/lazy.js"] = "v2";
    expect(await (await w.request("assets/lazy.js"))!.text()).toBe("v1");
    w.store.get(prefix + "a")!.delete(scope + "assets/lazy.js");
    expect((await w.status())!.ready).toBe(false);
    expect((await w.request("assets/lazy.js"))!.type).toBe("error");
    expect(w.store.get(prefix + "a")!.has(scope + "assets/lazy.js")).toBe(false);
    w.network["assets/lazy.js"] = "v1";
    expect(await (await w.request("assets/lazy.js"))!.text()).toBe("v1");
    expect((await w.status())!.ready).toBe(true);
  });

  it("leaves APIs, external services, recording ranges and mutable metadata on the network", async () => {
    const w = await worker({ "index.html": "app", "assets/lazy.js": "decoder" });
    for (const url of ["api/v1/sharing", "release.json", "visitor-count.json", "https://atlas.example/search", "missing.html"]) expect(w.request(url)).toBeUndefined();
    expect(w.request("capture.sigmf-data", { headers: { Range: "bytes=0-1" } })).toBeUndefined();
    expect(w.request("index.html", { method: "POST" })).toBeUndefined();
    expect(w.fetcher).not.toHaveBeenCalled();
    await w.lifetime("install");
    expect(await (await w.request("assets/lazy.js", { headers: { Range: "bytes=0-1" } }))!.text()).toBe("decoder");
  });

  it("only prunes its own obsolete build caches on activation", async () => {
    const w = await worker({ "index.html": "new" }, "b");
    await w.lifetime("install");
    for (const name of [prefix + "a", "other-app", "browsersdr-offline:https://radio.example/other/:a"]) w.store.set(name, new Map());
    await w.lifetime("activate");
    expect([...w.store.keys()]).toEqual([prefix + "b", "other-app", "browsersdr-offline:https://radio.example/other/:a"]);
    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.claim).not.toHaveBeenCalled();
  });
});
