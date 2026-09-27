import { createHash } from "node:crypto";

export const EXPANDED_RANKING_STRATEGY_INDEX_SCHEMA = "jcc-live-ranking-strategy-index-v3";
export const NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA = "jcc-live-ranking-strategy-index-v4";
export const SUPPORTED_RANKING_STRATEGY_INDEX_SCHEMAS = new Set([
  EXPANDED_RANKING_STRATEGY_INDEX_SCHEMA,
  NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA,
]);

export function isSupportedRankingStrategyIndexSchema(value) {
  return SUPPORTED_RANKING_STRATEGY_INDEX_SCHEMAS.has(String(value || ""));
}

const SHARED_RECIPE_FIELDS = [
  "source_role",
  "freshness",
  "main_carry_id",
  "main_carry_name",
  "primary_tank_id",
  "primary_tank_name",
  "item_assignments",
  "augment_ids",
  "transitions",
  "positioning_template",
  "lineup_code",
  "playbook",
  "formation_requirements",
];

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function recipeSemanticPayload(strategyIndex) {
  return Object.fromEntries(Object.entries(strategyIndex?.tiers || {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([tierId, tier]) => [tierId, firstArray(tier?.lineup_candidates).map((candidate) => ({
      lineup_group_id: candidate?.lineup_group_id || null,
      mature_recipe_variants: firstArray(candidate?.mature_recipe_variants),
      mature_recipe_variant_receipt: candidate?.mature_recipe_variant_receipt || null,
      variants: firstArray(candidate?.variants).map((variant) => ({
        variant_id: variant?.variant_id || null,
        mature_recipe_variants: firstArray(variant?.mature_recipe_variants),
        mature_recipe_variant_receipt: variant?.mature_recipe_variant_receipt || null,
      })),
    }))]));
}

function collectRecipeRows(tier) {
  return firstArray(tier?.lineup_candidates).flatMap((candidate) => [
    ...firstArray(candidate?.mature_recipe_variants),
    ...firstArray(candidate?.variants).flatMap((variant) => firstArray(variant?.mature_recipe_variants)),
  ]);
}

function buildRecipeCatalog(rows) {
  const byRecipe = new Map();
  for (const row of rows) {
    const recipeId = String(row?.recipe_id || "").trim();
    if (!recipeId) throw new Error("ranking recipe relation is missing recipe_id");
    if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, []);
    byRecipe.get(recipeId).push(row);
  }

  const catalog = {};
  const sharedFieldsByRecipe = new Map();
  for (const recipeId of [...byRecipe.keys()].sort()) {
    const recipeRows = byRecipe.get(recipeId);
    const node = { recipe_id: recipeId };
    const sharedFields = new Set();
    for (const field of SHARED_RECIPE_FIELDS) {
      const present = recipeRows.filter((row) => Object.hasOwn(row, field));
      if (!present.length) continue;
      const expected = stableJson(present[0][field]);
      if (!present.every((row) => stableJson(row[field]) === expected)) continue;
      node[field] = structuredClone(present[0][field]);
      sharedFields.add(field);
    }
    catalog[recipeId] = node;
    sharedFieldsByRecipe.set(recipeId, sharedFields);
  }
  return { catalog, sharedFieldsByRecipe };
}

function normalizeRecipeRow(row, sharedFieldsByRecipe, relationCatalog) {
  const recipeId = String(row?.recipe_id || "").trim();
  if (!recipeId) throw new Error("ranking recipe relation is missing recipe_id");
  const sharedFields = sharedFieldsByRecipe.get(recipeId) || new Set();
  const catalogFields = SHARED_RECIPE_FIELDS.filter((field) => sharedFields.has(field) && Object.hasOwn(row, field));
  const relation = { recipe_id: recipeId };
  if (catalogFields.length) relation.catalog_fields = catalogFields;
  for (const [field, value] of Object.entries(row)) {
    if (field === "recipe_id" || catalogFields.includes(field)) continue;
    relation[field] = structuredClone(value);
  }
  const relationId = `recipe-relation:${sha256(relation).slice(0, 32)}`;
  const existing = relationCatalog[relationId];
  if (existing && stableJson(existing) !== stableJson(relation)) {
    throw new Error(`ranking recipe relation hash collision: ${relationId}`);
  }
  if (!existing) relationCatalog[relationId] = relation;
  return relationId;
}

