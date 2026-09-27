import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeMumuHeroId } from "./jcc-mumu-hero-id.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");

const SOURCE_FIELDS = Object.freeze({
  4352: "wl",
  4353: "hl",
  4354: "bl",
});
const ACCEPTANCE_RULES = Object.freeze([
  "bench_current_view_and_shop_commands_observed",
  "every_relevant_event_has_one_match_session_and_valid_timestamp",
  "own_state_unknown_ids_forbidden",
  "raw_star_prefix_matches_catalog_star",
  "explicit_patch_source_alias_requires_exact_raw_id",
  "mapping_ratio_at_least_98_percent",
  "shop_only_unknown_ids_require_explicit_patch_exception",
]);

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-runtime-id-mapping.mjs",
    "  node tools/verify-jcc-mumu-runtime-id-mapping.mjs --events <events.jsonl> --overlay <runtime-catalog-overlay.json> --season <id> --patch <id> [--allow-shop-only-id <id>] [--out <receipt.json>]",
    "  node tools/verify-jcc-mumu-runtime-id-mapping.mjs --receipt <receipt.json> --overlay <runtime-catalog-overlay.json> --season <id> --patch <id> [--allow-shop-only-id <id>]",
    "",
    "Raw match evidence is used only to generate a bounded receipt. Production verification reads the receipt, never the raw match log.",
  ].join("\n");
}

async function applyActiveMappingDefaults(options) {
  if (options.events || options.receipt) return options;
  const active = await readJsonIfExists(path.join(knowledgeRoot, "active-profile.json"));
  assert(active, "active Core Profile is unavailable");
  const bundleFile = path.resolve(knowledgeRoot, active.bundle_path || "");
  const bundle = JSON.parse(await readFile(bundleFile, "utf8"));
  const mapping = bundle.patch?.runtime_mapping_validation;
  assert(mapping?.receipt && mapping?.catalog_overlay, "active Core Profile has no runtime mapping validation contract");
  return {
    ...options,
    receipt: path.resolve(repoRoot, mapping.receipt),
    overlay: path.resolve(repoRoot, mapping.catalog_overlay),
    seasonId: active.season_id,
    patchId: active.patch_id,
    allowedShopOnlyIds: stableUnique(mapping.allowed_unresolved_shop_only_ids || []),
  };
}

function parseArgs(argv) {
  const options = { allowedShopOnlyIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--events") options.events = argv[++index];
    else if (arg === "--receipt") options.receipt = argv[++index];
    else if (arg === "--overlay") options.overlay = argv[++index];
    else if (arg === "--season") options.seasonId = argv[++index];
    else if (arg === "--patch") options.patchId = argv[++index];
    else if (arg === "--allow-shop-only-id") options.allowedShopOnlyIds.push(String(argv[++index]));
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stableUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right), "en"));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function championCatalogFingerprint(overlay) {
  return sha256(JSON.stringify(overlay?.champions_by_id || {}));
}

function normalizedSourceVariant(sourceVariant) {
  if (!sourceVariant || typeof sourceVariant !== "object") return null;
  return {
    source_id: String(sourceVariant.source_id || ""),
    order: sourceVariant.order == null ? null : Number(sourceVariant.order),
    trait_id: String(sourceVariant.trait_id || ""),
    trait_name: String(sourceVariant.trait_name || ""),
  };
}

export function championMappingFingerprint(overlay) {
  const mappingRows = Object.entries(overlay?.champions_by_id || {})
    .map(([rawId, entry]) => ({
      raw_id: String(rawId),
      id: String(entry?.id || ""),
      canonical_id: String(entry?.canonical_id || entry?.id || ""),
      name: String(entry?.name || ""),
      normalized_name: String(entry?.normalized_name || entry?.name || ""),
      resource_key: String(entry?.resource_key || ""),
      star: entry?.star == null ? null : Number(entry.star),
      mapping_kind: String(entry?.mapping_kind || ""),
      source_mapping_authority: String(entry?.source_mapping_authority || ""),
      source_variant: normalizedSourceVariant(entry?.source_variant),
    }))
    .sort((left, right) => left.raw_id.localeCompare(right.raw_id, "en"));
  return sha256(JSON.stringify(mappingRows));
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function repoRelative(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(repoRoot, absolute);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "mapping receipt must be inside the repository");
  return relative.replaceAll("\\", "/");
}

