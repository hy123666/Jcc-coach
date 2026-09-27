import assert from "node:assert/strict";
import {
  buildKnowledgeRelationIndex,
  queryKnowledgeRelationIndex,
} from "../ui/electron/knowledge-relation-index.js";

const index = buildKnowledgeRelationIndex({
  snapshotId: "snapshot:18.1b:ranking:20260906",
  coreProfileId: "core:18.1b",
  rankingGenerationId: "ranking:20260906",
  core: {
    champions: [{ id: "champion:zyra", name: "婕拉", cost: 3, traits: ["trait:inferno", "trait:mage"], role: "carry" }],
    items: [{ id: "item:judge-emblem", name: "裁决使纹章", grants_trait: "trait:judge" }],
    traits: [{ id: "trait:inferno", name: "Inferno", breakpoints: [2, 4, 6] }],
  },
  ranking: {
    candidates: [{
      candidate_id: "lineup:alpha",
      candidate_evidence_id: "evidence:alpha",
      selected_variant_id: "variant:alpha:9",
      population: 9,
      roster: [{ id: "champion:zyra", name: "婕拉" }],
      top4_rate: 0.78,
      strength_anchor: { anchor_id: "anchor:alpha", trend_evidence: {
        observations: [{ stat_date: "20260905", metrics: { top4_rate: 0.75 } }, { stat_date: "20260906", metrics: { top4_rate: 0.78 } }],
        may_affect_current_day_score: false,
      } },
    }],
  },
  wiki: { pages: [{ page_id: "wiki:alpha", scope: "current_season", title: "法系运营", tags: ["lineup:alpha"] }] },
  semanticFeatureIndex: {
    entities: [{
      entity_kind: "augment",
      entity_id: "augment:hat",
      name: "更要命的帽子",
      features: ["effect.spell_power", "trigger.kill", "scaling.per_kill"],
      relations: [
        { type: "relation.affects", target_kind: "semantic_feature", target_id: "effect.spell_power" },
        { type: "relation.activates_after", target_kind: "semantic_feature", target_id: "trigger.kill" },
      ],
    }],
  },
  matchSessionId: "match:1",
});

const entity = queryKnowledgeRelationIndex(index, { operation: "get_entity", entity_names: ["婕拉"] });
assert.deepEqual(queryKnowledgeRelationIndex(index, { entity_names: ["trait:inferno"] }).result.entities[0].details.breakpoints,
  [2, 4, 6], "relation placeholders must not shadow canonical Core details");
assert.equal(entity.status, "ok");
assert.equal(entity.result.entities[0].id, "champion:zyra");
assert(Object.isFrozen(entity));
assert(Object.isFrozen(entity.result));
const related = queryKnowledgeRelationIndex(index, { operation: "get_related_entities", entity_names: ["婕拉"], limit: 10 });
assert(related.result.relations.some((edge) => edge.relation === "relation.has_trait" && edge.to.id === "trait:inferno"));
assert(index.relations.every((edge) => edge.relation.startsWith("relation.")), "one controlled relation namespace must own every edge");
const augmentRelations = queryKnowledgeRelationIndex(index, { operation: "get_related_entities", entity_names: ["更要命的帽子"], limit: 10 });
assert(augmentRelations.result.relations.some((edge) => edge.relation === "relation.affects" && edge.to.id === "effect.spell_power"));
const lineup = queryKnowledgeRelationIndex(index, { operation: "get_lineup", entity_names: ["lineup:alpha"] });
assert.equal(lineup.result.entities[0].id, "lineup:alpha");
assert.equal(lineup.source.ranking_generation_id, "ranking:20260906");
const trend = queryKnowledgeRelationIndex(index, { operation: "get_ranking_trend", entity_names: ["lineup:alpha"] });
assert.equal(trend.result.entities[0].historical_trend.observations.length, 2);
assert.equal(trend.result.entities[0].historical_trend.metric_scope, "strength_anchor_not_atomic_roster");
assert.equal(trend.result.entities[0].historical_trend.may_affect_current_day_score, false);
const wiki = queryKnowledgeRelationIndex(index, { operation: "get_strategy_wiki", entity_names: ["法系"] });
assert.equal(wiki.result.entities[0].scope, "current_season");
const missing = queryKnowledgeRelationIndex(index, { operation: "get_entity", entity_names: ["不存在"] });
assert.equal(missing.status, "not_found");
assert.equal(queryKnowledgeRelationIndex(index, { operation: "get_ranking_trend", entity_names: ["lineup:alpha"], sourcePolicy: "active_core_profile_only" }).error_code, "source_forbidden");
assert.equal(queryKnowledgeRelationIndex(index, { operation: "get_entity", entity_names: ["婕拉"], expectedSnapshotId: "snapshot:other" }).error_code, "snapshot_mismatch");
assert.equal(queryKnowledgeRelationIndex(index, { operation: "get_entity", entity_names: ["婕拉"], cursor: "cursor:deadbeefdeadbeef:10" }).error_code, "cursor_expired");
console.log(JSON.stringify({ ok: true, schema: "jcc-knowledge-relation-index-verification-v1", entity_count: index.entities.length, relation_count: index.relations.length }));

