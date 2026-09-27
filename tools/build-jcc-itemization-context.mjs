import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const hasBoundCoreArguments = ["--expected-core-profile-id", "--hard-data-manifest", "--runtime-catalog-overlay"]
  .every((flag) => process.argv.includes(flag))
  && ["--core-profile-file", "--core-profile-base64url"].some((flag) => process.argv.includes(flag));
// A sealed hard-data request already owns its snapshot; loading Active would
// unnecessarily read unrelated Ranking data before validating that snapshot.
const runtimePaths = hasBoundCoreArguments && process.argv.includes("--hard-data-only")
  ? null : createRuntimePaths(repoRoot);
const contractFile = path.join(repoRoot, "data/runtime/jcc/itemization-decision-contract.json");

function readJson(file, fallback = null, { required = false } = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (required) {
      throw new Error(`itemization_required_data_unavailable:${path.relative(repoRoot, file)}`, { cause: error });
    }
    return fallback;
  }
}

function parseArgs(argv) {
  const out = {
    champion: null,
    maxPerGroup: 6,
    summaryOnly: false,
    queryText: "",
    hardDataOnly: false,
    coreProfileFile: runtimePaths?.activeCoreProfileFile || null,
    coreProfileJson: null,
    expectedCoreProfileId: runtimePaths?.activeCoreProfileId || null,
    hardDataManifest: runtimePaths ? path.resolve(repoRoot, runtimePaths.activeHardDataManifest) : null,
    runtimeCatalogOverlay: runtimePaths?.activeRuntimeCatalogOverlayFile || null,
    rankSignal: runtimePaths?.liveRankingsRankSignalFile || null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--champion") out.champion = argv[++i] || null;
    else if (arg === "--max-per-group") out.maxPerGroup = Number(argv[++i] || out.maxPerGroup);
    else if (arg === "--summary-only") out.summaryOnly = true;
    else if (arg === "--query-text") out.queryText = argv[++i] || "";
    else if (arg === "--hard-data-only") out.hardDataOnly = true;
    else if (arg === "--core-profile-file") out.coreProfileFile = path.resolve(argv[++i]);
    else if (arg === "--core-profile-base64url") out.coreProfileJson = Buffer.from(argv[++i] || "", "base64url").toString("utf8");
    else if (arg === "--expected-core-profile-id") out.expectedCoreProfileId = argv[++i] || null;
    else if (arg === "--hard-data-manifest") out.hardDataManifest = path.resolve(argv[++i]);
    else if (arg === "--runtime-catalog-overlay") out.runtimeCatalogOverlay = path.resolve(argv[++i]);
    else if (arg === "--rank-signal") out.rankSignal = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·・.。:：_\-#【】\[\]()（）]/g, "");
}

function idFromAddress(address) {
  const match = String(address || "").match(/:(\d+)$/);
  return match ? match[1] : null;
}

function buildLookupById(records) {
  const map = new Map();
  for (const [id, value] of Object.entries(records || {})) {
    map.set(String(id), value);
  }
  return map;
}

function buildNormalizedItemLookup(items) {
  return new Map((Array.isArray(items) ? items : [])
    .map((item) => [String(item?.id || idFromAddress(item?.address) || ""), item])
    .filter(([id]) => id));
}

function recordName(record) {
  return record?.normalized_name || record?.name || record?.display_name || record?.title || null;
}

function resolveChampionName(fit, overlayChampionsById) {
  const id = idFromAddress(fit.champion_address);
  const overlayChampion = id ? overlayChampionsById.get(id) : null;
  return recordName(overlayChampion) || fit.champion_name || null;
}

function resolveItemName(candidate, overlayItemsById) {
  const id = idFromAddress(candidate.item_address);
  const overlayItem = id ? overlayItemsById.get(id) : null;
  return recordName(overlayItem) || candidate.item_name || null;
}

function isArtifact(candidate) {
  return candidate.item_tags?.includes("artifact") || String(candidate.item_type || "").includes("神器");
}

function isRadiant(candidate) {
  return candidate.item_tags?.includes("radiant") || String(candidate.item_type || "").includes("光明");
}

function isEmblem(candidate) {
  return candidate.item_tags?.includes("emblem") || String(candidate.item_type || "").includes("纹章");
}

function isSpecial(candidate) {
  return !isArtifact(candidate)
    && !isRadiant(candidate)
    && !isEmblem(candidate)
    && !candidate.item_tags?.includes("completed")
    && String(candidate.item_type || "").includes("特殊");
}

function isCompleted(candidate) {
  return candidate.item_tags?.includes("completed") || String(candidate.item_type || "").includes("成型");
}

function compactCandidate(candidate, overlayItemsById, normalizedItemsById) {
  const itemId = idFromAddress(candidate.item_address);
  const normalizedItem = itemId ? normalizedItemsById.get(itemId) : null;
  return {
    item_id: itemId,
    item_name: resolveItemName(candidate, overlayItemsById),
    item_type: candidate.item_type || null,
    fit_score: candidate.fit_score ?? null,
    fit_reasons: Array.isArray(candidate.fit_reasons) ? candidate.fit_reasons.slice(0, 4) : [],
    tags: Array.isArray(candidate.item_tags) ? candidate.item_tags.slice(0, 10) : [],
    primary_role: normalizedItem?.primary_role || null,
    browse_facets: Array.isArray(normalizedItem?.browse_facets) ? normalizedItem.browse_facets : [],
    usage_taxonomy_status: normalizedItem?.usage_taxonomy_status || null,
    artifact_subtype: normalizedItem?.artifact_subtype
      || normalizedItem?.artifact_category
      || normalizedItem?.subtype
      || null,
  };
}

function requestedHardDataCategories(queryText) {
  const query = String(queryText || "").normalize("NFKC");
  const categories = [];
  if (/(普通装备|常规装备|成装|可合成装备)/i.test(query)) categories.push("completed");
  if (/(神器|奥恩神器|artifact)/i.test(query)) categories.push("artifact");
  if (/(光明装备|光明|radiant)/i.test(query)) categories.push("radiant");
  if (/(纹章|转职|emblem)/i.test(query)) categories.push("emblem");
  if (/(特殊装备|special item)/i.test(query)) categories.push("special");
  return categories.length ? [...new Set(categories)] : ["completed"];
}

function topCandidates(fit, predicate, overlayItemsById, normalizedItemsById, maxPerGroup) {
  return (fit?.item_candidates || [])
    .filter(predicate)
    .sort((a, b) => Number(b.fit_score || 0) - Number(a.fit_score || 0))
    .slice(0, maxPerGroup)
    .map((candidate) => compactCandidate(candidate, overlayItemsById, normalizedItemsById));
}

function chooseChampionFit(fits, championName, overlayChampionsById) {
  if (!championName) return null;
  const want = normalizeText(championName);
  return fits.find((fit) => normalizeText(resolveChampionName(fit, overlayChampionsById)) === want)
    || fits.find((fit) => normalizeText(resolveChampionName(fit, overlayChampionsById)).includes(want))
    || fits.find((fit) => want.includes(normalizeText(resolveChampionName(fit, overlayChampionsById))));
}

function rankHeroItemSignalForChampion(rankSignal, championName, overlayItemsById) {
  const want = normalizeText(championName);
  if (!want) return [];
  const out = [];
  for (const tier of Object.values(rankSignal?.tiers || {})) {
    for (const signal of tier?.hero_item_signal || []) {
      const heroName = signal.hero_name || signal.hero?.name || signal.name || null;
      if (!heroName || normalizeText(heroName) !== want) continue;
      out.push({
        tier_label: tier.label || null,
        hero_name: heroName,
        source: "equip_rank.top_3_hero",
        role: "daily_rank_prior_not_perfect_item_combo",
        item_candidates: (signal.items || signal.item_candidates || []).slice(0, 6).map((item) => {
          const itemId = String(item.item_id || item.id || item.equip_id || "");
          const overlayItem = overlayItemsById.get(itemId);
          return {
            item_id: itemId || null,
            item_name: recordName(overlayItem) || item.item_name || item.name || null,
            rank: item.rank ?? null,
            score: item.score ?? item.avg_rank ?? null,
          };
        }),
      });
    }
  }
  return out.slice(0, 4);
}

function summarizeWaitCost(itemWaitCost, overlayItemsById) {
  return (itemWaitCost || []).map((entry) => {
    const componentId = idFromAddress(entry.component_address);
    const overlayComponent = componentId ? overlayItemsById.get(componentId) : null;
    return {
      component_id: componentId,
      component_name: recordName(overlayComponent) || entry.component_name || null,
      possible_completed_item_count: entry.possible_completed_items?.length || 0,
      wait_cost_inputs: entry.wait_cost_inputs || [],
    };
  });
}

function componentRecipeContexts(queryText, normalizedItems, componentCandidates) {
  const normalizedQuery = normalizeText(queryText);
  if (!normalizedQuery) return [];
  const itemsById = buildNormalizedItemLookup(normalizedItems);
  const indexedByComponentId = new Map((componentCandidates || [])
    .map((entry) => [idFromAddress(entry?.component_address), entry])
    .filter(([id]) => id));
  return (normalizedItems || [])
    .filter((item) => item?.type === "基础装备" && normalizeText(item?.name) && normalizedQuery.includes(normalizeText(item.name)))
    .slice(0, 4)
    .map((component) => {
      const indexed = indexedByComponentId.get(String(component.id)) || null;
      const derivedCandidates = (normalizedItems || []).filter((item) => item?.recipe?.parse_status === "official_fields"
        && item.recipe.component_ids?.map(String).includes(String(component.id)));
      const candidateRows = [...new Map([
        ...(indexed?.candidates || []).map((candidate) => itemsById.get(idFromAddress(candidate.item_address)) || candidate),
        ...derivedCandidates,
      ].map((candidate) => [String(candidate?.id || idFromAddress(candidate?.item_address) || ""), candidate])
        .filter(([id]) => id)).values()];
      return {
        component_id: String(component.id),
        component_name: component.name,
        source: indexed?.candidates?.length
          ? "active_hard_data.component_to_item_candidates"
          : "active_hard_data.normalized_items_official_recipe_fallback",
        craft_candidates: candidateRows.map((item) => {
          const itemId = String(item?.id || idFromAddress(item?.item_address) || "");
          const normalizedItem = itemsById.get(itemId) || item;
          return {
            item_id: itemId || null,
            item_name: normalizedItem?.name || item?.item_name || null,
            item_type: normalizedItem?.type || null,
            tags: Array.isArray(normalizedItem?.tags) ? normalizedItem.tags.slice(0, 10) : [],
            required_components: (normalizedItem?.recipe?.component_counts || item?.required_component_counts || []).map((required) => ({
              component_id: String(required?.id || ""),
              component_name: itemsById.get(String(required?.id || ""))?.name || null,
              count: Number(required?.count || 0),
            })),
          };
        }).filter((item) => item.item_id && item.item_name),
        authority: "Only listed current-patch official recipes are craftable from this component. A trait name without a listed emblem recipe is not craftable.",
      };
    });
}

function buildContext({
  champion,
  maxPerGroup,
  summaryOnly,
  queryText,
  hardDataOnly,
  coreProfileFile,
  coreProfileJson,
  expectedCoreProfileId,
  hardDataManifest,
  runtimeCatalogOverlay,
  rankSignal,
}) {
  const coreProfile = coreProfileJson ? JSON.parse(coreProfileJson) : readJson(coreProfileFile, null);
  if (!coreProfile || coreProfile.core_profile_id !== expectedCoreProfileId) {
    throw new Error("itemization_core_profile_identity_mismatch");
  }
  const expectedHardDataManifest = path.resolve(repoRoot, coreProfile.runtime_identity?.hard_data_manifest || "");
  if (expectedHardDataManifest !== path.resolve(hardDataManifest)) {
    throw new Error("itemization_hard_data_manifest_identity_mismatch");
  }
  const patchDir = path.dirname(path.resolve(hardDataManifest));
  const normalizedItemsFile = path.join(patchDir, "normalized/items.json");
  const championItemFitFile = path.join(patchDir, "indexes/champion_item_fit.json");
  const itemWaitCostFile = path.join(patchDir, "indexes/item_wait_cost.json");
  const componentCandidatesFile = path.join(patchDir, "indexes/component_to_item_candidates.json");
  const contract = readJson(contractFile, {});
  const overlay = readJson(runtimeCatalogOverlay, {});
  const ranking = hardDataOnly ? null : readJson(rankSignal, {});
  const rankingAvailable = !hardDataOnly && Object.keys(ranking?.tiers || {}).length > 0;
  const normalizedItems = readJson(normalizedItemsFile, [], { required: true });
  const fits = readJson(championItemFitFile, [], { required: true });
  const itemWaitCost = readJson(itemWaitCostFile, [], { required: true });
  const componentCandidates = readJson(componentCandidatesFile, [], { required: true });
  const overlayChampionsById = buildLookupById(overlay.champions_by_id);
  const overlayItemsById = buildLookupById(overlay.items_by_id);
  const normalizedItemsById = buildNormalizedItemLookup(normalizedItems);
  const fit = chooseChampionFit(fits, champion, overlayChampionsById);
  const requestedCategories = hardDataOnly
    ? requestedHardDataCategories(queryText)
    : ["completed", "artifact", "radiant", "special", "emblem"];
  const categoryEnabled = (category) => requestedCategories.includes(category);

  const championContext = fit && !summaryOnly
    ? {
        champion_id: idFromAddress(fit.champion_address),
        champion_name: resolveChampionName(fit, overlayChampionsById),
        cost: fit.cost ?? null,
        role: fit.role || null,
        output_type: fit.output_type || null,
        exactness: fit.exactness || null,
        completed_candidates: categoryEnabled("completed")
          ? topCandidates(fit, isCompleted, overlayItemsById, normalizedItemsById, maxPerGroup)
          : [],
        artifact_candidates: categoryEnabled("artifact")
          ? topCandidates(fit, isArtifact, overlayItemsById, normalizedItemsById, maxPerGroup)
          : [],
        radiant_candidates: categoryEnabled("radiant")
          ? topCandidates(fit, isRadiant, overlayItemsById, normalizedItemsById, maxPerGroup)
          : [],
        special_candidates: categoryEnabled("special")
          ? topCandidates(fit, isSpecial, overlayItemsById, normalizedItemsById, maxPerGroup)
          : [],
        emblem_candidates: categoryEnabled("emblem")
          ? topCandidates(fit, isEmblem, overlayItemsById, normalizedItemsById, Math.min(maxPerGroup, 4))
          : [],
        daily_rank_prior: !rankingAvailable
          ? null
          : rankHeroItemSignalForChampion(ranking, resolveChampionName(fit, overlayChampionsById), overlayItemsById),
      }
    : null;

  const itemTypes = {
    champion_fit_records: fits.length,
    champions_with_artifact_candidates: fits.filter((entry) => entry.item_candidates?.some(isArtifact)).length,
    champions_with_radiant_candidates: fits.filter((entry) => entry.item_candidates?.some(isRadiant)).length,
    champions_with_special_candidates: fits.filter((entry) => entry.item_candidates?.some(isSpecial)).length,
  };

  return {
    schema: "jcc-itemization-context-v1",
    generated_at: new Date().toISOString(),
    core_profile_id: coreProfile.core_profile_id,
    active_season: coreProfile.season_id || overlay.season || "unknown",
    active_patch_id: coreProfile.patch_id || null,
    contract: {
      schema: contract.schema || null,
      decision_actions: contract.decision_actions || [],
      source_precedence: contract.source_precedence || [],
      wait_vs_slam_policy: contract.wait_vs_slam_policy || null,
      artifact_radiant_special_policy: contract.artifact_radiant_special_policy || null,
    },
    candidate_scope: {
      evidence_policy: hardDataOnly ? "active_core_profile_only" : "normal_selected_context",
      requested_categories: requestedCategories,
      default_category: "completed",
      special_categories_require_explicit_request: hardDataOnly,
      ranking_evidence: hardDataOnly ? "forbidden" : rankingAvailable ? "available_as_soft_prior" : "unavailable",
      artifact_subtype_policy: "Preserve an upstream subtype when present; an absent subtype does not make the parent artifact unusable.",
    },
    item_data_summary: itemTypes,
    wait_cost_summary: summarizeWaitCost(itemWaitCost, overlayItemsById),
    component_recipe_contexts: componentRecipeContexts(queryText, normalizedItems, componentCandidates),
    champion_context: championContext,
    missing_champion: champion && !fit ? champion : null,
    host_model_instruction: [
      "Use this context as candidate evidence, not as an automatic craft command.",
      "For any craft claim, use component_recipe_contexts as the current-patch authority. Never invent an unlisted emblem or recipe from a desired trait name.",
      "Answer item decisions as slam_now / wait_component / temporary_holder / hold_for_artifact_or_choice when possible.",
      hardDataOnly
        ? "This explicit request forbids daily ranking, ranking-overlay, hero-item ranking, and strategy-Wiki evidence. Use only Common, the active Core Profile, current reliable match facts, and explicit user inputs."
        : rankingAvailable
          ? "Daily rank hero_item_signal is a prior; live_state hp, tempo, components, holder, tools, augments, lobby tempo, HP pressure, and user-confirmed scouting notes decide the final action. Do not infer opponent board, power, or positioning facts."
          : "Compatible Master+ ranking evidence is not published for this Core Profile. Use active hard data and current reliable match facts without a ranking prior.",
    ],
  };
}

const args = parseArgs(process.argv);
process.stdout.write(`${JSON.stringify(buildContext(args), null, 2)}\n`);
