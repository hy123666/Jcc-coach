import { readFile } from "node:fs/promises";
import { inferAugmentCategoryIds } from "./augment-semantic-taxonomy.js";

const DEFAULT_LIMIT = 25;
const RANDOM_REWARD_PLACEHOLDER_ITEM_IDS = new Set(["9470", "9471", "9472"]);
const KNOWN_TIERS = new Map([
  ["1", "silver"],
  ["2", "gold"],
  ["3", "prismatic"],
  ["silver", "silver"],
  ["gold", "gold"],
  ["prismatic", "prismatic"],
]);

const ALIAS_EVIDENCE_KIND = {
  canonical: "canonical",
  id: "id",
  name_prefix: "name_prefix",
  name_substring: "name_substring",
  normalized: "normalized",
  first_chars: "first_chars",
  hard_data_alias: "hard_data_alias",
  player_alias: "player_alias",
  speech_alias: "speech_alias_evidence",
  category: "category",
};

export const decisionInputCatalogContract = {
  schema: "jcc-decision-input-catalog-v1",
  entity_ref_policy: "Return stable {kind,id,address,season_id,source} refs; never mutate normalized hard data with aliases.",
  search_policy: "Aliases are evidence and candidate routing only. Speech-like aliases do not auto-confirm a different entity.",
};

export function stableDecisionInputSourceJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, normalize(input[key])]));
  };
  return JSON.stringify(normalize(value));
}

