import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SITE = "https://tft-lab.com";
const PATCH = "17.4";
const SET = "17";
const OUT_DIR = path.resolve("data/core-patches/tft-lab/set17-17.4");

const LOCALES = [
  { id: "en", prefix: "/en", label: "English" },
  { id: "zh", prefix: "/zh", label: "简体中文" },
];

const HANDBOOK_SLUGS = [
  "season",
  "champions",
  "traits",
  "items",
  "augments",
  "gods",
  "encounters",
  "shop",
  "rounds",
  "gold",
  "xp",
  "damage",
  "hotkeys",
  "glossary",
];

const ROUTES = LOCALES.flatMap((locale) =>
  HANDBOOK_SLUGS.map((slug) => ({
    locale: locale.id,
    localeLabel: locale.label,
    slug,
    path: `${locale.prefix}/handbook/${slug}`,
    url: `${SITE}${locale.prefix}/handbook/${slug}`,
  })),
);

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return await res.text();
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html) {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "\n");
  const blockSpaced = withoutScripts
    .replace(/<\/(h[1-6]|p|div|section|article|header|footer|li|tr|table|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeHtmlEntities(blockSpaced)
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) return decodeHtmlEntities(titleMatch[1]).trim();
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return h1Match ? htmlToText(h1Match[1]) : "";
}

function extractScriptUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/gi)) {
    const src = decodeHtmlEntities(match[1]);
    if (src.startsWith("/_next/")) urls.add(`${SITE}${src}`);
  }
  return [...urls];
}

function extractCanonical(html) {
  const match = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  return match ? decodeHtmlEntities(match[1]) : "";
}

function extractEmbeddedFlight(html) {
  const pushes = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)) {
    pushes.push(match[1]);
  }
  return pushes;
}

function extractJsonLd(html) {
  const out = [];
  for (const match of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = decodeHtmlEntities(match[1]).trim();
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push({ raw });
    }
  }
  return out;
}

function extractHandbookLinks(html) {
  const links = new Set();
  for (const match of html.matchAll(/href="([^"]*\/handbook\/[^"]+)"/gi)) {
    links.add(decodeHtmlEntities(match[1]));
  }
  return [...links].sort();
}

function extractGlossaryTerms(text) {
  const terms = [];
  const termLine = /^([A-Za-z][A-Za-z0-9 /'().+-]{1,60})\s+(.{12,240})$/;
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    const match = trimmed.match(termLine);
    if (!match) continue;
    if (["TFT Lab", "Handbook", "Database", "Workbench"].includes(match[1])) continue;
    terms.push({ term: match[1], desc: match[2] });
  }
  return terms;
}

function extractSimpleNumbers(text) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) =>
    /(\bLevel\b|\bStage\b|\bXP\b|\bgold\b|\bInterest\b|\bdamage\b|\bPool\b|\bcost\b|金币|利息|经验|伤害|等级|阶段|概率|牌库)/i.test(
      line,
    ),
  );
}

async function downloadChunk(url, chunkDir) {
  const name = safeName(new URL(url).pathname.replace(/^\/+/, ""));
  const file = path.join(chunkDir, name);
  const text = await fetchText(url);
  await writeFile(file, text, "utf8");
  return {
    url,
    file,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
  };
}

async function main() {
  await ensureDir(OUT_DIR);
  const rawPagesDir = path.join(OUT_DIR, "raw", "pages");
  const rawFlightDir = path.join(OUT_DIR, "raw", "next-flight");
  const rawJsonLdDir = path.join(OUT_DIR, "raw", "jsonld");
  const rawChunksDir = path.join(OUT_DIR, "raw", "chunks");
  const textDir = path.join(OUT_DIR, "extracted", "text");
  const summariesDir = path.join(OUT_DIR, "extracted", "summaries");
  await Promise.all([
    ensureDir(rawPagesDir),
    ensureDir(rawFlightDir),
    ensureDir(rawJsonLdDir),
    ensureDir(rawChunksDir),
    ensureDir(textDir),
    ensureDir(summariesDir),
  ]);

  const pages = [];
  const chunkUrls = new Set();

  for (const route of ROUTES) {
    const html = await fetchText(route.url);
    const basename = `${route.locale}_${route.slug}`;
    const htmlFile = path.join(rawPagesDir, `${basename}.html`);
    const textFile = path.join(textDir, `${basename}.txt`);
    const flightFile = path.join(rawFlightDir, `${basename}.json`);
    const jsonLdFile = path.join(rawJsonLdDir, `${basename}.json`);
    const summaryFile = path.join(summariesDir, `${basename}.json`);

    const text = htmlToText(html);
    const flight = extractEmbeddedFlight(html);
    const jsonLd = extractJsonLd(html);
    const scripts = extractScriptUrls(html);
    scripts.forEach((url) => chunkUrls.add(url));

    const summary = {
      ...route,
      title: extractTitle(html),
      canonical: extractCanonical(html),
      htmlBytes: Buffer.byteLength(html, "utf8"),
      htmlSha256: sha256(html),
      textBytes: Buffer.byteLength(text, "utf8"),
      nextScriptCount: scripts.length,
      nextFlightPushCount: flight.length,
      handbookLinks: extractHandbookLinks(html),
      keywordLines: extractSimpleNumbers(text),
      glossaryCandidateTerms: route.slug === "glossary" ? extractGlossaryTerms(text) : [],
    };

    await writeFile(htmlFile, html, "utf8");
    await writeFile(textFile, text, "utf8");
    await writeFile(flightFile, JSON.stringify(flight, null, 2), "utf8");
    await writeFile(jsonLdFile, JSON.stringify(jsonLd, null, 2), "utf8");
    await writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");

    pages.push({ ...summary, files: { html: htmlFile, text: textFile, flight: flightFile, jsonLd: jsonLdFile } });
    console.log(`saved ${route.locale}/${route.slug}`);
  }

  const chunks = [];
  for (const url of [...chunkUrls].sort()) {
    try {
      chunks.push(await downloadChunk(url, rawChunksDir));
      console.log(`chunk ${url}`);
    } catch (error) {
      chunks.push({ url, error: error.message });
    }
  }

  const manifest = {
    source: {
      site: SITE,
      handbook: `${SITE}/en/handbook`,
      set: SET,
      patch: PATCH,
      fetchedAt: new Date().toISOString(),
    },
    policy: {
      role: "TFT Lab reference package for system rules, terms, encounters, gods, and validation only.",
      doesNotOverride: "JCC official champion/entity stats already captured under data/core-patches/jcc.",
    },
    routes: ROUTES,
    pages,
    chunks,
  };

  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`manifest ${path.join(OUT_DIR, "manifest.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