export async function verifyReceiptProfileBinding(receiptFile, receiptText, options) {
  const candidate = await readJsonIfExists(path.join(knowledgeRoot, "candidates", "candidate-profile.json"));
  const active = await readJsonIfExists(path.join(knowledgeRoot, "active-profile.json"));
  const profiles = [active, candidate].filter(Boolean);
  const receiptPath = repoRelative(receiptFile);
  const receiptHash = sha256(receiptText);
  const receiptBytes = Buffer.byteLength(receiptText, "utf8");
  const failures = [];

  for (const profile of profiles) {
    const profileId = profile.combined_fingerprint || profile.core_profile_id;
    if (profile.season_id !== options.seasonId || profile.patch_id !== options.patchId || !/^[a-f0-9]{64}$/.test(String(profileId || ""))) {
      continue;
    }
    const bundleRelative = profile.bundle_path;
    if (typeof bundleRelative !== "string" || !bundleRelative.trim()) continue;
    const bundleFile = path.resolve(knowledgeRoot, bundleRelative);
    const bundleText = await readFile(bundleFile, "utf8");
    const expectedBundleHash = profile.bundle_sha256;
    if (expectedBundleHash && sha256(bundleText) !== expectedBundleHash) {
      failures.push(`${profileId}: bundle fingerprint mismatch`);
      continue;
    }
    const bundle = JSON.parse(bundleText);
    if (bundle.combined_fingerprint !== profileId) {
      failures.push(`${profileId}: bundle identity mismatch`);
      continue;
    }
    const source = (bundle.source_metadata?.referenced_sources || []).find((entry) => entry.role === "mumu_runtime_id_mapping_receipt");
    if (!source) {
      failures.push(`${profileId}: mapping receipt source is absent`);
      continue;
    }
    if (source.path !== receiptPath) {
      failures.push(`${profileId}: mapping receipt path mismatch`);
      continue;
    }
    if (source.sha256 !== receiptHash || Number(source.byte_size) !== receiptBytes) {
      failures.push(`${profileId}: mapping receipt content is not bound to the immutable bundle`);
      continue;
    }
    return {
      core_profile_id: profileId,
      profile_status: profile.schema === "jcc-game-knowledge-active-profile-v1" ? "active" : "candidate",
      receipt_sha256: receiptHash,
      receipt_byte_size: receiptBytes,
    };
  }

  throw new Error(`mapping receipt is not bound to a matching immutable Core Profile${failures.length ? ` (${failures.join("; ")})` : ""}`);
}

function normalizedOverlayEntry(overlay, rawId) {
  return overlay.champions_by_id?.[String(rawId)] || null;
}

function assertCatalogMapping(entry, normalized, rawId) {
  assert(Number(entry.star) === normalized.star_level_hint, `catalog star mismatch for ${rawId}: expected ${normalized.star_level_hint}, got ${entry.star}`);
  const canonicalId = String(entry.canonical_id || entry.id);
  if (entry.mapping_kind) {
    assert(String(entry.id) === String(rawId), `explicit source mapping id mismatch for ${rawId}`);
    assert(typeof entry.source_mapping_authority === "string" && entry.source_mapping_authority.trim(), `explicit source mapping authority missing for ${rawId}`);
  } else {
    assert(normalized.base_hero_id === Number(canonicalId) + 10000, `catalog canonical id mismatch for ${rawId}`);
  }
  return canonicalId;
}

function readRows(event) {
  const field = SOURCE_FIELDS[event.command];
  return field && Array.isArray(event.payload?.[field]) ? event.payload[field] : [];
}

