import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeAugmentText(text) {
  return String(text || "")
    .replace(/[ⅠⅡⅢ]/g, "")
    .replace(/\bI{1,3}\b/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function looksLikeAugmentName(text) {
  if (!text) return false;
  if (text.length < 2 || text.length > 12) return false;
  if (/[0-9]|[A-Za-z]|。|，|,|\.|：|:|！|!|？|\?|、|\[|\]|【|】|\(|\)/.test(text)) return false;
  return /[\u4e00-\u9fff]/.test(text);
}

function matchAugmentCatalog(text, catalog) {
  const normalized = normalizeAugmentText(text);
  const exact = catalog.byExact.get(normalized);
  if (exact?.length) return { kind: "exact", matches: exact };
  const prefix = catalog.entries.filter((entry) => entry.normalized_name.startsWith(normalized));
  if (prefix.length) return { kind: "prefix", matches: prefix };
  return { kind: "none", matches: [] };
}

function verifiedAugmentCandidate(text, catalog) {
  const catalogMatch = matchAugmentCatalog(text, catalog);
  if (catalogMatch.kind === "none" && !looksLikeAugmentName(text)) return null;
  if (catalogMatch.kind === "none") return null;
  return {
    text,
    normalized_text: normalizeAugmentText(text),
    match_kind: catalogMatch.kind,
    matches: catalogMatch.matches.slice(0, 8).map((entry) => ({
      id: entry.id,
      name: entry.name,
    })),
    confidence: catalogMatch.kind === "exact" ? 0.9 : 0.78,
  };
}

async function loadCatalog(file) {
  const overlay = JSON.parse(await readFile(file, "utf8"));
  const entries = Object.values(overlay?.augments_by_id || {})
    .map((entry) => ({
      id: entry?.id ?? null,
      name: entry?.name || "",
      normalized_name: normalizeAugmentText(entry?.name || ""),
      raw: entry,
    }))
    .filter((entry) => entry.name);
  const byExact = new Map();
  for (const entry of entries) {
    const bucket = byExact.get(entry.normalized_name) || [];
    bucket.push(entry);
    byExact.set(entry.normalized_name, bucket);
  }
  return { byExact, entries };
}

async function main() {
  const catalog = await loadCatalog("data/runtime/jcc/mumu-catalog-overlay.json");
  const alphaNumericNames = catalog.entries
    .map((entry) => entry.name)
    .filter((name) => /[0-9A-Za-z]/.test(name));
  assert(alphaNumericNames.length > 0, "fixture catalog should include alphanumeric augment names");

  const misses = alphaNumericNames.filter((name) => !verifiedAugmentCandidate(name, catalog));
  assert(misses.length === 0, `catalog-backed alphanumeric augment names must verify: ${misses.join(", ")}`);
  assert(!verifiedAugmentCandidate("人呜哈哈", catalog), "non-catalog player nickname text must not verify as augment");
  assert(!verifiedAugmentCandidate("2-1", catalog), "round labels must not verify as augment");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "catalog exact match is evaluated before the coarse no-A-Z/no-digit OCR text filter",
      "all current-season alphanumeric augment names verify through catalog",
      "player nickname text still does not verify without catalog match",
      "round labels still do not verify without catalog match",
    ],
    alphanumeric_augment_count: alphaNumericNames.length,
    examples: alphaNumericNames.sort((left, right) => left.localeCompare(right, "zh-Hans-CN")).slice(0, 24),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
