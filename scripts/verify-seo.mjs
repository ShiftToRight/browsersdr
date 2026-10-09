// Verify actual built/served documents, independently of their template markup.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { SEO_ORIGIN, SEO_ROUTES } from "./seo-site.mjs";

const legalDocuments = new Set(["/LICENSE.txt", "/NOTICE.txt", "/THIRD_PARTY_NOTICES.txt"]);

function validateDocuments(documents) {
  const sitemap = new JSDOM(documents.get("/sitemap.xml"), { contentType: "application/xml" }).window.document;
  assert.equal(sitemap.documentElement.namespaceURI, "http://www.sitemaps.org/schemas/sitemap/0.9", "Sitemap namespace");
  assert.deepEqual([...sitemap.querySelectorAll("loc")].map((node) => node.textContent), SEO_ROUTES.map((path) => `${SEO_ORIGIN}${path}`), "Sitemap contains exactly the public canonical pages");
  const robots = documents.get("/robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/browsersdr\.com\/sitemap\.xml$/m);
  assert.ok(!/^Disallow:\s*\/(?:\s*$|assets|guides|getting-started|supported-devices|about)/m.test(robots), "Public pages and rendering assets must be crawlable");

  const titles = new Set();
  const descriptions = new Set();
  const parsed = new Map();
  for (const path of SEO_ROUTES) {
    const document = new JSDOM(documents.get(path), { url: `${SEO_ORIGIN}${path}` }).window.document;
    parsed.set(path, document);
    const title = document.querySelector("title")?.textContent;
    const description = document.querySelector('meta[name="description"]')?.getAttribute("content");
    assert.ok(title?.includes("BrowserSDR") && title.length > 20, `${path}: descriptive title`);
    assert.ok(description?.length >= 80, `${path}: descriptive snippet`);
    assert.ok(!titles.has(title), `${path}: unique title`);
    assert.ok(!descriptions.has(description), `${path}: unique description`);
    titles.add(title);
    descriptions.add(description);
    assert.equal(document.documentElement.lang, "en", `${path}: language`);
    assert.equal(document.querySelectorAll('link[rel="canonical"]').length, 1, `${path}: one canonical`);
    assert.equal(document.querySelector('link[rel="canonical"]').href, `${SEO_ORIGIN}${path}`, `${path}: canonical URL`);
    assert.ok(!/noindex/i.test(document.querySelector('meta[name="robots"]')?.content ?? ""), `${path}: indexable`);
    for (const property of ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:alt"]) {
      assert.ok(document.querySelector(`meta[property="${property}"]`)?.content, `${path}: ${property}`);
    }
    assert.equal(document.querySelector('meta[property="og:url"]').content, `${SEO_ORIGIN}${path}`);
    assert.equal(document.querySelector('meta[name="twitter:card"]')?.content, "summary");
    const socialImage = new URL(document.querySelector('meta[property="og:image"]').content);
    assert.equal(socialImage.origin, SEO_ORIGIN);
    if (path !== "/") {
      assert.equal(document.querySelectorAll("h1").length, 1, `${path}: one primary heading`);
      assert.ok(document.querySelector("article")?.textContent.split(/\s+/).length >= 180, `${path}: useful HTML content without JavaScript`);
      assert.equal(document.querySelectorAll("script").length, 0, `${path}: guide does not load the radio application`);
      assert.equal(document.querySelectorAll('nav a[aria-current="page"]').length, 1);
      assert.ok(document.querySelector('a[href="/"]'), `${path}: receiver entry link`);
    }
  }

  const assets = new Set();
  for (const [path, document] of parsed) {
    for (const node of document.querySelectorAll("a[href], link[href], img[src], meta[property='og:image'], meta[name='twitter:image']")) {
      const raw = node.getAttribute("href") ?? node.getAttribute("src") ?? node.getAttribute("content");
      const url = new URL(raw, `${SEO_ORIGIN}${path}`);
      if (url.origin !== SEO_ORIGIN) continue;
      if (node.tagName === "A") {
        if (legalDocuments.has(url.pathname)) {
          assert.ok(!url.hash, `${path}: legal document has no HTML fragment`);
          assets.add(url.pathname);
          continue;
        }
        assert.ok(SEO_ROUTES.includes(url.pathname), `${path}: unknown internal page ${url.pathname}`);
        if (url.hash) assert.ok(parsed.get(url.pathname).getElementById(decodeURIComponent(url.hash.slice(1))), `${path}: broken fragment ${url.href}`);
      } else if (!SEO_ROUTES.includes(url.pathname)) {
        assets.add(url.pathname);
      }
    }
  }
  return assets;
}

export async function verifySeoDirectory(directory) {
  const documents = new Map();
  for (const path of [...SEO_ROUTES, "/sitemap.xml", "/robots.txt"]) {
    const file = path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
    documents.set(path, await readFile(join(directory, file), "utf8"));
  }
  for (const path of validateDocuments(documents)) {
    assert.ok((await readFile(join(directory, path.slice(1)))).length > 0, `${path}: referenced asset exists`);
  }
  return SEO_ROUTES.length;
}

export async function verifySeoOrigin(origin, { production = false } = {}) {
  const documents = new Map();
  for (const path of [...SEO_ROUTES, "/sitemap.xml", "/robots.txt"]) {
    const response = await fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${path}: direct HTTP 200`);
    const expectedType = path.endsWith(".xml") ? /(?:application|text)\/xml/ : path.endsWith(".txt") ? /text\/plain/ : /text\/html/;
    assert.match(response.headers.get("content-type") ?? "", expectedType, `${path}: content type`);
    assert.ok(!/noindex/i.test(response.headers.get("x-robots-tag") ?? ""), `${path}: indexable response header`);
    if (production) assert.match(response.headers.get("cache-control") ?? "", /no-cache/, `${path}: document revalidation`);
    documents.set(path, await response.text());
  }
  for (const path of validateDocuments(documents)) {
    const response = await fetch(new URL(path, origin), { method: "HEAD", signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${path}: linked asset HTTP status`);
  }
  if (production) {
    assert.equal(new URL(origin).origin, SEO_ORIGIN, "Production origin");
    const query = "?seo_redirect_probe=1&value=a%2Fb";
    for (const source of ["http://browsersdr.com", "http://www.browsersdr.com", "https://www.browsersdr.com"]) {
      for (const path of ["/", "/guides/rtl-sdr/"]) {
        const response = await fetch(`${source}${path}${query}`, { redirect: "manual", signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 308, `${source}${path}: method-preserving permanent redirect`);
        assert.equal(response.headers.get("location"), `${SEO_ORIGIN}${path}${query}`, "Redirect preserves path and query");
      }
    }
    for (const path of SEO_ROUTES) {
      const response = await fetch(`${SEO_ORIGIN}${path}index.html${query}`, { redirect: "manual", signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 308, `${path}index.html: alias redirect`);
      assert.equal(response.headers.get("location"), `${SEO_ORIGIN}${path}${query}`);
      if (path !== "/") {
        const directory = await fetch(`${SEO_ORIGIN}${path.slice(0, -1)}${query}`, { redirect: "manual", signal: AbortSignal.timeout(30000) });
        assert.ok([301, 308].includes(directory.status), `${path}: directory slash redirect`);
        assert.equal(directory.headers.get("location"), `${SEO_ORIGIN}${path}${query}`);
      }
    }
    const missing = await fetch(`${SEO_ORIGIN}/seo-verification-missing-page`, { signal: AbortSignal.timeout(30000) });
    assert.equal(missing.status, 404, "Missing page is a genuine 404");
  }
  return SEO_ROUTES.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node scripts/verify-seo.mjs DIST_DIRECTORY | ORIGIN [--production]");
  const count = /^https?:/.test(target)
    ? await verifySeoOrigin(target, { production: process.argv.includes("--production") })
    : await verifySeoDirectory(resolve(target));
  console.log(`SEO verified: ${count} canonical pages, raw HTML content, unique metadata, social previews, navigation, assets, sitemap and robots.txt${process.argv.includes("--production") ? "; permanent redirects and genuine 404" : ""}.`);
}