const full = buildKnowledgeRelationIndex({ snapshotId: "full", coreProfileId: "core:full", core: {
  champions: [{ id: "unit:a", name: "A", skill: { damage: [100, 200] }, tags: ["caster"] },
    { id: "unit:b", name: "B", skill: { damage: [50, 90] } }],
} });
const first = queryKnowledgeRelationIndex(full, { limit: 1 });
assert.deepEqual(first.result.entities[0].details.skill.damage, [100, 200]);
assert(first.result.next_cursor);
const second = queryKnowledgeRelationIndex(full, { limit: 1, cursor: first.result.next_cursor });
assert.equal(second.result.entities[0].id, "unit:b");
assert.equal(queryKnowledgeRelationIndex(full, { entity_names: ["A"], cursor: first.result.next_cursor }).error_code, "cursor_expired");
const wide = buildKnowledgeRelationIndex({ snapshotId: "wide", coreProfileId: "core:wide", core: {
  champions: Array.from({ length: 230 }, (_, i) => ({ id: `unit:${i}`, name: `Unit ${i}`, traits: ["trait:shared"] })),
  traits: [{ id: "trait:shared", name: "Shared" }],
} });
let cursor;
const edges = [];
do {
  const page = queryKnowledgeRelationIndex(wide, { operation: "get_related_entities", entity_names: ["trait:shared"], limit: 1, cursor });
  edges.push(...page.result.relations);
  cursor = page.result.next_cursor;
} while (cursor);
assert.equal(edges.length, 230, "all relation pages must be reachable");
assert.equal(new Set(edges.map(edge => edge.from.id)).size, 230, "relation pages must not repeat edges");

const collidingIds = buildKnowledgeRelationIndex({
  snapshotId: "colliding-ids",
  coreProfileId: "core:colliding-ids",
  core: {
    champions: [{ id: "1001", name: "同号英雄", traits: ["trait:test"] }],
    augments: [{ id: "1001", name: "同号强化" }],
    traits: [{ id: "trait:test", name: "测试羁绊" }],
  },
  semanticFeatureIndex: {
    entities: [{
      entity_kind: "augment",
      entity_id: "1001",
      name: "同号强化",
      features: ["effect.spell_power"],
    }],
  },
});
assert.equal(collidingIds.entities.filter((entry) => entry.id === "1001").length, 2,
  "source ids shared by different entity kinds must remain distinct");
const collidingAugment = queryKnowledgeRelationIndex(collidingIds, {
  operation: "get_related_entities",
  entity_names: ["同号强化"],
});
assert(collidingAugment.result.relations.some((edge) => edge.from.type === "augment" && edge.relation === "relation.tagged_with"));
assert(!collidingAugment.result.relations.some((edge) => edge.from.type === "champion"),
  "typed relation lookup must not leak edges from a colliding source id");

const variantScoped = buildKnowledgeRelationIndex({
  snapshotId: "variant-scoped",
  coreProfileId: "core:variant-scoped",
  rankingGenerationId: "ranking:variant-scoped",
  ranking: {
    candidates: [{
      candidate_id: "lineup:variant-scoped",
      candidate_evidence_id: "evidence:variant-scoped",
      variants: [
        {
          variant_id: "variant:ap",
          population: 8,
          core_units: [{ champion_id: "champion:ap-carry", champion_name: "AP主C" }],
          main_carry: { champion_id: "champion:ap-carry", champion_name: "AP主C" },
          primary_tank: { champion_id: "champion:ap-tank", champion_name: "AP前排" },
          associated_augment_ids: ["augment:ap"],
          equipment_requirements: {
            main_carry: { published_priority_item_ids: ["item:ap"], holder_id: "champion:ap-carry", holder_name: "AP主C" },
          },
        },
        {
          variant_id: "variant:ad",
          population: 8,
          core_units: [{ champion_id: "champion:ad-carry", champion_name: "AD主C" }],
          main_carry: { champion_id: "champion:ad-carry", champion_name: "AD主C" },
          primary_tank: { champion_id: "champion:ad-tank", champion_name: "AD前排" },
          associated_augment_ids: ["augment:ad"],
          equipment_requirements: {
            main_carry: { published_priority_item_ids: ["item:ad"], holder_id: "champion:ad-carry", holder_name: "AD主C" },
          },
        },
      ],
    }],
  },
});
const variantLineup = queryKnowledgeRelationIndex(variantScoped, {
  operation: "get_related_entities",
  entity_names: ["lineup:variant-scoped"],
  limit: 50,
});
assert(!variantLineup.result.relations.some((edge) => edge.relation === "relation.contains"),
  "a candidate without a published shared roster must not union sibling variant rosters into the lineup");
const apVariant = queryKnowledgeRelationIndex(variantScoped, {
  operation: "get_related_entities",
  entity_names: ["variant:ap"],
  limit: 50,
});
assert(apVariant.result.relations.some((edge) => edge.relation === "relation.contains" && edge.to.id === "champion:ap-carry"));
assert(apVariant.result.relations.some((edge) => edge.relation === "relation.has_main_carry" && edge.to.id === "champion:ap-carry"));
assert(apVariant.result.relations.some((edge) => edge.relation === "relation.compatible_with" && edge.to.id === "augment:ap"));
assert(apVariant.result.relations.some((edge) => edge.relation === "relation.requires_item" && edge.to.id === "item:ap"));
assert(!apVariant.result.relations.some((edge) => ["champion:ad-carry", "augment:ad", "item:ad"].includes(edge.to.id)),
  "variant retrieval must not leak sibling variant roles, augments or equipment");
assert(variantScoped.relations.filter((edge) => edge.relation === "relation.has_main_carry").every((edge) => edge.facts.scope === "variant"),
  "variant-specific role evidence must stay variant-scoped");
console.log(JSON.stringify({ ok: true, schema: "jcc-knowledge-relation-index-variant-scope-verification-v1", variant_relation_count: variantScoped.relations.length }));
