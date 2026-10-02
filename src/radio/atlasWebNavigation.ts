const ATLAS_PAGE_HASH = /^#\/(recordings|runs)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BROWSER_SDR_ORIGINS = new Set([
  "https://browsersdr.com",
  "https://www.browsersdr.com",
]);

/** API requests remain same-origin; production library pages live on Atlas. */
export function atlasWebPageUrl(
  path: string | undefined,
  browserOrigin = location.origin,
): string | undefined {
  if (!path) return undefined;
  let page: URL;
  try {
    page = new URL(path, browserOrigin);
  } catch {
    return undefined;
  }
  if (
    page.origin !== browserOrigin || page.pathname !== "/" || page.search ||
    !ATLAS_PAGE_HASH.test(page.hash)
  ) return undefined;
  return BROWSER_SDR_ORIGINS.has(browserOrigin)
    ? `https://sigintatlas.com/${page.hash}`
    : path;
}

/** Older open BrowserSDR pages still generate /#/recordings and /#/runs links. */
export function legacyAtlasPageRedirect(
  browserLocation: Pick<Location, "origin" | "pathname" | "search" | "hash">,
): string | undefined {
  if (!BROWSER_SDR_ORIGINS.has(browserLocation.origin)) return undefined;
  return atlasWebPageUrl(
    `${browserLocation.pathname}${browserLocation.search}${browserLocation.hash}`,
    browserLocation.origin,
  );
}
