import { afterEach, describe, expect, it } from "vitest";
import fixture from "../testing/fixtures/atlas/browsersdr-station-search-v1.json";
import { AtlasClient } from "./atlasClient";
import { AtlasConnection } from "./atlasConnection";
import { AtlasCredentialStore } from "./atlasCredentials";
import {
  AtlasStationSearch,
  ATLAS_STATION_MAX_PAGES,
} from "./atlasStationSearch";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
});
function peer(
  stations: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const calls: string[] = [];
  const credentials = new AtlasCredentialStore(null);
  credentials.save("invented-search-test-credential-".repeat(2), false);
  const connection = new AtlasConnection(
    credentials,
    new AtlasClient({
      fetch: async (input, init) => {
        const path = String(input);
        calls.push(path);
        if (path.endsWith("/session"))
          return Response.json({
            operator_id: "viewer",
            expires_at: "2030-01-01T00:00:00Z",
            csrf_token: "csrf",
          });
        if (path.endsWith("/me"))
          return Response.json({ ...fixture.viewer, id: "viewer" });
        return stations(path, init);
      },
    }),
  );
  const search = new AtlasStationSearch(connection);
  const stop = search.observe();
  cleanups.push(() => {
    stop();
    connection.dispose();
    credentials.dispose();
  });
  return { search, connection, credentials, calls };
}
describe("bounded station search session ownership", () => {
  it("does no work on creation; reads as a viewer without IQ capabilities", async () => {
    const p = peer(async () => Response.json(fixture.pages.first));
    expect(p.calls).toEqual([]);
    await p.search.search({ q: "Example" });
    expect(p.search.getSnapshot().status).toBe("ready");
    expect(p.calls).toHaveLength(3);
    expect(p.calls.some((c) => c.includes("capabilities"))).toBe(false);
    expect(p.connection.getSnapshot().user?.role).toBe("viewer");
  });
  it("replaces pages, retains bounded opaque previous cursors and resets on filter edit", async () => {
    const p = peer(async (path) =>
      Response.json(
        path.includes("cursor=") ? fixture.pages.last : fixture.pages.first,
      ),
    );
    await p.search.search({ min_frequency_hz: 99e6, max_frequency_hz: 101e6 });
    await p.search.next();
    expect(p.search.getSnapshot()).toMatchObject({
      pageIndex: 1,
      previous: true,
      next: false,
    });
    expect(p.search.getSnapshot().page?.items).toHaveLength(1);
    await p.search.previous();
    expect(p.search.getSnapshot().pageIndex).toBe(0);
    p.search.clear();
    expect(p.search.getSnapshot().page).toBeUndefined();
    await p.search.search({ q: "Changed" });
    expect(p.calls.at(-1)).toBe("/api/v1/stations?limit=50&q=Changed");
  });
  it("cancels prior work and suppresses out-of-order responses even if fetch ignores abort", async () => {
    const first = deferred<Response>();
    let signal: AbortSignal | undefined;
    const p = peer(async (path, init) => {
      if (path.includes("q=first")) {
        signal = init?.signal as AbortSignal;
        return first.promise;
      }
      return Response.json(fixture.pages.last);
    });
    await p.connection.ensureAuthenticated();
    const old = p.search.search({ q: "first" });
    await Promise.resolve();
    await Promise.resolve();
    await p.search.search({ q: "second" });
    expect(signal?.aborted).toBe(true);
    first.resolve(Response.json(fixture.pages.first));
    await old;
    expect(p.search.getSnapshot().page?.items[0]?.name).toBe(
      "Example without references",
    );
  });
  it("clears user-specific results and late reads on credential replacement or disconnect", async () => {
    const p = peer(async () => Response.json(fixture.pages.first));
    await p.search.search({});
    p.credentials.save("changed-test-credential-".repeat(2), false);
    expect(p.search.getSnapshot().page).toBeUndefined();
    await p.search.search({});
    await p.connection.disconnect();
    expect(p.search.getSnapshot().page).toBeUndefined();
  });
  it("coordinates exactly one read reauthentication after 401", async () => {
    let reads = 0;
    const p = peer(async () =>
      ++reads === 1
        ? Response.json(
            { error: { code: "invalid_authentication", message: "Expired" } },
            { status: 401 },
          )
        : Response.json(fixture.pages.first),
    );
    await p.search.search({});
    expect(p.search.getSnapshot().status).toBe("ready");
    expect(p.calls.filter((c) => c.endsWith("/session"))).toHaveLength(2);
  });
  it.each([
    [401, "rejected"],
    [403, "denied"],
    [503, "unavailable"],
    [404, "unavailable"],
    [422, "rejected"],
  ])("shows bounded %s errors and does not poll", async (status, phrase) => {
    const p = peer(async () =>
      Response.json(
        { error: { code: "test_error", message: "private server detail" } },
        { status },
      ),
    );
    await p.search.search({});
    expect(p.search.getSnapshot().message).toContain(phrase);
    expect(p.search.getSnapshot().message).not.toContain(
      "private server detail",
    );
    expect(p.calls.filter((c) => c.endsWith("/session"))).toHaveLength(
      status === 401 ? 2 : 1,
    );
  });
  it("shows missing token, empty and network failure distinctly", async () => {
    const p = peer(async () => {
      throw new TypeError("offline");
    });
    await p.search.search({});
    expect(p.search.getSnapshot().message).toContain("network");
    p.credentials.forget();
    await p.search.search({});
    expect(p.search.getSnapshot().message).toContain("Configure");
    const empty = peer(async () =>
      Response.json({ items: [], next_cursor: null }),
    );
    await empty.search.search({});
    expect(empty.search.getSnapshot().page?.items).toEqual([]);
  });
  it("bounds cursors and detects a repeated cursor without accumulating rows", async () => {
    let n = 0;
    const p = peer(async () =>
      Response.json({ ...fixture.pages.first, next_cursor: String(++n) }),
    );
    await p.search.search({});
    for (let i = 1; i < ATLAS_STATION_MAX_PAGES; i++) await p.search.next();
    expect(p.search.getSnapshot()).toMatchObject({
      pageIndex: 19,
      next: false,
    });
    expect(p.search.getSnapshot().message).toContain("Page limit");
    const repeated = peer(async () => Response.json(fixture.pages.first));
    await repeated.search.search({});
    await repeated.search.next();
    expect(repeated.search.getSnapshot().message).toContain("repeated");
  });
  it("shares an upload session and never rotates it after a read 401 while the transfer owns it", async () => {
    let failed = false;
    const p = peer(async () =>
      failed
        ? Response.json(
            { error: { code: "expired", message: "expired" } },
            { status: 401 },
          )
        : Response.json(fixture.pages.first),
    );
    await p.connection.ensureAuthenticated();
    const transfer = deferred<void>();
    const upload = p.connection.withTransfer(
      p.credentials.getSnapshot().token,
      () => transfer.promise,
      new AbortController().signal,
    );
    await p.search.search({});
    expect(p.search.getSnapshot().status).toBe("ready");
    failed = true;
    await p.search.search({});
    expect(p.search.getSnapshot().status).toBe("error");
    expect(p.calls.filter((c) => c.endsWith("/session"))).toHaveLength(1);
    await p.search.search({});
    expect(p.search.getSnapshot().message).toContain("transfer");
    transfer.resolve();
    await upload;
  });
});
