import { createHash } from "node:crypto";
import { aggregateKnowledgeResult } from "./knowledge-aggregation-layer.js";

function array(value) { return Array.isArray(value) ? value : []; }
function text(value) { return String(value || "").trim(); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"); }

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function idFor(type, value) {
  const id = text(value?.id || value?.entity_id || value?.[`${type}_id`] || value?.candidate_id || value?.lineup_group_id || value?.variant_id || value?.page_id);
  return id || `${type}:${hash(value).slice(0, 20)}`;
}

function entityKey(type, id) {
  return `${text(type) || "entity"}\u0000${text(id)}`;
}

function createEntity(index, type, value, sourceDomain, extra = {}) {
  if (!value || typeof value !== "object") return null;
  const id = idFor(type, value);
  const entity = {
    type,
    id,
    name: text(value.name || value.display_name || value.title || value.line || id),
    aliases: array(value.aliases || value.alias).map(text).filter(Boolean),
    tags: array(value.tags || value.main_traits || value.traits).map(text).filter(Boolean),
    ...(["core", "strategy_wiki"].includes(sourceDomain) ? { details: structuredClone(value) } : {}),
    ...extra,
    provenance: { source_domain: sourceDomain, ...extra.provenance },
  };
  const key = entityKey(type, id);
  if (!index.entityById.has(key)) {
    index.entityById.set(key, entity);
    index.entities.push(entity);
  } else {
    const current = index.entityById.get(key);
    if (!current.name || current.name === current.id) current.name = entity.name;
    current.aliases = [...new Set([...array(current.aliases), ...array(entity.aliases)])];
    current.tags = [...new Set([...array(current.tags), ...array(entity.tags)])];
    if (!current.details && entity.details) current.details = entity.details;
    Object.assign(current, Object.fromEntries(Object.entries(extra).filter(([, child]) => child !== undefined)));
  }
  return index.entityById.get(key);
}

function addEdge(index, from, relation, to, sourceDomain, facts = {}, condition = null, validity = "current", confidence = null) {
  if (!from || !to) return;
  if (!String(relation || "").startsWith("relation.")) throw new Error(`Uncontrolled knowledge relation: ${relation}`);
  const edge = {
    snapshot_id: index.snapshotId,
    source_domain: sourceDomain,
    from: { type: from.type, id: from.id },
    relation,
    to: { type: to.type, id: to.id },
    facts,
    condition,
    provenance: {
      source_domain: sourceDomain,
      core_profile_id: index.coreProfileId,
      ranking_generation_id: index.rankingGenerationId,
    },
    confidence: confidence || (sourceDomain === "ranking" || sourceDomain === "core" ? "authoritative" : "derived"),
    validity,
  };
  const key = JSON.stringify([edge.from, edge.relation, edge.to, edge.facts, edge.condition]);
  if (!index.edgeKeys.has(key)) {
    index.edgeKeys.add(key);
    index.relations.push(edge);
  }
}

function addCoreEntity(index, type, value) {
  const entity = createEntity(index, type, value, "core");
  if (!entity) return;
  if (type === "champion") {
    if (value.cost !== undefined) addEdge(index, entity, "relation.costs", createEntity(index, "cost", { id: `cost:${value.cost}`, name: String(value.cost) }, "core"), "core", { value: value.cost });
    if (value.role) addEdge(index, entity, "relation.has_role", createEntity(index, "role", { id: `role:${value.role}`, name: value.role }, "core"), "core");
    for (const trait of array(value.traits)) {
      const traitEntity = createEntity(index, "trait", typeof trait === "object"
        ? trait
        : { id: text(trait).startsWith("trait:") ? trait : `trait:${trait}`, name: trait }, "core");
      addEdge(index, entity, "relation.has_trait", traitEntity, "core");
    }
  }
  if (type === "item" && value.grants_trait) {
    addEdge(
      index,
      entity,
      "relation.grants",
      createEntity(index, "trait", { id: text(value.grants_trait).startsWith("trait:") ? value.grants_trait : `trait:${value.grants_trait}`, name: value.grants_trait }, "core"),
      "core",
      { grant_kind: "trait" },
    );
  }
}

function entityValue(kind, id, name = null) {
  return { id: text(id), name: text(name) || text(id) };
}

function entityId(value, kind = "entity") {
  return text(value?.[`${kind}_id`] || value?.champion_id || value?.item_id || value?.augment_id || value?.variant_id || value?.id);
}

function addSemanticFeaturePackets(index, semanticFeatureIndex = {}) {
  for (const packet of array(semanticFeatureIndex?.entities)) {
    const kind = text(packet?.entity_kind) || "entity";
    const source = createEntity(index, kind, entityValue(kind, packet?.entity_id, packet?.name), "core", {
      semantic_features: array(packet?.features),
    });
    for (const feature of array(packet?.features)) {
      const featureEntity = createEntity(index, "semantic_feature", entityValue("semantic_feature", feature), "semantic_compiler");
      addEdge(index, source, "relation.tagged_with", featureEntity, "semantic_compiler", {
        evidence: array(packet?.augment_profile?.feature_evidence).find((entry) => entry?.feature === feature) || null,
      }, null, "current", "compiled");
    }
    for (const relation of array(packet?.relations)) {
      const targetKind = text(relation?.target_kind) || "entity";
      const targetId = text(relation?.target_id);
      if (!targetId) continue;
      const target = createEntity(index, targetKind, entityValue(targetKind, targetId), "semantic_compiler");
      addEdge(index, source, relation.type, target, "semantic_compiler", {
        source_ref: packet?.source_ref || null,
      }, relation?.condition || null, "current", "compiled");
    }
  }
}

function candidateVariants(candidate) {
  return array(candidate?.variants).length
    ? array(candidate.variants)
    : [candidate?.canonical_variant || candidate?.strategy_profile?.canonical_variant, ...array(candidate?.strategy_profile?.sibling_variants)].filter(Boolean);
}

function rankingRoster(value) {
  for (const field of ["roster", "atomic_roster_members", "core_units"]) {
    if (array(value?.[field]).length) return array(value[field]);
  }
  const ids = array(value?.lineup_ids);
  const names = array(value?.lineup_names);
  return ids.map((id, index) => ({ champion_id: id, champion_name: names[index] || id }));
}

function roleValue(value, role) {
  return value?.[role]
    || value?.strategy_profile?.[role]
    || null;
}

function roleId(value) {
  return entityId(value, "champion") || text(value?.champion_id);
}

function variantAugmentIds(variant) {
  const entries = [
    ...array(variant?.associated_augments),
    ...array(variant?.strategy_profile?.associated_augments),
  ];
  return new Set([
    ...entries.map((entry) => entityId(entry, "augment")),
    ...array(variant?.associated_augment_ids).map(text),
    ...array(variant?.strategy_profile?.associated_augment_ids).map(text),
  ].filter(Boolean));
}

function addRosterRelations(index, owner, members, facts = {}) {
  for (const unit of members) {
    const championId = entityId(unit, "champion") || idFor("champion", unit);
    if (!championId) continue;
    const champion = createEntity(index, "champion", entityValue("champion", championId, unit?.champion_name || unit?.name), "ranking");
    addEdge(index, owner, "relation.contains", champion, "ranking", facts);
    addEdge(index, champion, "relation.member_of", owner, "ranking", facts);
  }
}

function addRoleRelation(index, owner, relation, role, facts = {}) {
  const championId = roleId(role);
  if (!championId) return;
  const champion = createEntity(index, "champion", entityValue("champion", championId, role?.champion_name || role?.name), "ranking");
  addEdge(index, owner, relation, champion, "ranking", facts);
}

function addAugmentRelations(index, owner, augmentEntries, augmentIds, facts = {}) {
  const entries = array(augmentEntries);
  for (const augmentId of new Set([...augmentIds].filter(Boolean))) {
    const augment = entries.find((entry) => entityId(entry, "augment") === augmentId);
    const target = createEntity(index, "augment", entityValue("augment", augmentId, augment?.augment_name || augment?.name), "ranking");
    addEdge(index, owner, "relation.compatible_with", target, "ranking", facts);
  }
}

function addEquipmentRelations(index, owner, lineup, equipment, extraFacts = {}) {
  for (const [role, requirement] of Object.entries(equipment || {})) {
    const itemIds = array(requirement?.formation_required_items).length
      ? array(requirement.formation_required_items).map((item) => entityId(item, "item"))
      : array(requirement?.published_priority_item_ids).map(text);
    const itemNames = array(requirement?.published_priority_item_names);
    itemIds.forEach((itemId, offset) => {
      if (!itemId) return;
      const item = createEntity(index, "item", entityValue("item", itemId, itemNames[offset]), "ranking");
      addEdge(index, owner, "relation.requires_item", item, "ranking", {
        ...extraFacts,
        role,
        holder_id: requirement?.holder_id || null,
        holder_name: requirement?.holder_name || null,
      });
      if (requirement?.holder_id) {
        const holder = createEntity(index, "champion", entityValue("champion", requirement.holder_id, requirement.holder_name), "ranking");
        addEdge(index, item, "relation.carried_by", holder, "ranking", {
          lineup_id: lineup.id,
          role,
          ...extraFacts,
        });
      }
    });
  }
}

function addRankingCandidate(index, candidate) {
  const anchor = candidate.strength_anchor || candidate.strategy_profile?.strength_anchor;
  const trend = anchor?.trend_evidence;
  const lineup = createEntity(index, "lineup", candidate, "ranking", {
    candidate_evidence_id: candidate.candidate_evidence_id || null,
    selected_variant_id: candidate.selected_variant_id || null,
    population: candidate.population || candidate.strategy_profile?.population || null,
    metrics: { top4_rate: candidate.top4_rate ?? anchor?.metrics?.top4_rate ?? null, top1_rate: candidate.top1_rate ?? anchor?.metrics?.top1_rate ?? null, use_rate: candidate.use_rate ?? anchor?.metrics?.use_rate ?? null },
    ...(trend ? { historical_trend: {
      metric_scope: "strength_anchor_not_atomic_roster",
      anchor_id: anchor.anchor_id,
      ...structuredClone(trend),
      series_status: array(trend.observations).length ? "available" : "not_compiled_in_pinned_generation",
    } } : {}),
  });
  const variants = candidateVariants(candidate);
  // A candidate-level roster is shared evidence only when the source actually
  // publishes one. Never form a false union from sibling variants.
  addRosterRelations(index, lineup, rankingRoster(candidate), { population: lineup.population, scope: "lineup" });

  const candidateCarry = roleValue(candidate, "main_carry");
  const candidateTank = roleValue(candidate, "primary_tank");
  const variantCarries = new Set(variants.map((variant) => roleId(roleValue(variant, "main_carry"))).filter(Boolean));
  const variantTanks = new Set(variants.map((variant) => roleId(roleValue(variant, "primary_tank"))).filter(Boolean));
  if (candidateCarry && (variantCarries.size <= 1 || !variantCarries.size)) {
    addRoleRelation(index, lineup, "relation.has_main_carry", candidateCarry, { scope: "lineup", source_interpretation: candidateCarry?.source_interpretation || null });
  }
  if (candidateTank && (variantTanks.size <= 1 || !variantTanks.size)) {
    addRoleRelation(index, lineup, "relation.has_main_tank", candidateTank, { scope: "lineup", source_interpretation: candidateTank?.source_interpretation || null });
  }
  const candidateAugments = [
    ...array(candidate.associated_augments),
    ...array(candidate.strategy_profile?.associated_augments),
  ];
  addAugmentRelations(index, lineup, candidateAugments, new Set([
    ...candidateAugments.map((entry) => entityId(entry, "augment")),
    ...array(candidate.associated_augment_ids).map(text),
    ...array(candidate.strategy_profile?.associated_augment_ids).map(text),
  ]), {
    scope: "lineup",
    evidence_kind: "published_ranking_association",
  });
  addEquipmentRelations(index, lineup, lineup, candidate.equipment_requirements || candidate.strategy_profile?.equipment_requirements || {}, { scope: "lineup" });

  const variantEntities = new Map();
  for (const variant of variants) {
    const variantId = entityId(variant, "variant");
    if (!variantId) continue;
    const variantEntity = createEntity(index, "lineup_variant", entityValue("lineup_variant", variantId, variant?.semantic_role), "ranking", {
      population: variant?.population ?? null,
      candidate_evidence_id: variant?.candidate_evidence_id || candidate?.candidate_evidence_id || null,
    });
    variantEntities.set(variantId, variantEntity);
    addEdge(index, variantEntity, "relation.member_of", lineup, "ranking");
    addRosterRelations(index, variantEntity, rankingRoster(variant), {
      scope: "variant",
      variant_id: variantId,
      population: variant?.population ?? null,
    });
    addRoleRelation(index, variantEntity, "relation.has_main_carry", roleValue(variant, "main_carry"), { scope: "variant", variant_id: variantId });
    addRoleRelation(index, variantEntity, "relation.has_main_tank", roleValue(variant, "primary_tank"), { scope: "variant", variant_id: variantId });
    addAugmentRelations(index, variantEntity, array(variant?.associated_augments), variantAugmentIds(variant), { scope: "variant", variant_id: variantId, evidence_kind: "published_ranking_association" });
    addEquipmentRelations(index, variantEntity, lineup, variant?.equipment_requirements || variant?.strategy_profile?.equipment_requirements || {}, { scope: "variant", variant_id: variantId });
    for (const trait of array(variant?.trait_signature?.traits)) {
      const traitId = text(trait?.canonical_trait_id || trait?.trait_id || trait?.id);
      if (!traitId) continue;
      const traitEntity = createEntity(index, "trait", entityValue("trait", traitId, trait?.trait_name || trait?.name), "ranking");
      addEdge(index, variantEntity, "relation.requires_breakpoint", traitEntity, "ranking", {
        scope: "variant",
        variant_id: variantId,
        breakpoint: trait?.breakpoint ?? trait?.active_breakpoint ?? null,
      });
    }
    for (const transition of array(variant?.transitions)) {
      const transitionId = entityId(transition, "variant") || text(transition?.transition_id);
      if (!transitionId) continue;
      const target = createEntity(index, "lineup_variant", entityValue("lineup_variant", transitionId, transition?.name || transition?.semantic_role), "ranking");
      addEdge(index, variantEntity, "relation.transitions_to", target, "ranking", {
        semantic_role: transition?.semantic_role || null,
      });
    }
  }
  for (const relation of [
    ...array(candidate?.semantic_features?.relations),
    ...variants.flatMap((variant) => array(variant?.semantic_features?.relations).map((entry) => ({ ...entry, variant_id: entry?.variant_id || entityId(variant, "variant") }))),
  ]) {
    if (!text(relation?.type).startsWith("relation.") || !relation?.target_id) continue;
    const targetKind = text(relation.target_kind) || "entity";
    const target = createEntity(index, targetKind, entityValue(targetKind, relation.target_id), "ranking");
    const owner = relation.variant_id ? variantEntities.get(text(relation.variant_id)) : lineup;
    if (!owner) continue;
    addEdge(index, owner, relation.type, target, "ranking", {
      scope: owner === lineup ? "lineup" : "variant",
      ...(owner === lineup ? {} : { variant_id: text(relation.variant_id) }),
      evidence_kind: "ranking_semantic_compilation",
    }, relation.condition || null, "current", "compiled");
  }
}

export function buildKnowledgeRelationIndex({
  snapshotId,
  coreProfileId = null,
  rankingGenerationId = null,
  core = {},
  ranking = {},
  wiki = {},
  semanticFeatureIndex = {},
  matchSessionId = null,
} = {}) {
  const index = {
    schema: "jcc-knowledge-relation-index-v3",
    snapshotId: text(snapshotId) || "snapshot:unknown",
    coreProfileId: text(coreProfileId) || null,
    rankingGenerationId: text(rankingGenerationId) || null,
    matchSessionId: text(matchSessionId) || null,
    entities: [],
    relations: [],
    entityById: new Map(),
    edgeKeys: new Set(),
  };
  // Register authoritative traits before champion/item relations create stubs.
  for (const trait of array(core.traits)) addCoreEntity(index, "trait", trait);
  for (const champion of array(core.champions || core.units)) addCoreEntity(index, "champion", champion);
  for (const item of array(core.items || core.equipment)) addCoreEntity(index, "item", item);
  for (const augment of array(core.augments)) addCoreEntity(index, "augment", augment);
  addSemanticFeaturePackets(index, semanticFeatureIndex);
  for (const candidate of array(ranking?.candidates || ranking?.lineup_candidates || ranking?.selected_ranking_candidates?.candidates)) addRankingCandidate(index, candidate);
  for (const page of array(wiki.pages)) {
    const pageEntity = createEntity(index, "wiki", page, "strategy_wiki", { scope: page.scope || "unclassified", season_id: page.season_id || null, patch_id: page.patch_id || null });
    for (const tag of array(page.tags)) {
      const tagEntity = createEntity(index, "tag", { id: `tag:${tag}`, name: tag }, "strategy_wiki");
      addEdge(index, pageEntity, "relation.tagged_with", tagEntity, "strategy_wiki", {}, null, page.status === "published" ? "current" : "review_required");
    }
  }
  const serializable = { ...index, entityById: undefined, edgeKeys: undefined };
  return freeze(serializable);
}

function matchingEntities(index, terms = [], type = null) {
  const normalized = array(terms).map((term) => text(term).toLocaleLowerCase("zh-CN")).filter(Boolean);
  const exactIds = new Set(index.entities.filter(entity => normalized.includes(entity.id.toLocaleLowerCase("zh-CN"))).map(entity => entity.id));
  if (normalized.length && exactIds.size === normalized.length) return index.entities.filter(entity => (!type || entity.type === type) && exactIds.has(entity.id));
  return index.entities.filter((entity) => (!type || entity.type === type)
    && (!normalized.length || normalized.some((term) => [entity.id, entity.name, ...array(entity.aliases), ...array(entity.tags)].some((value) => text(value).toLocaleLowerCase("zh-CN").includes(term)))));
}

function envelope(index, operation, entities, relations, missingFields = [], nextCursor = null) {
  const aggregated = aggregateKnowledgeResult({
    schema: "jcc-knowledge-query-result-v1",
    operation,
    result: { entities: array(entities), relations: array(relations), ...(nextCursor ? { next_cursor: nextCursor } : {}) },
    relations: array(relations),
    missingFields,
    source: {
      knowledge_snapshot_id: index.snapshotId,
      core_profile_id: index.coreProfileId,
      ranking_generation_id: index.rankingGenerationId,
      match_session_id: index.matchSessionId,
    },
    freshness: { core: index.coreProfileId ? "current" : "unavailable", ranking: index.rankingGenerationId ? "current" : "unavailable" },
    sessionId: index.matchSessionId,
    query: { operation, entities, relations },
  });
  return Object.freeze({ ...aggregated, status: "ok" });
}

export function queryKnowledgeRelationIndex(index, { operation = "get_entity", entity_names = [], facets = [], limit = 20, cursor = null, expectedSnapshotId = null, sourcePolicy = null } = {}) {
  if (["get_ranking_trend"].includes(operation) && sourcePolicy === "active_core_profile_only") return { schema: "jcc-knowledge-query-error-v1", status: "forbidden", error_code: "source_forbidden" };
  if (expectedSnapshotId && expectedSnapshotId !== index.snapshotId) return { schema: "jcc-knowledge-query-error-v1", status: "error", error_code: "snapshot_mismatch" };
  const terms = [...array(entity_names), ...array(facets)];
  const type = operation === "get_lineup" || operation === "get_ranking_trend" ? "lineup" : operation === "get_strategy_wiki" ? "wiki" : null;
  const pageSize = Math.max(1, Math.min(50, Number(limit) || 20));
  const cursorIdentity = hash([index.snapshotId, operation, terms, sourcePolicy, pageSize]).slice(0, 16);
  let offset = 0;
  let relationOffset = 0;
  if (cursor) {
    const match = /^cursor:([a-f0-9]{16}):(\d+)(?::(\d+))?$/.exec(String(cursor));
    if (!match || match[1] !== cursorIdentity) return { schema: "jcc-knowledge-query-error-v1", status: "error", error_code: "cursor_expired" };
    offset = Number(match[2]);
    relationOffset = Number(match[3] || 0);
  }
  const allEntities = matchingEntities(index, terms, type);
  const entities = allEntities.slice(offset, offset + pageSize);
  if (!entities.length) return { schema: "jcc-knowledge-query-error-v1", status: "not_found", error_code: "not_found", requested_entity_names: terms };
  const ids = new Set(entities.map((entity) => entityKey(entity.type, entity.id)));
  const allRelations = operation === "get_related_entities"
    ? index.relations.filter((edge) => ids.has(entityKey(edge.from.type, edge.from.id)) || ids.has(entityKey(edge.to.type, edge.to.id)))
    : index.relations.filter((edge) => ids.has(entityKey(edge.from.type, edge.from.id)));
  if (relationOffset && relationOffset >= allRelations.length) return { status: "error", error_code: "cursor_expired" };
  const relations = allRelations.slice(relationOffset, relationOffset + 100);
  const next = relationOffset + 100 < allRelations.length
    ? `cursor:${cursorIdentity}:${offset}:${relationOffset + 100}`
    : offset + pageSize < allEntities.length ? `cursor:${cursorIdentity}:${offset + pageSize}:0` : null;
  return envelope(index, operation, entities, relations, [], next);
}
