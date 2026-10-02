import { describe, expect, it } from "vitest";
import { atlasWebPageUrl, legacyAtlasPageRedirect } from "./atlasWebNavigation";

const recording = "/#/recordings/bcc67013-07f8-4c56-a58f-e83e50a4e2be";
const run = "/#/runs/50000000-0000-4000-8000-000000000001";

describe("Atlas web navigation alongside the BrowserSDR API proxy", () => {
  it.each(["https://browsersdr.com", "https://www.browsersdr.com"])(
    "opens saved recordings and runs on the canonical Atlas site from %s",
    origin => {
      expect(atlasWebPageUrl(recording, origin)).toBe(`https://sigintatlas.com${recording}`);
      expect(atlasWebPageUrl(run, origin)).toBe(`https://sigintatlas.com${run}`);
      expect(legacyAtlasPageRedirect(new URL(recording, origin))).toBe(`https://sigintatlas.com${recording}`);
    },
  );
  it.each(["http://localhost:5173", "https://sigintatlas.com"])(
    "retains same-origin links and receiver entry behavior on %s",
    origin => {
      expect(atlasWebPageUrl(recording, origin)).toBe(recording);
      expect(legacyAtlasPageRedirect(new URL(recording, origin))).toBeUndefined();
    },
  );
  it.each([
    "https://untrusted.invalid" + recording,
    "//untrusted.invalid" + recording,
    "javascript:alert(1)",
    "/?token=private" + recording.slice(1),
    "/other" + recording.slice(1),
    "/#/recordings/not-an-id",
    "/#/settings/users",
    "/",
  ])("never redirects unrelated routes or untrusted links: %s", path => {
    expect(atlasWebPageUrl(path, "https://browsersdr.com")).toBeUndefined();
    expect(legacyAtlasPageRedirect(new URL(path, "https://browsersdr.com"))).toBeUndefined();
  });
});