function encodeRelationCatalog(relationCatalog, recipeCatalog) {
  const recipeIds = Object.keys(recipeCatalog).sort();
  const recipeIndexes = new Map(recipeIds.map((recipeId, index) => [recipeId, index]));
  const fieldNames = [...new Set(Object.values(relationCatalog).flatMap((relation) => (
    Object.keys(relation).filter((field) => field !== "recipe_id" && field !== "catalog_fields")
  )))].sort();
  const fieldIndexes = new Map(fieldNames.map((field, index) => [field, index]));
  const valuesByJson = new Map();
  for (const relation of Object.values(relationCatalog)) {
    for (const [field, value] of Object.entries(relation)) {
      if (field === "recipe_id" || field === "catalog_fields") continue;
      const encoded = stableJson(value);
      if (!valuesByJson.has(encoded)) valuesByJson.set(encoded, structuredClone(value));
    }
  }
  const valueJson = [...valuesByJson.keys()].sort();
  const valueIndexes = new Map(valueJson.map((encoded, index) => [encoded, index]));
  const valueCatalog = valueJson.map((encoded) => valuesByJson.get(encoded));
  const encodedCatalog = {};
  for (const relationId of Object.keys(relationCatalog).sort()) {
    const relation = relationCatalog[relationId];
    const recipeIndex = recipeIndexes.get(relation.recipe_id);
    if (!Number.isInteger(recipeIndex)) throw new Error(`missing recipe catalog entry: ${relation.recipe_id}`);
    const sharedFieldIndexes = firstArray(relation.catalog_fields)
      .map((field) => SHARED_RECIPE_FIELDS.indexOf(field));
    if (sharedFieldIndexes.some((index) => index < 0)) {
      throw new Error(`unknown shared recipe field in relation: ${relationId}`);
    }
    const fieldValueIndexes = Object.entries(relation)
      .filter(([field]) => field !== "recipe_id" && field !== "catalog_fields")
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([field, value]) => [fieldIndexes.get(field), valueIndexes.get(stableJson(value))]);
    encodedCatalog[relationId] = [recipeIndex, sharedFieldIndexes, fieldValueIndexes];
  }
  return { recipeIds, fieldNames, valueCatalog, encodedCatalog };
}

function normalizeRecipeOwner(owner, sharedFieldsByRecipe, relationCatalog) {
  if (!owner || typeof owner !== "object") return;
  const relations = firstArray(owner.mature_recipe_variants)
    .map((row) => normalizeRecipeRow(row, sharedFieldsByRecipe, relationCatalog));
  delete owner.mature_recipe_variants;
  owner.mature_recipe_relation_ids = relations;
}

function decodeRecipeRelation(relationId, tier) {
  const encodedRelation = tier?.recipe_relation_catalog?.[relationId];
  if (!encodedRelation) throw new Error(`missing recipe relation: ${relationId}`);
  if (!Array.isArray(encodedRelation) || encodedRelation.length !== 3) {
    throw new Error(`invalid encoded recipe relation: ${relationId}`);
  }
  const [recipeIndex, sharedFieldIndexes, fieldValueIndexes] = encodedRelation;
  const recipeId = tier?.recipe_catalog_ids?.[recipeIndex];
  if (!recipeId) throw new Error(`missing recipe id for relation: ${relationId}`);
  const relation = { recipe_id: recipeId };
  const catalogFields = [];
  for (const fieldIndex of firstArray(sharedFieldIndexes)) {
    const field = SHARED_RECIPE_FIELDS[fieldIndex];
    if (!field) throw new Error(`invalid shared recipe field index: ${relationId}.${fieldIndex}`);
    catalogFields.push(field);
  }
  if (catalogFields.length) relation.catalog_fields = catalogFields;
  if (!Array.isArray(fieldValueIndexes) || fieldValueIndexes.length % 2 !== 0) {
    throw new Error(`invalid recipe relation field/value indexes: ${relationId}`);
  }
  for (let index = 0; index < fieldValueIndexes.length; index += 2) {
    const field = tier?.recipe_relation_field_catalog?.[fieldValueIndexes[index]];
    const valueIndex = fieldValueIndexes[index + 1];
    if (!field || !Number.isInteger(valueIndex) || !Object.hasOwn(tier?.recipe_relation_value_catalog || [], valueIndex)) {
      throw new Error(`invalid recipe relation field/value reference: ${relationId}`);
    }
    relation[field] = structuredClone(tier.recipe_relation_value_catalog[valueIndex]);
  }
  return relation;
}