export function normalizeDecisionInputText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[·•・]/g, "")
    .replace(/[（）()[\]【】{}《》<>]/g, " ")
    .replace(/[+＋]/g, " plus ")
    .replace(/[Ⅰ]/g, "i")
    .replace(/[Ⅱ]/g, "ii")
    .replace(/[Ⅲ]/g, "iii")
    .replace(/[，,。.;；:：、/\\|_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactDecisionInputText(value) {
  return normalizeDecisionInputText(value).replace(/\s+/g, "");
}

export function stableEntityRef(entity) {
  return {
    kind: entity.kind,
    id: String(entity.id),
    address: entity.address,
    season_id: entity.season_id || null,
    source: entity.source || "hard_data",
  };
}

export async function loadDecisionInputCatalog(file) {
  const catalog = JSON.parse(await readFile(file, "utf8"));
  return createDecisionInputCatalog(catalog);
}

export function createDecisionInputCatalog(catalog) {
  assertCatalogShape(catalog);
  const entities = catalog.entities.map((entity) => ({
    ...entity,
    ref: stableEntityRef(entity),
    search_text: compactDecisionInputText([
      entity.id,
      entity.name,
      entity.tier,
      entity.tier_color,
      entity.rounds?.join(" "),
      entity.category_ids?.join(" "),
      entity.category_labels?.join(" "),
      entity.item_category,
      ...(entity.tags || []),
    ].filter(Boolean).join(" ")),
  }));
  const byRef = new Map(entities.map((entity) => [refKey(entity.ref), entity]));
  const byKind = groupBy(entities, (entity) => entity.kind);
  const aliases = [];
  const searchTermsByRef = new Map();
  for (const alias of catalog.aliases || []) {
    const entity = byRef.get(refKey(alias.ref));
    if (!entity) continue;
    const key = refKey(alias.ref);
    const term = String(alias.alias || "").trim();
    if (term) searchTermsByRef.set(key, [...new Set([...(searchTermsByRef.get(key) || []), term])]);
    aliases.push({
      ...alias,
      normalized: compactDecisionInputText(alias.alias),
      entity,
    });
  }
  for (const entity of entities) {
    entity.search_terms = searchTermsByRef.get(refKey(entity.ref)) || [];
  }
  return {
    ...catalog,
    entities,
    by_ref: byRef,
    by_kind: byKind,
    aliases,
    search_terms_by_ref: searchTermsByRef,
  };
}

export function searchDecisionInputCatalog(catalogInput, options = {}) {
  const catalog = catalogInput?.by_ref ? catalogInput : createDecisionInputCatalog(catalogInput);
  const query = String(options.query || "");
  const normalizedQuery = compactDecisionInputText(query);
  const kind = options.kind ? String(options.kind) : null;
  const round = normalizeRound(options.round);
  const tier = normalizeTier(options.tier);
  const currentRound = normalizeRound(options.currentRound || options.current_round || options.stage_round) || round;
  const currentTier = normalizeTier(options.currentTier || options.current_tier || options.tier_color) || tier;
  const searchScope = options.searchScope === "global_search" ? "global_search" : "strict_dropdown";
  const itemCategory = options.itemCategory ? String(options.itemCategory) : null;
  const categoryIds = normalizeCategoryIds(options.categoryIds || options.category_ids);
  const limit = Math.max(1, Math.min(100, Number(options.limit || DEFAULT_LIMIT)));
  const allowUnknownRound = options.includeUnknownRound === true || searchScope === "global_search";
  const rows = new Map();

  const candidates = filterDecisionInputCatalog(catalog, {
    kind,
    round: searchScope === "global_search" ? null : round,
    tier: searchScope === "global_search" ? null : tier,
    itemCategory,
    categoryIds,
    includeUnknownRound: allowUnknownRound,
  });

  if (!normalizedQuery) {
    return candidates.slice(0, limit).map((entity) => resultFor(entity, 1, [{
      kind: "default_candidate",
      matched: "",
      confidence: "low",
    }], { currentRound, currentTier, searchScope }));
  }

  const add = (entity, score, evidence) => {
    const key = refKey(entity.ref);
    const existing = rows.get(key);
    const next = resultFor(entity, score, [evidence], { currentRound, currentTier, searchScope });
    if (!existing || existing.score < next.score) rows.set(key, next);
    else existing.alias_evidence.push(evidence);
  };

  for (const entity of candidates) {
    const idText = compactDecisionInputText(entity.id);
    const nameText = compactDecisionInputText(entity.name);
    if (idText && normalizedQuery === idText) add(entity, 100, evidence(ALIAS_EVIDENCE_KIND.id, entity.id, "high"));
    if (nameText && normalizedQuery === nameText) add(entity, 95, evidence(ALIAS_EVIDENCE_KIND.canonical, entity.name, "high"));
    else if (nameText && nameText.startsWith(normalizedQuery)) add(entity, 80, evidence(ALIAS_EVIDENCE_KIND.name_prefix, entity.name, "medium"));
    else if (nameText && (nameText.includes(normalizedQuery) || normalizedQuery.includes(nameText))) add(entity, 65, evidence(ALIAS_EVIDENCE_KIND.name_substring, entity.name, "medium"));
    if (entity.search_text?.includes(normalizedQuery)) add(entity, 45, evidence(ALIAS_EVIDENCE_KIND.normalized, query, "low"));
  }

  const allowedRefs = new Set(candidates.map((entity) => refKey(entity.ref)));
  for (const alias of catalog.aliases) {
    if (!allowedRefs.has(refKey(alias.ref))) continue;
    if (!alias.normalized) continue;
    const exact = alias.normalized === normalizedQuery;
    const partial = !exact && (alias.normalized.includes(normalizedQuery) || normalizedQuery.includes(alias.normalized));
    if (!exact && !partial) continue;
    const confidence = alias.evidence_kind === ALIAS_EVIDENCE_KIND.speech_alias ? "low" : exact ? "high" : "medium";
    const score = alias.evidence_kind === ALIAS_EVIDENCE_KIND.speech_alias ? 54 : exact ? 88 : 58;
    add(alias.entity, score, evidence(alias.evidence_kind, alias.alias, confidence, {
      auto_confirm: alias.auto_confirm === true,
      alias_source: alias.source || null,
    }));
  }

  return [...rows.values()]
    .sort((left, right) => right.score - left.score || left.entity.name.localeCompare(right.entity.name, "zh-Hans-CN"))
    .slice(0, limit);
}

export function filterDecisionInputCatalog(catalogInput, options = {}) {
  const catalog = catalogInput?.by_ref ? catalogInput : createDecisionInputCatalog(catalogInput);
  const kind = options.kind ? String(options.kind) : null;
  const round = normalizeRound(options.round);
  const tier = normalizeTier(options.tier);
  const itemCategory = options.itemCategory ? String(options.itemCategory) : null;
  const categoryIds = normalizeCategoryIds(options.categoryIds || options.category_ids);
  const includeUnknownRound = options.includeUnknownRound === true;
  let rows = kind ? [...(catalog.by_kind.get(kind) || [])] : catalog.entities;
  if (tier) rows = rows.filter((entity) => normalizeTier(entity.tier) === tier || entity.tier_color === tier);
  if (itemCategory) rows = rows.filter((entity) => entity.item_category === itemCategory);
  if (categoryIds.length) rows = rows.filter((entity) => {
    if (entity.kind !== "augment") return true;
    const entityCategories = new Set(normalizeCategoryIds(entity.category_ids));
    return categoryIds.some((categoryId) => entityCategories.has(categoryId));
  });
  if (round) {
    rows = rows.filter((entity) => {
      if (entity.kind !== "augment") return true;
      if ((entity.rounds || []).includes(round)) return true;
      return includeUnknownRound && entity.round_bucket === "unknown_round";
    });
  }
  return rows;
}

export function listDecisionInputCandidates(catalogInput, options = {}) {
  const catalog = catalogInput?.by_ref ? catalogInput : createDecisionInputCatalog(catalogInput);
  const round = normalizeRound(options.round);
  const tier = normalizeTier(options.tier);
  const searchScope = options.searchScope === "global_search" ? "global_search" : "strict_dropdown";
  return filterDecisionInputCatalog(catalog, options).map((entity) => ({
    ref: entity.ref,
    name: entity.name,
    kind: entity.kind,
    tier: entity.tier || null,
    tier_color: entity.tier_color || null,
    rounds: entity.rounds || [],
    round_bucket: entity.round_bucket || null,
    item_category: entity.item_category || null,
    item_subtype: entity.item_subtype || null,
    category_ids: entity.category_ids || [],
    category_labels: entity.category_labels || [],
    tags: entity.tags || [],
    primary_role: entity.primary_role || null,
    browse_facets: entity.browse_facets || [],
    usage_taxonomy_status: entity.usage_taxonomy_status || null,
    desc: entity.desc || null,
    search_terms: entity.search_terms || [],
    availability_match: availabilityFor(entity, { currentRound: round, currentTier: tier, searchScope }).availability_match,
    current_stage_eligible: availabilityFor(entity, { currentRound: round, currentTier: tier, searchScope }).current_stage_eligible,
    stage_unknown: entity.stage_unknown === true,
  }));
}

export function buildDecisionInputCatalogFromSources(sources) {
  const seasonId = String(sources.seasonId || sources.manifest?.season_id || "unknown");
  const augmentStages = stagesFromNormalRules(sources.normalRules);
  const augmentStageAuthority = augmentStageAuthorityByAddress(sources.augmentStageAuthority);
  const entityAliasGateway = sources.entityAliasGateway || null;
  const itemUsageTaxonomy = new Map(asArray(sources.itemUsageTaxonomy?.entries)
    .map((entry) => [String(entry?.item_id || ""), entry])
    .filter(([id]) => id));
  if (sources.itemUsageTaxonomy) {
    if (sources.itemUsageTaxonomy.schema !== "jcc-patch-item-usage-taxonomy-v1") {
      throw new Error(`unsupported item usage taxonomy schema: ${sources.itemUsageTaxonomy.schema || "missing"}`);
    }
    if (sources.itemUsageTaxonomy.identity?.season_id !== seasonId
      || sources.itemUsageTaxonomy.identity?.patch_id !== String(sources.activePatchId || "")) {
      throw new Error("item usage taxonomy identity does not match the selected patch");
    }
  }
  const entities = [];
  const aliases = [];
  const excludedChoiceEntities = [];
  const excludedItemEntities = [];
  const explicitAugmentExclusions = sourceKindExclusions(sources.specialRules, "augment");
  const configuredAugmentExclusions = uniqueBy([...explicitAugmentExclusions.values()], (row) => String(row.source_id || row.source_address));
  const augmentCategoryLabels = new Map(
    asArray(sources.augmentStageAuthority?.category_definitions)
      .map((entry) => [String(entry.id || ""), String(entry.label || entry.id || "")])
      .filter(([id]) => id),
  );
  const normalizedAugmentCategories = (ids, labels) => {
    const labelById = new Map(asArray(ids).map((id, index) => [String(id), String(asArray(labels)[index] || "")]));
    return sortedStrings(ids).map((id) => ({
      id,
      label: augmentCategoryLabels.get(id) || labelById.get(id) || id,
    }));
  };

  for (const row of asArray(sources.champions)) {
    const entity = {
      kind: "champion",
      id: String(row.id),
      address: row.address,
      season_id: seasonId,
      source: row.source || "hard_data",
      name: String(row.name || ""),
      cost: Number(row.cost) || null,
      trait_names: asArray(row.traits).map((trait) => String(trait?.name || trait || "")).filter(Boolean),
      tags: sortedStrings(row.tags),
    };
    entities.push(entity);
    addCommonAliases(aliases, entity);
    addHardDataAliases(aliases, entity, entityAliasGateway);
  }

  for (const row of asArray(sources.augments)) {
    const explicitExclusion = explicitAugmentExclusions.get(String(row.id))
      || explicitAugmentExclusions.get(String(row.address));
    if (explicitExclusion) {
      excludedChoiceEntities.push({
        source_kind: "augment",
        id: String(row.id),
        address: row.address,
        name: String(row.name || ""),
        classified_as: explicitExclusion?.classified_as || "non_choice_entity",
        reason: "season_descriptor_source_kind_exclusion",
      });
      continue;
    }
    const authority = augmentStageAuthority.get(row.address) || augmentStageAuthority.get(`id:${row.id}`) || null;
    const rounds = normalizeRoundList(authority?.rounds).filter((stageRound) => augmentStages.includes(stageRound));
    let categories = normalizedAugmentCategories(
      row.category_ids?.length ? row.category_ids : authority?.category_ids,
      row.category_labels?.length ? row.category_labels : authority?.category_labels,
    );
    const inferredCategoryIds = categories.length ? [] : inferAugmentCategoryIds(row);
    if (!categories.length) categories = normalizedAugmentCategories(inferredCategoryIds, []);
    const entity = {
      kind: "augment",
      id: String(row.id),
      address: row.address,
      season_id: seasonId,
      source: row.source || "hard_data",
      name: String(row.name || ""),
      tier: String(row.tier || ""),
      tier_color: normalizeTier(row.tier) || normalizeTier(authority?.tier_color),
      rounds,
      round_bucket: rounds.length ? "known_round" : "unknown_round",
      stage_unknown: rounds.length === 0,
      stage_authority: authority?.authority || null,
      category_ids: categories.map((entry) => entry.id),
      category_labels: categories.map((entry) => entry.label),
      category_source: inferredCategoryIds.length ? "normalized_effect_semantics" : "declared_source_category",
      tags: sortedStrings(row.tags),
      desc: row.desc || "",
    };
    entities.push(entity);
    addCommonAliases(aliases, entity);
    addHardDataAliases(aliases, entity, entityAliasGateway);
  }

  for (const generated of asArray(sources.augmentStageAuthority?.generated_augments)) {
    const rounds = normalizeRoundList(generated.rounds).filter((stageRound) => augmentStages.includes(stageRound));
    let categories = normalizedAugmentCategories(generated.category_ids, generated.category_labels);
    const inferredCategoryIds = categories.length ? [] : inferAugmentCategoryIds(generated);
    if (!categories.length) categories = normalizedAugmentCategories(inferredCategoryIds, []);
    const entity = {
      kind: "augment",
      id: String(generated.id),
      address: generated.address || `jcc:${seasonId}:augment:${generated.id}`,
      season_id: seasonId,
      source: generated.source || "generated_stage_authority",
      name: String(generated.name || ""),
      tier: String(generated.tier || ""),
      tier_color: normalizeTier(generated.tier_color || generated.tier),
      rounds,
      round_bucket: rounds.length ? "known_round" : "unknown_round",
      stage_unknown: rounds.length === 0,
      stage_authority: generated.authority || "generated_decision_input_stage_authority",
      generated_only: true,
      category_ids: categories.map((entry) => entry.id),
      category_labels: categories.map((entry) => entry.label),
      category_source: inferredCategoryIds.length ? "normalized_effect_semantics" : "declared_source_category",
      tags: sortedStrings(generated.tags),
      desc: generated.desc || "",
    };
    entities.push(entity);
    addCommonAliases(aliases, entity);
    addHardDataAliases(aliases, entity, entityAliasGateway);
  }

  for (const row of asArray(sources.items)) {
    if (!isPlayerFacingEquippableItem(row)) {
      const randomRewardPlaceholder = RANDOM_REWARD_PLACEHOLDER_ITEM_IDS.has(String(row.id));
      excludedItemEntities.push({
        source_kind: "item",
        id: String(row.id),
        address: row.address,
        name: String(row.name || ""),
        classified_as: randomRewardPlaceholder
          ? "random_reward_placeholder"
          : row.equipment_classification?.kind || "non_equippable",
        reason: randomRewardPlaceholder
          ? "random_reward_placeholder_not_player_facing_equipment"
          : row.equipment_classification?.reason || "normalized_item_not_player_facing_and_equippable",
      });
      continue;
    }
    const taxonomy = itemUsageTaxonomy.get(String(row.id)) || null;
    const enrichedRow = taxonomy
      ? {
          ...row,
          primary_role: taxonomy.primary_role || row.primary_role,
          browse_facets: [...new Set([
            ...asArray(row.browse_facets),
            ...asArray(taxonomy.browse_facets),
          ])],
          usage_taxonomy_status: "developer_curated_current_patch",
        }
      : row;
    const browseFacets = sortedStrings(enrichedRow.browse_facets);
    const entity = {
      kind: "item",
      id: String(row.id),
      address: row.address,
      season_id: seasonId,
      source: row.source || "hard_data",
      name: String(row.name || ""),
      item_category: classifyDecisionInputItemCategory(enrichedRow),
      item_subtype: classifyItemSubtype(enrichedRow),
      item_type: row.type || null,
      player_facing: true,
      equippable: true,
      equipment_classification: row.equipment_classification || null,
      tags: sortedStrings(row.tags),
      primary_role: enrichedRow.primary_role || null,
      browse_facets: browseFacets,
      usage_taxonomy_status: enrichedRow.usage_taxonomy_status || "not_browse_classified",
      desc: row.desc || "",
      basic_desc: row.basic_desc || "",
    };
    entities.push(entity);
    addCommonAliases(aliases, entity);
    addHardDataAliases(aliases, entity, entityAliasGateway);
    aliases.push(aliasRow(entity, entity.item_category, ALIAS_EVIDENCE_KIND.category, "category", { autoConfirm: false }));
  }

  const dedupedEntities = uniqueBy(entities, (entity) => `${entity.kind}:${entity.id}:${entity.address}`);
  const dedupedAliases = uniqueBy(aliases.filter((row) => row.alias && row.ref?.kind), (row) => `${refKey(row.ref)}:${row.evidence_kind}:${compactDecisionInputText(row.alias)}`);
  const byKind = Object.fromEntries([...groupBy(dedupedEntities, (entity) => entity.kind)].map(([kind, rows]) => [kind, rows.map((row) => row.address)]));
  const augmentKnown = Object.fromEntries(augmentStages.map((round) => [round, dedupedEntities
    .filter((entity) => entity.kind === "augment" && entity.rounds?.includes(round))
    .map((entity) => entity.address)]));
  return {
    schema: decisionInputCatalogContract.schema,
    contract: decisionInputCatalogContract,
    generated_at: new Date().toISOString(),
    source_identity: {
      season_id: seasonId,
      active_patch_id: sources.activePatchId || null,
      hard_data_source_ref: sources.hardDataSourceRef || null,
      hard_data_manifest_fingerprint: sources.hardDataManifestFingerprint || null,
      catalog_source_fingerprint: sources.catalogSourceFingerprint || null,
    },
    choice_descriptors: {
      augment: {
        stages: augmentStages,
        default_candidates_by_round: augmentKnown,
        unknown_round: dedupedEntities.filter((entity) => entity.kind === "augment" && entity.round_bucket === "unknown_round").map((entity) => entity.address),
        unknown_round_audit: dedupedEntities
          .filter((entity) => entity.kind === "augment" && entity.round_bucket === "unknown_round")
          .map((entity) => ({
            address: entity.address,
            id: entity.id,
            name: entity.name,
            tier: entity.tier || null,
            tier_color: entity.tier_color || null,
            reason: "no_stage_authority_binding",
          })),
        stage_authority_source: sources.augmentStageAuthority?.authority_source || null,
        category_definitions: asArray(sources.augmentStageAuthority?.category_definitions).map((row) => ({
          id: String(row.id || ""),
          label: String(row.label || row.id || ""),
        })).filter((row) => row.id),
        category_match_policy: "match_any_selected",
        configured_non_choice_entities: configuredAugmentExclusions,
        excluded_non_choice_entities: excludedChoiceEntities,
      },
    },
    item_categories: {
      components: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "components").map((entity) => entity.address),
      completed: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "completed").map((entity) => entity.address),
      radiant: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "radiant").map((entity) => entity.address),
      support: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "support").map((entity) => entity.address),
      artifacts: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "artifacts").map((entity) => entity.address),
      emblems: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "emblems").map((entity) => entity.address),
      special: dedupedEntities.filter((entity) => entity.kind === "item" && entity.item_category === "special").map((entity) => entity.address),
    },
    excluded_item_entities: excludedItemEntities,
    counts: countBy(dedupedEntities, (entity) => entity.kind),
    by_kind: byKind,
    entities: dedupedEntities.sort((left, right) => left.kind.localeCompare(right.kind) || String(left.id).localeCompare(String(right.id), undefined, { numeric: true })),
    aliases: dedupedAliases.sort((left, right) => left.ref.kind.localeCompare(right.ref.kind) || compactDecisionInputText(left.alias).localeCompare(compactDecisionInputText(right.alias))),
  };
}