export function analyzeMumuRuntimeIdEvents(text, overlay, options) {
  const events = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  const relevant = events.filter((event) => Object.hasOwn(SOURCE_FIELDS, event.command));
  assert(relevant.length > 0, "mapping evidence has no 4352/4353/4354 events");

  const byRawId = new Map();
  const commandCounts = { "4352": 0, "4353": 0, "4354": 0 };
  const matchIds = new Set();
  let firstObservedAt = null;
  let lastObservedAt = null;

  for (const event of relevant) {
    assert(
      typeof event.match_session_id === "string" && event.match_session_id.trim(),
      `mapping evidence event ${event.command} is missing match_session_id`,
    );
    assert(
      typeof event.observed_at === "string" && event.observed_at.trim() && Number.isFinite(Date.parse(event.observed_at)),
      `mapping evidence event ${event.command} has invalid observed_at`,
    );
    commandCounts[String(event.command)] += 1;
    matchIds.add(event.match_session_id.trim());
    if (!firstObservedAt || event.observed_at < firstObservedAt) firstObservedAt = event.observed_at;
    if (!lastObservedAt || event.observed_at > lastObservedAt) lastObservedAt = event.observed_at;
    for (const row of readRows(event)) {
      const rawId = String(row?.i ?? "");
      if (!/^\d+$/.test(rawId)) continue;
      const current = byRawId.get(rawId) || { raw_id: rawId, occurrences: 0, commands: new Set() };
      current.occurrences += 1;
      current.commands.add(event.command);
      byRawId.set(rawId, current);
    }
  }

  assert(matchIds.size === 1, `mapping evidence must belong to exactly one match session, got ${matchIds.size}`);
  const allowedShopOnly = new Set(options.allowedShopOnlyIds);
  const resolved = [];
  const unresolved = [];
  const canonicalSources = new Map();
  const canonicalStars = new Map();

  for (const evidence of byRawId.values()) {
    const normalized = normalizeMumuHeroId(evidence.raw_id);
    assert(normalized.base_hero_id != null, `invalid encoded MuMu hero id ${evidence.raw_id}`);
    const entry = normalizedOverlayEntry(overlay, evidence.raw_id);
    const commands = [...evidence.commands].sort((left, right) => left - right);
    if (!entry) {
      const shopOnly = commands.length === 1 && commands[0] === 4354;
      unresolved.push({
        raw_id: evidence.raw_id,
        occurrences: evidence.occurrences,
        commands,
        classification: shopOnly ? "shop_only_out_of_catalog" : "own_state_out_of_catalog",
        explicitly_allowed: shopOnly && allowedShopOnly.has(evidence.raw_id),
      });
      continue;
    }

    const encodedStar = normalized.star_level_hint;
    const canonicalId = assertCatalogMapping(entry, normalized, evidence.raw_id);
    if (!canonicalSources.has(canonicalId)) canonicalSources.set(canonicalId, new Set());
    if (!canonicalStars.has(canonicalId)) canonicalStars.set(canonicalId, new Set());
    commands.forEach((command) => canonicalSources.get(canonicalId).add(command));
    canonicalStars.get(canonicalId).add(encodedStar);
    resolved.push({
      raw_id: evidence.raw_id,
      canonical_id: canonicalId,
      name: entry.name,
      star: encodedStar,
      occurrences: evidence.occurrences,
      commands,
      ...(entry.mapping_kind ? { mapping_kind: entry.mapping_kind } : {}),
      ...(entry.source_variant ? { source_variant: entry.source_variant } : {}),
    });
  }

  const disallowedUnresolved = unresolved.filter((entry) => !entry.explicitly_allowed);
  const multiSourceCanonicalCount = [...canonicalSources.values()].filter((commands) => commands.size >= 2).length;
  const multiStarCanonicalCount = [...canonicalStars.values()].filter((stars) => stars.size >= 2).length;
  const totalUnique = byRawId.size;
  const mappingRatio = totalUnique === 0 ? 0 : resolved.length / totalUnique;

  assert(commandCounts["4352"] > 0, "mapping evidence must contain bench command 4352");
  assert(commandCounts["4353"] > 0, "mapping evidence must contain current-view command 4353");
  assert(commandCounts["4354"] > 0, "mapping evidence must contain shop command 4354");
  assert(totalUnique >= 20, `mapping evidence must contain at least 20 unique raw hero ids, got ${totalUnique}`);
  assert(resolved.length >= 20, `mapping evidence must resolve at least 20 raw hero ids, got ${resolved.length}`);
  assert(mappingRatio >= 0.98, `mapping ratio must be at least 98%, got ${(mappingRatio * 100).toFixed(2)}%`);
  assert(multiSourceCanonicalCount >= 10, `at least 10 canonical champions must appear across multiple sources, got ${multiSourceCanonicalCount}`);
  assert(multiStarCanonicalCount >= 3, `at least 3 canonical champions must appear at multiple star levels, got ${multiStarCanonicalCount}`);
  assert(disallowedUnresolved.length === 0, `unresolved mapping ids are not explicitly allowed: ${disallowedUnresolved.map((entry) => entry.raw_id).join(", ")}`);

  return {
    schema: "jcc-mumu-runtime-id-mapping-receipt-v1",
    identity: {
      season_id: options.seasonId,
      patch_id: options.patchId,
      mode_id: overlay.identity?.mode_id || null,
      champion_catalog_sha256: null,
      champion_mapping_sha256: null,
    },
    evidence: {
      match_session_id: [...matchIds][0],
      first_observed_at: firstObservedAt,
      last_observed_at: lastObservedAt,
      raw_events_sha256: sha256(text),
      raw_events_persisted_in_profile: false,
      relevant_event_count: relevant.length,
      command_counts: commandCounts,
      event_identity_validation: {
        status: "per_event_validated",
        analyzer_contract: "jcc-mumu-runtime-event-identity-v2",
        rules: ["nonempty_match_session_id", "valid_iso_observed_at", "one_shared_match_session"],
      },
    },
    coverage: {
      unique_raw_id_count: totalUnique,
      resolved_raw_id_count: resolved.length,
      mapping_ratio: Number(mappingRatio.toFixed(6)),
      canonical_entity_count: canonicalSources.size,
      multi_source_canonical_count: multiSourceCanonicalCount,
      multi_star_canonical_count: multiStarCanonicalCount,
    },
    resolved,
    unresolved,
    acceptance: {
      status: "passed",
      allowed_shop_only_ids: stableUnique(options.allowedShopOnlyIds),
      rules: [...ACCEPTANCE_RULES],
    },
  };
}