function materializeRecipeRelation(relationId, tier) {
  const relation = decodeRecipeRelation(relationId, tier);
  const recipe = tier?.recipe_catalog?.[relation.recipe_id];
  if (!recipe) throw new Error(`missing recipe catalog entry: ${relation.recipe_id}`);
  const result = { recipe_id: relation.recipe_id };
  for (const field of firstArray(relation.catalog_fields)) {
    if (!Object.hasOwn(recipe, field)) {
      throw new Error(`missing recipe catalog field: ${relation.recipe_id}.${field}`);
    }
    result[field] = structuredClone(recipe[field]);
  }
  for (const [field, value] of Object.entries(relation)) {
    if (field === "recipe_id" || field === "catalog_fields") continue;
    result[field] = structuredClone(value);
  }
  return result;
}

function materializeRecipeOwner(owner, tier) {
  if (!owner || typeof owner !== "object") return owner;
  if (Array.isArray(owner.mature_recipe_variants)) return structuredClone(owner);
  const result = structuredClone(owner);
  const relationIds = firstArray(result.mature_recipe_relation_ids);
  delete result.mature_recipe_relation_ids;
  result.mature_recipe_variants = relationIds.map((relationId) => materializeRecipeRelation(relationId, tier));
  return result;
}

export function materializeRankingCandidateRecipes(candidate, tier) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const result = materializeRecipeOwner(candidate, tier);
  result.variants = firstArray(result.variants).map((variant) => materializeRecipeOwner(variant, tier));
  return result;
}

export function normalizeRankingRecipeStorage(strategyIndex, { clone = true } = {}) {
  if (!strategyIndex || typeof strategyIndex !== "object") throw new TypeError("strategyIndex is required");
  if (strategyIndex.schema === NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    validateNormalizedRankingRecipeStorage(strategyIndex);
    return clone ? structuredClone(strategyIndex) : strategyIndex;
  }
  if (strategyIndex.schema !== EXPANDED_RANKING_STRATEGY_INDEX_SCHEMA) {
    throw new Error(`unsupported ranking strategy index schema: ${strategyIndex.schema || "missing"}`);
  }

  const result = clone ? structuredClone(strategyIndex) : strategyIndex;
  const expandedPayload = recipeSemanticPayload(result);
  let recipeCount = 0;
  let uniqueRelationCount = 0;
  let relationReferenceCount = 0;
  for (const tier of Object.values(result.tiers || {})) {
    const rows = collectRecipeRows(tier);
    const { catalog, sharedFieldsByRecipe } = buildRecipeCatalog(rows);
    const relationCatalog = {};
    for (const candidate of firstArray(tier?.lineup_candidates)) {
      normalizeRecipeOwner(candidate, sharedFieldsByRecipe, relationCatalog);
      for (const variant of firstArray(candidate?.variants)) {
        normalizeRecipeOwner(variant, sharedFieldsByRecipe, relationCatalog);
      }
    }
    const encoded = encodeRelationCatalog(relationCatalog, catalog);
    tier.recipe_catalog = catalog;
    tier.recipe_catalog_ids = encoded.recipeIds;
    tier.recipe_relation_field_catalog = encoded.fieldNames;
    tier.recipe_relation_value_catalog = encoded.valueCatalog;
    tier.recipe_relation_catalog = encoded.encodedCatalog;
    recipeCount += Object.keys(catalog).length;
    uniqueRelationCount += Object.keys(relationCatalog).length;
    relationReferenceCount += firstArray(tier?.lineup_candidates).reduce((count, candidate) => (
      count
      + firstArray(candidate?.mature_recipe_relation_ids).length
      + firstArray(candidate?.variants).reduce((sum, variant) => sum + firstArray(variant?.mature_recipe_relation_ids).length, 0)
    ), 0);
  }
  result.schema = NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA;
  delete result.content_fingerprint;
  result.recipe_storage = {
    schema: "jcc-ranking-recipe-storage-v1",
    layout: "tier_recipe_catalog_plus_interned_content_addressed_relation_catalog",
    expanded_semantic_sha256: sha256(expandedPayload),
    recipe_count: recipeCount,
    unique_relation_count: uniqueRelationCount,
    relation_reference_count: relationReferenceCount,
    interned_field_count: Object.values(result.tiers || {})
      .reduce((sum, tier) => sum + firstArray(tier?.recipe_relation_field_catalog).length, 0),
    interned_value_count: Object.values(result.tiers || {})
      .reduce((sum, tier) => sum + firstArray(tier?.recipe_relation_value_catalog).length, 0),
    lossless_materialization_required: true,
  };
  validateNormalizedRankingRecipeStorage(result);
  return result;
}