function sourceKindExclusions(specialRules, sourceKind) {
  const rows = asArray(specialRules?.mechanics?.decision_input_catalog?.source_kind_exclusions?.[sourceKind]);
  const index = new Map();
  for (const row of rows) {
    if (row?.source_id != null) index.set(String(row.source_id), row);
    if (row?.source_address) index.set(String(row.source_address), row);
  }
  return index;
}

function assertCatalogShape(catalog) {
  if (catalog?.schema !== decisionInputCatalogContract.schema) {
    throw new Error(`unsupported decision input catalog schema: ${catalog?.schema || "missing"}`);
  }
  if (!Array.isArray(catalog.entities)) throw new Error("decision input catalog entities must be an array");
  if (!Array.isArray(catalog.aliases)) throw new Error("decision input catalog aliases must be an array");
}

function resultFor(entity, score, aliasEvidence, availabilityContext = {}) {
  const availability = availabilityFor(entity, availabilityContext);
  return {
    ref: entity.ref,
    entity,
    score,
    alias_evidence: aliasEvidence,
    stable_entity_ref: entity.ref,
    availability_match: availability.availability_match,
    current_stage_eligible: availability.current_stage_eligible,
    availability,
  };
}

function availabilityFor(entity, { currentRound = null, currentTier = null, searchScope = "strict_dropdown" } = {}) {
  const rounds = normalizeRoundList(entity?.rounds);
  const tier = normalizeTier(entity?.tier_color || entity?.tier);
  const stageKnown = entity?.kind !== "augment" || rounds.length > 0;
  const stageMatches = !currentRound || entity?.kind !== "augment" || rounds.includes(currentRound);
  const tierMatches = !currentTier || entity?.kind !== "augment" || tier === currentTier;
  let availabilityMatch = "eligible";
  if (entity?.kind === "augment" && !stageKnown) availabilityMatch = "stage_unknown";
  else if (!stageMatches && !tierMatches) availabilityMatch = "stage_and_tier_mismatch";
  else if (!stageMatches) availabilityMatch = "stage_mismatch";
  else if (!tierMatches) availabilityMatch = "tier_mismatch";
  else if (searchScope === "global_search") availabilityMatch = "current_stage_eligible";
  return {
    search_scope: searchScope,
    availability_match: availabilityMatch,
    current_stage_eligible: entity?.kind !== "augment" || (stageKnown && stageMatches && tierMatches),
    current_round: currentRound || null,
    current_tier: currentTier || null,
    rounds,
    stage_unknown: entity?.kind === "augment" && !stageKnown,
  };
}

