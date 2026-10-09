import { describe, expect, it } from "vitest";
import {
  createRemoteShareUrl,
  exportRemotePresets,
  hasRemoteShare,
  importRemotePresets,
  mergeRemotePresets,
  readRemoteShare,
  validateRemotePreset,
  type RemotePreset,
} from "./remotePresets";
const item: RemotePreset = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test channel",
  notes: "private note",
  kind: "openwebrx",
  address: "https://receiver.example/base",
  profile: "radio|hf",
  tune: {
    frequency: 7_100_000,
    mode: "usb",
    lowCut: 300,
    highCut: 3000,
    squelch: -150,
  },
};
describe("remote preset provenance and bounded backup", () => {
  it("normalizes public installation addresses and drops unrelated credentials/recording fields", () => {
    const saved = validateRemotePreset({
      ...item,
      token: "secret",
      rawIq: true,
      tune: { ...item.tune, password: "secret" },
    });
    expect(saved.address).toBe("https://receiver.example/base/");
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect(saved.tune).toEqual(item.tune);
    expect(importRemotePresets(exportRemotePresets([saved]))).toEqual([saved]);
  });
  it.each([
    "javascript:alert(1)",
    "https://user:password@receiver.example/",
    "https://receiver.example/?token=secret",
    "https://receiver.example/#password",
  ])("rejects nonportable receiver addresses: %s", (address) => {
    expect(() => validateRemotePreset({ ...item, address })).toThrow();
  });
  it("keeps HTTP storage portable but validates technology-specific modes/bands/zoom", () => {
    expect(
      validateRemotePreset({ ...item, address: "http://receiver.example/" })
        .address,
    ).toMatch(/^http:/);
    expect(() => validateRemotePreset({ ...item, kind: "kiwi" })).toThrow(
      /band/,
    );
    expect(() =>
      validateRemotePreset({
        ...item,
        kind: "kiwi",
        profile: undefined,
        tune: { ...item.tune, mode: "wfm" },
      }),
    ).toThrow(/mode/);
    expect(() =>
      validateRemotePreset({
        ...item,
        kind: "kiwi",
        profile: undefined,
        zoom: 15,
      }),
    ).toThrow(/zoom/);
    expect(() =>
      validateRemotePreset({ ...item, tune: { ...item.tune, frequency: NaN } }),
    ).toThrow();
    expect(() =>
      validateRemotePreset({ ...item, tune: { ...item.tune, lowCut: 4000 } }),
    ).toThrow();
  });
  it("rejects malformed/oversized/duplicate/versioned backups without partial entries", () => {
    expect(() => importRemotePresets('{"schema":"future","items":[]}')).toThrow(
      /version/,
    );
    expect(() => importRemotePresets("x".repeat(256 * 1024 + 1))).toThrow(
      /256/,
    );
    expect(() => exportRemotePresets([item, item])).toThrow(/Duplicate/);
    expect(() =>
      exportRemotePresets(Array.from({ length: 101 }, () => item)),
    ).toThrow(/100/);
    expect(() => exportRemotePresets([{ ...item, name: "" }])).toThrow();
  });
  it("merges backups with existing IDs retained and all new entries validated", () => {
    const other = {
      ...item,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Second receiver",
      tune: undefined,
      profile: undefined,
    };
    expect(
      mergeRemotePresets([item], [{ ...item, name: "Replacement" }, other]).map(
        (value) => value.name,
      ),
    ).toEqual(["Test channel", "Second receiver"]);
  });
});
describe("remote links stage only receiver/tuning settings", () => {
  it("round-trips separate provenance without forwarding collection data or application credentials", () => {
    const url = new URL(
      createRemoteShareUrl(
        "https://user:password@app.example/path/?token=secret#settings=old",
        item,
      ),
    );
    expect(url.pathname).toBe("/path/");
    expect(url.search).toBe("");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    const shared = readRemoteShare(url.hash).preset!;
    expect(shared.tune).toEqual(item.tune);
    expect(shared.address).toBe("https://receiver.example/base/");
    expect(shared.profile).toBe(item.profile);
    expect(shared.notes).toBe("");
    expect(shared.name).toBe("Shared remote preset");
    expect(shared.id).not.toBe(item.id);
    expect(hasRemoteShare(url.hash)).toBe(true);
  });
  it("round-trips receiver-only and Kiwi channel/zoom presets", () => {
    const kiwi = {
      ...item,
      kind: "kiwi" as const,
      profile: undefined,
      zoom: 8,
    };
    expect(
      readRemoteShare(
        new URL(createRemoteShareUrl("http://localhost/", kiwi)).hash,
      ).preset?.zoom,
    ).toBe(8);
    expect(
      readRemoteShare(
        new URL(
          createRemoteShareUrl("https://app.example/", {
            ...item,
            tune: undefined,
            profile: undefined,
          }),
        ).hash,
      ).preset?.tune,
    ).toBeUndefined();
  });
  it("rejects ambiguous, malformed and unknown-version incoming links", () => {
    const hash = new URL(createRemoteShareUrl("https://app.example/", item))
      .hash;
    expect(readRemoteShare(hash + "&remote=more").error).toBeTruthy();
    expect(readRemoteShare(hash + "&settings=more").error).toBeTruthy();
    expect(readRemoteShare("#remote=" + "a".repeat(8192)).error).toMatch(
      /large/,
    );
    expect(readRemoteShare("#remote=!").error).toBeTruthy();
    expect(
      readRemoteShare(
        "#remote=" +
          btoa(JSON.stringify({ schema: "future" })).replace(/=+$/, ""),
      ).error,
    ).toMatch(/version/);
    expect(readRemoteShare("#settings=existing")).toEqual({});
  });
});