export function validateNormalizedRankingRecipeStorage(strategyIndex) {
  if (strategyIndex?.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    throw new Error(`normalized ranking strategy index must use ${NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA}`);
  }
  let recipeCount = 0;
  let uniqueRelationCount = 0;
  let relationReferenceCount = 0;
  let expandedRelationCount = 0;
  let internedFieldCount = 0;
  let internedValueCount = 0;
  const materializedTiers = {};
  for (const [tierId, tier] of Object.entries(strategyIndex?.tiers || {})) {
    recipeCount += Object.keys(tier?.recipe_catalog || {}).length;
    uniqueRelationCount += Object.keys(tier?.recipe_relation_catalog || {}).length;
    internedFieldCount += firstArray(tier?.recipe_relation_field_catalog).length;
    internedValueCount += firstArray(tier?.recipe_relation_value_catalog).length;
    for (const relationId of Object.keys(tier?.recipe_relation_catalog || {})) {
      const relation = decodeRecipeRelation(relationId, tier);
      const expectedRelationId = `recipe-relation:${sha256(relation).slice(0, 32)}`;
      if (expectedRelationId !== relationId) {
        throw new Error(`recipe relation content hash mismatch: ${relationId}`);
      }
    }
    const candidates = firstArray(tier?.lineup_candidates).map((candidate) => {
      const candidateRefs = firstArray(candidate?.mature_recipe_relation_ids).length;
      const variantRefs = firstArray(candidate?.variants)
        .reduce((sum, variant) => sum + firstArray(variant?.mature_recipe_relation_ids).length, 0);
      relationReferenceCount += candidateRefs + variantRefs;
      const materialized = materializeRankingCandidateRecipes(candidate, tier);
      expandedRelationCount += firstArray(materialized?.mature_recipe_variants).length
        + firstArray(materialized?.variants)
          .reduce((sum, variant) => sum + firstArray(variant?.mature_recipe_variants).length, 0);
      return materialized;
    });
    materializedTiers[tierId] = { lineup_candidates: candidates };
  }
  const materializedPayload = recipeSemanticPayload({ tiers: materializedTiers });
  const actualHash = sha256(materializedPayload);
  const expectedHash = String(strategyIndex?.recipe_storage?.expanded_semantic_sha256 || "");
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error("normalized ranking recipe storage is not losslessly materializable");
  }
  const receipt = {
    recipe_count: recipeCount,
    unique_relation_count: uniqueRelationCount,
    relation_reference_count: relationReferenceCount,
    expanded_relation_count: expandedRelationCount,
    interned_field_count: internedFieldCount,
    interned_value_count: internedValueCount,
    expanded_semantic_sha256: actualHash,
    equivalent: true,
  };
  for (const field of [
    "recipe_count",
    "unique_relation_count",
    "relation_reference_count",
    "interned_field_count",
    "interned_value_count",
  ]) {
    if (Number(strategyIndex?.recipe_storage?.[field]) !== receipt[field]) {
      throw new Error(`normalized ranking recipe storage receipt mismatch: ${field}`);
    }
  }
  return receipt;
}