function evidence(kind, matched, confidence, extra = {}) {
  return {
    kind,
    matched,
    confidence,
    auto_confirm: extra.auto_confirm === true,
    alias_source: extra.alias_source || null,
  };
}

function refKey(ref) {
  return `${ref?.kind || ""}:${ref?.id || ""}:${ref?.address || ""}`;
}

function groupBy(rows, keyFor) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    map.set(key, [...(map.get(key) || []), row]);
  }
  return map;
}

function countBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) counts[keyFor(row)] = (counts[keyFor(row)] || 0) + 1;
  return counts;
}

function uniqueBy(rows, keyFor) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = keyFor(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedStrings(value) {
  return [...new Set(asArray(value).map((item) => String(item)).filter(Boolean))].sort();
}

function normalizeTier(value) {
  const text = compactDecisionInputText(value);
  return KNOWN_TIERS.get(text) || null;
}

function normalizeCategoryIds(value) {
  return [...new Set(asArray(value)
    .map((entry) => String(entry || '').normalize('NFKC').trim().toLowerCase())
    .filter(Boolean))].sort();
}

function normalizeRound(value) {
  const text = String(value || "").trim();
  const match = text.match(/^([1-9])-([1-9])$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function normalizeRoundList(value) {
  return [...new Set(asArray(value).map(normalizeRound).filter(Boolean))].sort();
}

function stagesFromNormalRules(normalRules) {
  const mechanics = asArray(normalRules?.choice_mechanics);
  const augment = mechanics.find((row) => row?.kind === "augment" || row?.mechanic_id === "augment_choice");
  return normalizeRoundList(augment?.stages);
}

function augmentStageAuthorityByAddress(authority) {
  const rows = asArray(authority?.augment_stage_bindings);
  const map = new Map();
  for (const row of rows) {
    if (row?.address) map.set(String(row.address), row);
    if (row?.id !== undefined && row?.id !== null) map.set(`id:${row.id}`, row);
  }
  return map;
}

export function classifyDecisionInputItemCategory(row) {
  const tags = new Set(asArray(row.tags));
  if (tags.has("artifact")) return "artifacts";
  const browseFacets = new Set(asArray(row.browse_facets).map((facet) => String(facet).toLowerCase()));
  if (browseFacets.has("artifact")) return "artifacts";
  if (browseFacets.has("special")) return "special";
  const type = String(row.type || "");
  if (tags.has("component") || type === "基础装备") return "components";
  if (tags.has("emblem") || type === "转职纹章") return "emblems";
  if (tags.has("artifact") || type === "神器装备") return "artifacts";
  if (tags.has("radiant") || ["光明武器", "光明装备"].includes(type)) return "radiant";
  if (tags.has("support") || type === "辅助装备") return "support";
  if (type === "特殊装备") return "special";
  return "completed";
}

export function decisionInputTextMentionsTerm(text, term) {
  const source = compactDecisionInputText(text);
  const candidate = compactDecisionInputText(term);
  if (!source || !candidate) return false;
  if (/^[a-z0-9]+$/i.test(candidate)) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(source);
  }
  if (/^\p{Script=Han}$/u.test(candidate)) {
    if (source === candidate) return true;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[，。！？、,;；:\\s])${escaped}(?=$|[，。！？、,;；:\\s]|装备|出装|带|穿|技能|属性|强化|阵容|几星)`, "u").test(String(text || "").normalize("NFKC"));
  }
  return source.includes(candidate);
}

function classifyItemSubtype(row) {
  const tags = new Set(asArray(row.tags));
  if (tags.has("artifact")) return "artifact";
  const browseFacets = new Set(asArray(row.browse_facets).map((facet) => String(facet).toLowerCase()));
  if (browseFacets.has("artifact")) return "artifact";
  if (browseFacets.has("special")) return "special";
  const type = String(row.type || "");
  if (tags.has("component") || type === "基础装备") return "component";
  if (tags.has("emblem") || type === "转职纹章") return "emblem";
  if (tags.has("artifact") || type === "神器装备") return "artifact";
  if (tags.has("radiant") || ["光明武器", "光明装备"].includes(type)) return "radiant";
  if (tags.has("support") || type === "辅助装备") return "support";
  if (type === "特殊装备") return "special";
  return "standard_completed";
}

function isPlayerFacingEquippableItem(row) {
  if (RANDOM_REWARD_PLACEHOLDER_ITEM_IDS.has(String(row?.id))) return false;
  if (row?.player_facing !== undefined || row?.equippable !== undefined) {
    return row.player_facing === true && row.equippable === true;
  }
  const name = String(row?.name || "").normalize("NFKC");
  const description = [row?.basic_desc, row?.basicDesc, row?.desc].filter(Boolean).join(" ").normalize("NFKC");
  return !(
    /(宝箱|武器库|锻造器|装备推荐器|选择器|变形器)/u.test(name)
    || /开启.{0,12}(?:武器库|装备选择)|从.{0,12}武器库.{0,12}选择|(?:将这个|对一个|用在一个).{0,24}(?:使用|开启|激活|改变)/u.test(description)
  );
}

function addCommonAliases(aliases, entity) {
  aliases.push(aliasRow(entity, entity.id, ALIAS_EVIDENCE_KIND.id, "hard_data.id"));
  aliases.push(aliasRow(entity, entity.name, ALIAS_EVIDENCE_KIND.canonical, "hard_data.name"));
  const firstChars = firstCharacterAlias(entity.name);
  if (firstChars && firstChars !== entity.name) aliases.push(aliasRow(entity, firstChars, ALIAS_EVIDENCE_KIND.first_chars, "derived.first_chars", { autoConfirm: false }));
  for (const part of nameParts(entity.name)) aliases.push(aliasRow(entity, part, ALIAS_EVIDENCE_KIND.name_substring, "derived.name_part", { autoConfirm: false }));
  const compact = compactDecisionInputText(entity.name);
  if (compact && compact !== entity.name) aliases.push(aliasRow(entity, compact, ALIAS_EVIDENCE_KIND.normalized, "derived.normalized"));
}

function addHardDataAliases(aliases, entity, gateway) {
  const lookup = gateway?.lookup || {};
  const rows = Object.values(lookup)
    .flatMap((entry) => asArray(entry?.r))
    .filter((candidate) => candidate.entity_kind === entity.kind && candidate.entity_address === entity.address);
  for (const row of rows) {
    const declaredPlayerAlias = row.alias_class === "player_alias";
    aliases.push(aliasRow(
      entity,
      row.alias,
      declaredPlayerAlias ? ALIAS_EVIDENCE_KIND.player_alias : ALIAS_EVIDENCE_KIND.hard_data_alias,
      declaredPlayerAlias ? row.source || "compiled.player_alias" : "hard_data.entity_alias_gateway",
      { autoConfirm: false },
    ));
  }
}

function aliasRow(entity, alias, evidenceKind, source, { autoConfirm = true } = {}) {
  return {
    alias: String(alias || ""),
    evidence_kind: evidenceKind,
    source,
    auto_confirm: autoConfirm && ![ALIAS_EVIDENCE_KIND.speech_alias, ALIAS_EVIDENCE_KIND.player_alias].includes(evidenceKind),
    ref: stableEntityRef(entity),
  };
}

function nameParts(value) {
  return String(value || "")
    .split(/[\s·•・:：()（）【】《》]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function firstCharacterAlias(value) {
  return nameParts(value)
    .map((part) => [...part][0])
    .filter(Boolean)
    .join("");
}