export function verifyMumuRuntimeIdReceipt(receipt, overlay, overlayText, options) {
  assert(receipt.schema === "jcc-mumu-runtime-id-mapping-receipt-v1", "unexpected mapping receipt schema");
  assert(receipt.identity?.season_id === options.seasonId, "mapping receipt season mismatch");
  assert(receipt.identity?.patch_id === options.patchId, "mapping receipt patch mismatch");
  assert(overlay.identity?.season_id === options.seasonId, "catalog overlay season mismatch");
  assert(overlay.identity?.patch_id === options.patchId, "catalog overlay patch mismatch");
  assert(receipt.identity?.mode_id === overlay.identity?.mode_id, "mapping receipt mode mismatch");
  assert(
    receipt.identity?.champion_mapping_sha256 === championMappingFingerprint(overlay),
    "mapping receipt champion mapping fingerprint mismatch",
  );
  assert(
    /^[a-f0-9]{64}$/.test(receipt.identity?.champion_catalog_sha256 || ""),
    "mapping receipt historical champion catalog fingerprint is invalid",
  );
  assert(receipt.acceptance?.status === "passed", "mapping receipt is not accepted");
  assert(receipt.evidence?.raw_events_persisted_in_profile === false, "raw match events must not be persisted in the Core Profile");
  assert(typeof receipt.evidence?.match_session_id === "string" && receipt.evidence.match_session_id.trim(), "mapping receipt requires one match session id");
  const firstObservedAt = Date.parse(receipt.evidence?.first_observed_at);
  const lastObservedAt = Date.parse(receipt.evidence?.last_observed_at);
  assert(Number.isFinite(firstObservedAt) && Number.isFinite(lastObservedAt) && firstObservedAt <= lastObservedAt, "mapping receipt timestamps are invalid");
  const identityValidation = receipt.evidence?.event_identity_validation;
  assert(
    identityValidation?.status === "per_event_validated" || identityValidation?.status === "producer_attested_legacy",
    "mapping receipt requires event identity validation lineage",
  );
  if (identityValidation.status === "producer_attested_legacy") {
    assert(identityValidation.raw_events_replayed === false, "legacy mapping attestation must disclose that raw events were not replayed");
    assert(identityValidation.producer_path === "tools/watch-jcc-mumu-runtime-logcat.mjs", "legacy mapping attestation producer mismatch");
    assert(/^[a-f0-9]{40}$/.test(identityValidation.producer_invariant_commit || ""), "legacy mapping attestation commit is invalid");
    assert(
      Array.isArray(identityValidation.guaranteed_fields)
        && identityValidation.guaranteed_fields.includes("nonempty_match_session_id")
        && identityValidation.guaranteed_fields.includes("iso_observed_at"),
      "legacy mapping attestation does not prove required event identity fields",
    );
    const invariantIntroducedAt = Date.parse(identityValidation.producer_invariant_introduced_at);
    assert(Number.isFinite(invariantIntroducedAt) && invariantIntroducedAt <= firstObservedAt, "legacy mapping producer invariant postdates the capture");
  }
  assert(/^[a-f0-9]{64}$/.test(receipt.evidence?.raw_events_sha256 || ""), "mapping receipt raw evidence fingerprint is invalid");
  const commandCounts = receipt.evidence?.command_counts || {};
  const relevantEventCount = Object.keys(SOURCE_FIELDS).reduce((sum, command) => {
    const count = Number(commandCounts[command]);
    assert(Number.isSafeInteger(count) && count > 0, `mapping receipt requires command ${command} evidence`);
    return sum + count;
  }, 0);
  assert(relevantEventCount === Number(receipt.evidence?.relevant_event_count), "mapping receipt relevant event count drift");

  const resolved = Array.isArray(receipt.resolved) ? receipt.resolved : [];
  const unresolved = Array.isArray(receipt.unresolved) ? receipt.unresolved : [];
  assert(resolved.length > 0, "mapping receipt requires resolved hero rows");
  const allRawIds = [...resolved, ...unresolved].map((entry) => String(entry.raw_id));
  assert(new Set(allRawIds).size === allRawIds.length, "mapping receipt contains duplicate raw hero ids");
  const canonicalEvidence = new Map();
  for (const entry of resolved) {
    const normalized = normalizeMumuHeroId(entry.raw_id);
    assert(normalized.base_hero_id != null, `mapping receipt raw id ${entry.raw_id} is invalid`);
    const catalog = normalizedOverlayEntry(overlay, entry.raw_id);
    assert(catalog, `mapping receipt resolved id ${entry.raw_id} is absent from catalog`);
    assert(String(catalog.canonical_id || catalog.id) === String(entry.canonical_id), `mapping receipt canonical id drift for ${entry.raw_id}`);
    assert(Number(catalog.star) === Number(entry.star), `mapping receipt star drift for ${entry.raw_id}`);
    assert(normalized.star_level_hint === Number(entry.star), `mapping receipt raw star prefix drift for ${entry.raw_id}`);
    assert(assertCatalogMapping(catalog, normalized, entry.raw_id) === String(entry.canonical_id), `mapping receipt base hero id drift for ${entry.raw_id}`);
    assert(String(entry.mapping_kind || "") === String(catalog.mapping_kind || ""), `mapping receipt mapping kind drift for ${entry.raw_id}`);
    assert(
      JSON.stringify(normalizedSourceVariant(entry.source_variant)) === JSON.stringify(normalizedSourceVariant(catalog.source_variant)),
      `mapping receipt source variant drift for ${entry.raw_id}`,
    );
    assert(Number.isSafeInteger(Number(entry.occurrences)) && Number(entry.occurrences) > 0, `mapping receipt occurrence count is invalid for ${entry.raw_id}`);
    const commands = stableUnique(entry.commands || []).map(Number);
    assert(commands.length > 0 && commands.every((command) => Object.hasOwn(SOURCE_FIELDS, command)), `mapping receipt command evidence is invalid for ${entry.raw_id}`);
    const group = canonicalEvidence.get(String(entry.canonical_id)) || { commands: new Set(), stars: new Set() };
    commands.forEach((command) => group.commands.add(command));
    group.stars.add(Number(entry.star));
    canonicalEvidence.set(String(entry.canonical_id), group);
  }
  for (const entry of unresolved) {
    const normalized = normalizeMumuHeroId(entry.raw_id);
    assert(normalized.base_hero_id != null, `mapping receipt unresolved raw id ${entry.raw_id} is invalid`);
    assert(entry.classification === "shop_only_out_of_catalog" && entry.explicitly_allowed, "mapping receipt contains an unsafe unresolved id");
    assert(JSON.stringify(stableUnique(entry.commands || []).map(Number)) === JSON.stringify([4354]), `mapping receipt unresolved id ${entry.raw_id} is not shop-only`);
    assert(Number.isSafeInteger(Number(entry.occurrences)) && Number(entry.occurrences) > 0, `mapping receipt unresolved occurrence count is invalid for ${entry.raw_id}`);
  }
  const uniqueRawIdCount = allRawIds.length;
  const mappingRatio = Number((resolved.length / uniqueRawIdCount).toFixed(6));
  const multiSourceCanonicalCount = [...canonicalEvidence.values()].filter((entry) => entry.commands.size >= 2).length;
  const multiStarCanonicalCount = [...canonicalEvidence.values()].filter((entry) => entry.stars.size >= 2).length;
  assert(receipt.coverage?.unique_raw_id_count === uniqueRawIdCount, "mapping receipt unique-id count drift");
  assert(receipt.coverage?.resolved_raw_id_count === resolved.length, "mapping receipt resolved-id count drift");
  assert(receipt.coverage?.mapping_ratio === mappingRatio, "mapping receipt ratio drift");
  assert(receipt.coverage?.canonical_entity_count === canonicalEvidence.size, "mapping receipt canonical entity count drift");
  assert(receipt.coverage?.multi_source_canonical_count === multiSourceCanonicalCount, "mapping receipt multi-source count drift");
  assert(receipt.coverage?.multi_star_canonical_count === multiStarCanonicalCount, "mapping receipt multi-star count drift");
  assert(uniqueRawIdCount >= 20, "mapping receipt unique-id coverage is too small");
  assert(mappingRatio >= 0.98, "mapping receipt ratio is below 98%");
  assert(multiSourceCanonicalCount >= 10, "mapping receipt lacks multi-source coverage");
  assert(multiStarCanonicalCount >= 3, "mapping receipt lacks multi-star coverage");
  assert(
    JSON.stringify(stableUnique(receipt.acceptance?.allowed_shop_only_ids || [])) === JSON.stringify(stableUnique(options.allowedShopOnlyIds)),
    "mapping receipt allowed shop-only ids do not match the patch verifier contract",
  );
  assert(JSON.stringify(receipt.acceptance?.rules || []) === JSON.stringify(ACCEPTANCE_RULES), "mapping receipt acceptance-rule set drift");
}

