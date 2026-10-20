// @vitest-environment jsdom
import { webcrypto, createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  bundledFrequencySnapshot,
  matchingSharedFrequencies,
} from "./sharedFrequencyGuides";
import {
  fetchFrequencyCatalog,
  readSavedFrequencyCatalog,
  saveFrequencyCatalog,
  validateFrequencySnapshot,
  readFrequencySourceMode,
  saveFrequencySourceMode,
} from "./publicFrequencyCatalog";
let stored: Response | undefined;
const cache = {
  match: vi.fn(async () => stored?.clone()),
  put: vi.fn(async (_key: string, response: Response) => {
    stored = response.clone();
  }),
};
beforeEach(() => {
  stored = undefined;
  vi.stubGlobal("caches", { open: async () => cache });
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());
it("validates the complete generated Atlas snapshot and searches supplied publications", async () => {
  const snapshot = await validateFrequencySnapshot(bundledFrequencySnapshot);
  expect(snapshot.profiles).toHaveLength(1359);
  expect(matchingSharedFrequencies("zigbee", "auto", [])).toEqual([]);
  expect(
    matchingSharedFrequencies("zigbee", "auto", snapshot.profiles),
  ).toHaveLength(16);
});
it("fails closed on unknown fields, duplicate IDs, invalid facts and bad checksum", async () => {
  for (const mutate of [
    (x: typeof bundledFrequencySnapshot) => {
      Object.assign(x.profiles[0]!, { privateToken: "secret" });
    },
    (x: typeof bundledFrequencySnapshot) => {
      x.profiles.push(x.profiles[0]!);
    },
    (x: typeof bundledFrequencySnapshot) => {
      x.profiles[0]!.frequencyHz = NaN;
    },
    (x: typeof bundledFrequencySnapshot) => {
      x.profiles[0]!.url = "javascript:alert(1)";
    },
    (x: typeof bundledFrequencySnapshot) => {
      x.revision = "0".repeat(64);
    },
  ]) {
    const bad = structuredClone(bundledFrequencySnapshot);
    mutate(bad);
    await expect(validateFrequencySnapshot(bad)).rejects.toThrow();
  }
});
it("keeps the validated last good cache, conditional validation and source preference", async () => {
  const saved = {
    snapshot: await validateFrequencySnapshot(bundledFrequencySnapshot),
    checkedAt: null,
  };
  expect(await saveFrequencyCatalog(saved)).toBe(true);
  expect(await readSavedFrequencyCatalog()).toEqual(saved);
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 304 }),
  );
  const current = await fetchFrequencyCatalog(
    saved,
    new AbortController().signal,
    fetcher,
  );
  expect(current.snapshot).toEqual(saved.snapshot);
  expect(current.checkedAt).not.toBeNull();
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    credentials: "omit",
    redirect: "error",
    headers: { "If-None-Match": `"${saved.snapshot.revision}"` },
  });
  await expect(
    fetchFrequencyCatalog(saved, new AbortController().signal, async () =>
      Response.json({ ...saved.snapshot, profiles: [] }),
    ),
  ).rejects.toThrow();
  expect(await readSavedFrequencyCatalog()).toEqual(saved);
  for (const mode of ["live", "saved", "automatic"] as const) {
    saveFrequencySourceMode(mode);
    expect(readFrequencySourceMode()).toBe(mode);
  }
});
it("rejects HTML, oversized data and unavailable live responses without replacing saved state", async () => {
  for (const response of [
    new Response("<html/>", { headers: { "Content-Type": "text/html" } }),
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "9000000",
      },
    }),
    new Response(null, { status: 503 }),
  ])
    await expect(
      fetchFrequencyCatalog(
        null,
        new AbortController().signal,
        async () => response,
      ),
    ).rejects.toThrow();
});

it("storage quota failure retains the previous complete saved copy", async () => {
  const previous = {
    snapshot: await validateFrequencySnapshot(bundledFrequencySnapshot),
    checkedAt: null,
  };
  await saveFrequencyCatalog(previous);
  cache.put.mockRejectedValueOnce(
    new DOMException("Quota", "QuotaExceededError"),
  );
  expect(
    await saveFrequencyCatalog({
      ...previous,
      checkedAt: new Date().toISOString(),
    }),
  ).toBe(false);

  expect(await readSavedFrequencyCatalog()).toEqual(previous);
});
it("a valid empty publication replaces saved profiles after a withdrawal", async () => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("[]"),
  );
  const revision = [...new Uint8Array(hash)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const withdrawn = { ...bundledFrequencySnapshot, revision, profiles: [] };
  const result = await fetchFrequencyCatalog(
    null,
    new AbortController().signal,
    async () => Response.json(withdrawn),
  );
  expect(result.snapshot.profiles).toEqual([]);
  await saveFrequencyCatalog(result);
  expect((await readSavedFrequencyCatalog())?.snapshot.profiles).toEqual([]);
});

// Correct checksums must not make out-of-contract data acceptable.
it("rejects invalid source semantics even when the publication checksum is correct", async () => {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`
        : JSON.stringify(value);
  for (const fields of [
    { url: "http://example.com/source" },
    { url: "https://127.0.0.1/source" },
    { url: "https://catalog.internal/source" },
    { url: "https://user:password@example.com/source" },
    { url: "https://example.com/source?token=private" },
    { reviewedOn: "2026-02-31" },
    { name: "" },
    { regions: [] },
    { aliases: Array(51).fill("label") },
  ]) {
    const snapshot = structuredClone(bundledFrequencySnapshot);
    snapshot.profiles = [{ ...snapshot.profiles[0]!, ...fields }];
    snapshot.revision = createHash("sha256")
      .update(canonical(snapshot.profiles))
      .digest("hex");
    await expect(validateFrequencySnapshot(snapshot)).rejects.toThrow();
  }
});
