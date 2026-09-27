import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  buildDecisionInputCatalogFromSources,
  createDecisionInputCatalog,
  filterDecisionInputCatalog,
  listDecisionInputCandidates,
  searchDecisionInputCatalog,
  stableDecisionInputSourceJson,
} from "../ui/electron/decision-input-catalog.js";
import { resolveHardDataTarget, validateHardDataTarget } from "./jcc_hard_data_target.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ITEM_CATEGORY_SUBTYPES = new Map([
  ["components", "component"],
  ["completed", "standard_completed"],
  ["radiant", "radiant"],
  ["support", "support"],
  ["artifacts", "artifact"],
  ["emblems", "emblem"],
  ["special", "special"],
]);
const STANDARD_AUGMENT_STAGES = ["2-1", "3-2", "4-2"];

function parseArgs(argv) {
  const options = { catalog: null, candidateManifest: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--catalog") options.catalog = argv[++index];
    else if (arg === "--candidate-manifest") options.candidateManifest = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-decision-input-catalog.mjs [--catalog <catalog.json>] [--candidate-manifest <manifest.json>]",
    "",
    "Verifies the Active Core Profile decision-input catalog against its normalized sources and season descriptor.",
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Stable(value) {
  return crypto.createHash("sha256").update(stableDecisionInputSourceJson(value)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function refKey(value) {
  return `${value.kind}:${value.id}:${value.address}`;
}

function sourceExclusions(specialRules, sourceKind) {
  return specialRules?.mechanics?.decision_input_catalog?.source_kind_exclusions?.[sourceKind] || [];
}

function augmentStages(normalRules) {
  return normalRules?.choice_mechanics
    ?.find((mechanic) => mechanic.kind === "augment")?.stages || [];
}

function assertSameJson(actual, expected, message) {
  assert(stableDecisionInputSourceJson(actual) === stableDecisionInputSourceJson(expected), message);
}

function catalogContentHash(catalog) {
  return sha256Text(JSON.stringify({
    source_identity: catalog.source_identity,
    choice_descriptors: catalog.choice_descriptors,
    item_categories: catalog.item_categories,
    entities: catalog.entities.map((entity) => [entity.kind, entity.id, entity.address, entity.name, entity.cost, entity.trait_names, entity.rounds, entity.item_category, entity.item_subtype, entity.primary_role, entity.browse_facets, entity.usage_taxonomy_status, entity.stage_num, entity.stage_unknown, entity.generated_only, entity.category_ids, entity.category_labels, entity.category_source]),
    aliases: catalog.aliases.map((alias) => [alias.ref.kind, alias.ref.id, alias.alias, alias.evidence_kind]),
    unknown_round_audit: catalog.choice_descriptors.augment.unknown_round_audit,
  }));
}

function verifyAliasSearch(catalog) {
  const aliasesByKind = new Map();
  for (const alias of catalog.aliases) {
    if (!["hard_data_alias", "player_alias"].includes(alias.evidence_kind) || !String(alias.alias || "").trim()) continue;
    if (!aliasesByKind.has(alias.ref.kind)) aliasesByKind.set(alias.ref.kind, alias);
  }
  assert(aliasesByKind.size > 0, "entity_alias_gateway must contribute searchable alias evidence");
  for (const [kind, alias] of aliasesByKind) {
    const rows = searchDecisionInputCatalog(catalog, { kind, query: alias.alias, searchScope: "global_search" });
    assert(rows.some((row) => refKey(row.entity) === refKey(alias.ref)
      && row.alias_evidence.some((evidence) => ["hard_data_alias", "player_alias"].includes(evidence.kind))),
    `entity_alias_gateway alias must resolve within kind ${kind}: ${alias.alias}`);
    assert(rows.every((row) => row.entity.kind === kind), `alias search for ${kind} must not leak another entity kind`);
  }
}

function verifyKindIsolation(catalog) {
  const kindsById = new Map();
  for (const entity of catalog.entities) {
    const kinds = kindsById.get(entity.id) || new Set();
    kinds.add(entity.kind);
    kindsById.set(entity.id, kinds);
  }
  const sharedId = [...kindsById].find(([, kinds]) => kinds.size > 1);
  if (sharedId) {
    const [id, kinds] = sharedId;
    for (const kind of kinds) {
      const rows = searchDecisionInputCatalog(catalog, { kind, query: id, searchScope: "global_search" });
      assert(rows.some((row) => row.entity.id === id), `kind-filtered id search must find ${kind}:${id}`);
      assert(rows.every((row) => row.entity.kind === kind), `kind-filtered id search for ${kind}:${id} must not leak another kind`);
    }
  }
  for (const [kind, entities] of catalog.by_kind) {
    const sample = entities.find((entity) => entity.name);
    if (!sample) continue;
    const rows = searchDecisionInputCatalog(catalog, { kind, query: sample.name, searchScope: "global_search" });
    assert(rows.some((row) => refKey(row.entity) === refKey(sample)), `canonical-name search must find ${kind}:${sample.name}`);
    assert(rows.every((row) => row.entity.kind === kind), `canonical-name search for ${kind} must remain kind-isolated`);
  }
}

function verifyAugmentCategoryFiltering(catalogJson, catalog, sourceAugments) {
  const definitions = catalogJson.choice_descriptors?.augment?.category_definitions || [];
  assert(definitions.length === 6, "active augment catalog must publish all six source-defined categories");
  assert(catalogJson.choice_descriptors.augment.category_match_policy === "match_any_selected", "multiple selected categories must use OR semantics");
  const all = listDecisionInputCandidates(catalog, { kind: "augment", searchScope: "global_search", limit: 1000 });
  for (const definition of definitions) {
    const rows = listDecisionInputCandidates(catalog, {
      kind: "augment",
      categoryIds: [definition.id],
      searchScope: "global_search",
      limit: 1000,
    });
    assert(rows.every((row) => row.category_ids.includes(definition.id)), `augment category ${definition.id} filter must not leak other-only candidates`);
  }
  const sourceAddresses = new Set(sourceAugments.map((row) => row.address));
  const exclusive = listDecisionInputCandidates(catalog, {
    kind: "augment",
    categoryIds: ["exclusive"],
    searchScope: "global_search",
    limit: 1000,
  });
  assert(
    exclusive.every((row) => sourceAddresses.has(row.ref?.address)),
    "exclusive augments must come from the current canonical augment catalog instead of supplemental-only entities",
  );
  const selected = definitions.slice(0, 2).map((entry) => entry.id);
  const union = listDecisionInputCandidates(catalog, {
    kind: "augment",
    categoryIds: selected,
    searchScope: "global_search",
    limit: 1000,
  });
  assert(union.every((row) => row.category_ids.some((id) => selected.includes(id))), "multi-category filtering must match any selected category");
  assert(listDecisionInputCandidates(catalog, { kind: "augment", categoryIds: [], searchScope: "global_search", limit: 1000 }).length === all.length, "an empty category selection must preserve the complete catalog");
  const exactStage = listDecisionInputCandidates(catalog, { kind: "augment", round: "3-2", tier: "gold", categoryIds: ["combat"] });
  assert(exactStage.length > 0, "category filtering must compose with exact stage and tier filters");
  assert(exactStage.every((row) => row.rounds.includes("3-2") && row.tier_color === "gold" && row.category_ids.includes("combat")));
}

function verifyAugments({ catalogJson, catalog, sourceAugments, sourceStageAuthority, normalRules, specialRules }) {
  const descriptor = catalogJson.choice_descriptors?.augment;
  assert(descriptor, "catalog must expose the augment choice descriptor");
  const stages = augmentStages(normalRules);
  assertSameJson(stages, STANDARD_AUGMENT_STAGES, "active season descriptor must declare standard augment stages 2-1/3-2/4-2");
  assertSameJson(descriptor.stages, stages, "catalog augment stages must come from the active season descriptor");
  assert(descriptor.stage_authority_source === (sourceStageAuthority.authority_source || null), "catalog must expose the selected augment-stage authority source");

  const sourceAddresses = new Set(sourceAugments.map((row) => row.address));
  assert(sourceAddresses.size === sourceAugments.length, "normalized augments must have unique source addresses");
  const catalogAugments = catalog.by_kind.get("augment") || [];
  const sourceCatalogAugments = catalogAugments.filter((entity) => sourceAddresses.has(entity.address));
  assert(catalogAugments.every((entity) => entity.category_ids?.length), "every player-facing augment must have a declared or deterministically inferred top-level category");
  assert(catalogAugments.every((entity) => ["declared_source_category", "normalized_effect_semantics"].includes(entity.category_source)), "augment category provenance must be explicit");
  const excluded = descriptor.excluded_non_choice_entities || [];
  const classifiedAddresses = [...sourceCatalogAugments, ...excluded].map((entry) => entry.address);
  assert(classifiedAddresses.length === sourceAugments.length, "every normalized augment must be classified exactly once as player-facing or descriptor-excluded");
  assert(new Set(classifiedAddresses).size === sourceAugments.length, "normalized augment classification must not contain duplicates");
  assert(classifiedAddresses.every((address) => sourceAddresses.has(address)), "augment classification must not invent normalized source addresses");
  assert(excluded.every((entry) => !sourceCatalogAugments.some((augment) => augment.address === entry.address)), "descriptor-excluded rows must not remain player-facing augments");
  assertSameJson(descriptor.configured_non_choice_entities || [], sourceExclusions(specialRules, "augment"), "configured augment exclusions must come from the active season descriptor");

  const generated = catalogAugments.filter((entity) => entity.generated_only === true);
  assert(generated.length === (sourceStageAuthority.generated_augments || []).length, "generated-only augment count must match augment-stage authority");
  assert(generated.every((entity) => !sourceAddresses.has(entity.address)), "generated-only augments must remain outside normalized-source coverage");

  for (const stage of stages) {
    const expectedAddresses = descriptor.default_candidates_by_round?.[stage] || [];
    const candidates = filterDecisionInputCatalog(catalog, { kind: "augment", round: stage });
    assertSameJson(candidates.map((entity) => entity.address), expectedAddresses, `augment candidates for ${stage} must match the descriptor index`);
    assert(candidates.every((entity) => entity.rounds.includes(stage) && entity.round_bucket !== "unknown_round"), `${stage} candidates must have explicit stage authority`);
    for (const tier of new Set(candidates.map((entity) => entity.tier_color).filter(Boolean))) {
      const filtered = listDecisionInputCandidates(catalog, { kind: "augment", round: stage, tier });
      assert(filtered.length > 0, `${stage}/${tier} must retain its stage-authorized candidates`);
      assert(filtered.every((entity) => entity.kind === "augment" && entity.rounds.includes(stage) && entity.tier_color === tier && entity.round_bucket !== "unknown_round"), `${stage}/${tier} filtering must enforce stage, tier, and known-stage authority`);
    }
  }

  const unknownAddresses = descriptor.unknown_round || [];
  const unknownAudit = descriptor.unknown_round_audit || [];
  const unknownAugments = catalogAugments.filter((entity) => entity.round_bucket === "unknown_round");
  assert(unknownAugments.length > 0, "unresolved true augments must remain available as unknown-stage search-only entities");
  assertSameJson(unknownAugments.map((entity) => entity.address), unknownAddresses, "unknown-stage index must enumerate every unresolved augment");
  assertSameJson(unknownAudit.map((entry) => entry.address), unknownAddresses, "unknown-stage audit must enumerate every unresolved augment exactly once");
  assert(new Set(unknownAddresses).size === unknownAddresses.length, "unknown-stage augment addresses must be unique");
  for (const unknown of unknownAugments) {
    const stage = stages[0];
    const tier = unknown.tier_color || unknown.tier;
    const strictRows = searchDecisionInputCatalog(catalog, { kind: "augment", round: stage, tier, query: unknown.name });
    assert(!strictRows.some((row) => row.entity.address === unknown.address), `unknown-stage augment must not enter the ${stage} strict dropdown: ${unknown.name}`);
    const globalRows = searchDecisionInputCatalog(catalog, { kind: "augment", query: unknown.name, searchScope: "global_search", currentRound: stage, currentTier: tier });
    assert(globalRows.some((row) => row.entity.address === unknown.address
      && row.entity.stage_unknown === true
      && row.availability_match === "stage_unknown"
      && row.current_stage_eligible === false), `global search must expose unknown-stage status for ${unknown.name}`);
  }
}

function verifyItems({ catalogJson, catalog, sourceItems }) {
  const items = catalog.by_kind.get("item") || [];
  const excluded = catalogJson.excluded_item_entities || [];
  const sourceAddresses = new Set(sourceItems.map((row) => row.address));
  const classifiedAddresses = [...items, ...excluded].map((entry) => entry.address);
  assert(classifiedAddresses.length === sourceItems.length, "every normalized item must be classified as equippable or an audited exclusion");
  assert(new Set(classifiedAddresses).size === sourceItems.length, "normalized item classification must not contain duplicates");
  assert(classifiedAddresses.every((address) => sourceAddresses.has(address)), "item classification must not invent normalized source addresses");
  assert(items.every((entry) => entry.player_facing === true && entry.equippable === true), "item catalog must contain only player-facing equippable rows");
  const knownBrowseFacets = new Set(["tank", "physical", "magic", "speed", "mana", "sustain", "utility", "artifact", "special"]);
  assert(items.every((entry) => (entry.browse_facets || []).every((facet) => knownBrowseFacets.has(facet))), "item browse facets must use only the controlled UI taxonomy");
  assert(items.some((entry) => entry.item_category === "completed" && entry.browse_facets?.includes("tank")), "completed items must expose at least one version-compiled frontline facet candidate");
  const expectedUsage = new Map([
    ["无尽之刃", ["physical_carry", ["physical"]]],
    ["红霸符", ["attack_speed_carry", ["speed", "utility"]]],
    ["棘刺背心", ["frontline_tank", ["tank"]]],
    ["朔极之矛", ["caster_startup", ["mana"]]],
  ]);
  for (const [name, [primaryRole, browseFacets]] of expectedUsage) {
    const item = items.find((entry) => entry.name === name);
    assert(item?.primary_role === primaryRole, `${name} must retain its explicit current-patch holder role`);
    assertSameJson(item?.browse_facets, browseFacets, `${name} must not gain facets from incidental stat or effect text`);
    assert(["developer_curated_patch_v1", "developer_curated_current_patch"].includes(item?.usage_taxonomy_status), `${name} must expose curated patch provenance`);
  }

  assertSameJson(Object.keys(catalogJson.item_categories || {}).sort(), [...ITEM_CATEGORY_SUBTYPES.keys()].sort(), "catalog must expose the complete equipment category partition");
  const partition = [];
  for (const [category, subtype] of ITEM_CATEGORY_SUBTYPES) {
    const addresses = catalogJson.item_categories[category] || [];
    const rows = items.filter((entry) => entry.item_category === category);
    assertSameJson(
      rows.map((entry) => entry.address).sort(),
      [...addresses].sort(),
      `${category} index must contain exactly its catalog items`,
    );
    assert(rows.every((entry) => entry.item_subtype === subtype), `${category} must contain only ${subtype} items`);
    partition.push(...addresses);
  }
  assert(partition.length === items.length && new Set(partition).size === items.length, "equipment categories must form a complete, disjoint partition");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const runtimePaths = createRuntimePaths(repoRoot);
  if (!options.catalog) options.catalog = runtimePaths.activeDecisionInputCatalogFile;
  const hardDataTarget = resolveHardDataTarget({
    repoRoot,
    activeManifest: runtimePaths.activeHardDataManifest,
    argv: options.candidateManifest ? ["--candidate-manifest", options.candidateManifest] : [],
    allowCandidate: true,
  });
  const sourceManifest = await validateHardDataTarget(hardDataTarget);
  const seasonId = sourceManifest.runtime_season_id || runtimePaths.activeSeasonId;
  const patchId = sourceManifest.runtime_patch_id || runtimePaths.activePatchId;
  const seasonDescriptor = await readJson(path.join(repoRoot, "data/game-knowledge/jcc/seasons", seasonId, "season-descriptor.json"));
  const hardDataPackageDir = hardDataTarget.packageDir;
  const [sourceChampions, sourceAugments, sourceItems, sourceStageAuthority, itemUsageTaxonomy, catalogJson] = await Promise.all([
    readJson(path.join(hardDataPackageDir, "normalized/champions.json")),
    readJson(path.join(hardDataPackageDir, "normalized/augments.json")),
    readJson(path.join(hardDataPackageDir, "normalized/items.json")),
    readJson(path.join(hardDataPackageDir, "indexes/augment_stage_authority.json")),
    readJson(path.join(repoRoot, "data/game-knowledge/jcc/seasons", seasonId, "patches", patchId, "item-usage-taxonomy.json")),
    readJson(path.resolve(repoRoot, options.catalog)),
  ]);
  const coreBundle = await readJson(path.join(repoRoot, "data/game-knowledge/jcc/generated", catalogJson.source_identity.core_profile_id, "bundle.json"));
  const sourceAliasGateway = coreBundle.entity_alias_gateway;
  const normalRules = seasonDescriptor.runtime_contract?.normal_rules;
  const specialRules = seasonDescriptor.runtime_contract?.special_rules;
  const catalog = createDecisionInputCatalog(catalogJson);
  const expectedSourceRef = `core_profile_hard_data_manifest:${path.relative(repoRoot, hardDataTarget.manifestPath).replace(/\\/g, "/")}`;
  const hardDataManifestFingerprint = sha256Stable(sourceManifest);
  const catalogSourceFingerprint = sha256Stable({
    manifest: sourceManifest,
    champions: sourceChampions,
    augments: sourceAugments,
    items: sourceItems,
    item_usage_taxonomy: itemUsageTaxonomy,
    entity_alias_gateway: sourceAliasGateway,
    augment_stage_authority: sourceStageAuthority,
    normal_rules: normalRules,
    special_rules: specialRules,
  });

  assert(catalogJson.schema === "jcc-decision-input-catalog-v1", "catalog schema must be v1");
  assert(catalogJson.source_identity?.season_id === seasonId, "catalog must bind the selected season id");
  assert(catalogJson.source_identity?.active_patch_id === patchId, "catalog must bind the selected patch id");
  assert(catalogJson.source_identity?.hard_data_source_ref === expectedSourceRef, "catalog must reference its hard-data manifest logically");
  assert(catalogJson.source_identity?.hard_data_manifest_fingerprint === hardDataManifestFingerprint, "catalog must bind the exact hard-data manifest content");
  assert(catalogJson.source_identity?.catalog_source_fingerprint === catalogSourceFingerprint, "catalog must fingerprint every source that can change choices or aliases");
  assert(catalogJson.source_identity?.package_id === undefined && catalogJson.source_identity?.hard_data_manifest === undefined, "catalog must not freeze a concrete package id or absolute path");
  if (hardDataTarget.kind === "active") {
    assert(catalogJson.source_identity?.core_profile_id === runtimePaths.activeCoreProfileId, "active catalog must bind the Active Core Profile id");
  }

  verifyAugments({ catalogJson, catalog, sourceAugments, sourceStageAuthority, normalRules, specialRules });
  verifyItems({ catalogJson, catalog, sourceItems });
  assert((catalog.by_kind.get("champion") || []).length === sourceChampions.length, "active decision-input catalog must include every current champion for typed alias resolution");
  assert([...catalog.by_kind.keys()].every((kind) => ["champion", "augment", "item"].includes(kind)), "active decision-input catalog must contain only current typed decision entities");
  verifyAliasSearch(catalog);
  verifyKindIsolation(catalog);
  verifyAugmentCategoryFiltering(catalogJson, catalog, sourceAugments);

  const rebuiltCatalogJson = buildDecisionInputCatalogFromSources({
    seasonId,
    activePatchId: patchId,
    hardDataSourceRef: expectedSourceRef,
    hardDataManifestFingerprint,
    catalogSourceFingerprint,
    manifest: sourceManifest,
    champions: sourceChampions,
    augments: sourceAugments,
    items: sourceItems,
    itemUsageTaxonomy,
    entityAliasGateway: sourceAliasGateway,
    augmentStageAuthority: sourceStageAuthority,
    normalRules,
    specialRules,
  });
  rebuiltCatalogJson.generated_at = null;
  rebuiltCatalogJson.source_identity.core_profile_id = catalogJson.source_identity.core_profile_id;
  rebuiltCatalogJson.content_hash = catalogContentHash(rebuiltCatalogJson);
  assertSameJson(rebuiltCatalogJson, catalogJson, "rebuilding from the selected Active Core Profile sources must reproduce the active catalog exactly");

  console.log(JSON.stringify({
    ok: true,
    season_id: seasonId,
    patch_id: patchId,
    core_profile_id: catalogJson.source_identity.core_profile_id,
    checked: [
      "source identity and complete source fingerprint",
      "complete normalized augment classification",
      "descriptor-driven 2-1/3-2/4-2 stage and tier filtering",
      "unknown-stage augments remain global-search-only",
      "catalog-driven augment category filters compose with stage and tier",
      "player-facing equippable item classification and complete category partition",
      "kind-isolated id, canonical-name, and alias search",
      "retired season-only choice entities remain absent from the active catalog",
      "source rebuild is exactly equivalent to the active catalog",
    ],
    counts: catalogJson.counts,
    augment_stage_counts: Object.fromEntries(Object.entries(catalogJson.choice_descriptors.augment.default_candidates_by_round).map(([stage, rows]) => [stage, rows.length])),
    unknown_stage_augments: catalogJson.choice_descriptors.augment.unknown_round.length,
    item_categories: Object.fromEntries(Object.entries(catalogJson.item_categories).map(([category, rows]) => [category, rows.length])),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