async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  options = await applyActiveMappingDefaults(options);
  assert(options.overlay, "Missing --overlay");
  assert(options.seasonId, "Missing --season");
  assert(options.patchId, "Missing --patch");
  assert(Boolean(options.events) !== Boolean(options.receipt), "Provide exactly one of --events or --receipt");

  const overlayText = await readFile(options.overlay, "utf8");
  const overlay = JSON.parse(overlayText);
  let receipt;
  let profileBinding = null;
  if (options.events) {
    const eventsText = await readFile(options.events, "utf8");
    receipt = analyzeMumuRuntimeIdEvents(eventsText, overlay, options);
    receipt.identity.champion_catalog_sha256 = championCatalogFingerprint(overlay);
    receipt.identity.champion_mapping_sha256 = championMappingFingerprint(overlay);
    if (options.out) await writeFile(options.out, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } else {
    const receiptText = await readFile(options.receipt, "utf8");
    receipt = JSON.parse(receiptText);
    profileBinding = await verifyReceiptProfileBinding(options.receipt, receiptText, options);
  }
  verifyMumuRuntimeIdReceipt(receipt, overlay, overlayText, options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    receipt: options.out || options.receipt || null,
    identity: receipt.identity,
    coverage: receipt.coverage,
    unresolved: receipt.unresolved,
    profile_binding: profileBinding,
  }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
