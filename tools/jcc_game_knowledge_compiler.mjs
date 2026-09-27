import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileCoreSemanticFeatureIndex } from "../ui/electron/semantic-feature-layer.js";
import {
  assertGameKnowledge,
  assertNoForeignLocalSeasonIdentifiers,
  assertUnique,
  readJsonArtifact,
  resolveContainedPath,
  sha256,
  stableJson,
} from "./jcc_game_knowledge_helpers.mjs";
import {
  createRuntimeLocalPackageId,
  GAME_KNOWLEDGE_RUNTIME_IDENTITY_SCHEMA,
  validateGameKnowledgeRuntimeIdentity,
} from "./jcc_game_knowledge_profile_store.mjs";
import {
  buildDecisionInputCatalogFromSources,
  classifyDecisionInputItemCategory,
  compactDecisionInputText,
  stableDecisionInputSourceJson,
} from "../ui/electron/decision-input-catalog.js";

export const COMPILER_SCHEMA = "jcc-game-knowledge-compiler-v1";
export const COMPILER_REVISION = "core-profile-semantic-hard-data-closure-v17";
const COMPILER_IMPLEMENTATION_PATHS = Object.freeze([
  "tools/jcc_game_knowledge_compiler.mjs",
  "ui/electron/decision-input-catalog.js",
  "ui/electron/semantic-feature-layer.js",
]);
const COMMON_SCHEMA = "jcc-game-knowledge-common-document-v1";
const SEASON_SCHEMA = "jcc-game-knowledge-season-descriptor-v1";
const PATCH_SCHEMA = "jcc-game-knowledge-patch-source-manifest-v1";
const EXTERNAL_PATCH_SOURCE_ROLES = new Set([
  "primary_augment_catalog_snapshot",
  "supplemental_hard_data_snapshot",
  "supplemental_rate_and_reward_snapshot",
  "supplemental_trait_diversity_roster_snapshot",
  "mumu_runtime_id_mapping_receipt",
  "patch_player_aliases",
  "patch_strategy",
  "item_usage_taxonomy",
  "balance_patch_overlay",
  "balance_patch_source_note",
  "official_hard_data_source_receipt",
]);

function validateManifest(manifest) {
  assertGameKnowledge(manifest?.schema === "jcc-game-knowledge-manifest-v1", "root manifest schema is invalid");
  assertGameKnowledge(manifest.logical_id === "game_knowledge.root", "root manifest logical_id is invalid");
  assertGameKnowledge(Array.isArray(manifest.common_documents) && manifest.common_documents.length > 0, "root manifest requires common_documents");
  assertGameKnowledge(Array.isArray(manifest.schemas) && manifest.schemas.length > 0, "root manifest requires schemas");
  assertGameKnowledge(manifest.generation?.production_switching === "forbidden", "compiler manifest must forbid production switching");
  assertUnique([...manifest.common_documents, ...manifest.schemas], "root manifest paths");
}

function validateSchemaArtifacts(schemaArtifacts) {
  const expectedIds = new Set([COMMON_SCHEMA, SEASON_SCHEMA, PATCH_SCHEMA]);
  assertUnique(schemaArtifacts.map((artifact) => artifact.value?.$id), "schema ids");
  for (const artifact of schemaArtifacts) {
    const schema = artifact.value;
    assertGameKnowledge(expectedIds.has(schema?.$id), `${artifact.relativePath} has an unexpected schema id`);
    assertGameKnowledge(schema.$schema === "https://json-schema.org/draft/2020-12/schema", `${artifact.relativePath} must use JSON Schema 2020-12`);
    assertGameKnowledge(schema.type === "object", `${artifact.relativePath} root type must be object`);
    assertGameKnowledge(Array.isArray(schema.required) && schema.required.length > 0, `${artifact.relativePath} requires a non-empty required list`);
    assertGameKnowledge(schema.properties && typeof schema.properties === "object", `${artifact.relativePath} requires properties`);
  }
  assertGameKnowledge(schemaArtifacts.length === expectedIds.size, "schema set must contain exactly the registered compiler schemas");
}

function validateCommonDocument(document, relativePath) {
  assertGameKnowledge(document?.schema === COMMON_SCHEMA, `${relativePath} has invalid schema`);
  assertGameKnowledge(/^common\.[a-z][a-z0-9_]*$/.test(document.logical_id || ""), `${relativePath} has invalid logical_id`);
  assertGameKnowledge(document.scope === "common", `${relativePath} must have common scope`);
  assertGameKnowledge(document.season_neutral === true, `${relativePath} must declare season_neutral=true`);
  assertGameKnowledge(Array.isArray(document.entity_references) && document.entity_references.length === 0, `${relativePath} must not contain season entity references`);
  assertGameKnowledge(Array.isArray(document.entries) && document.entries.length > 0, `${relativePath} requires entries`);
  assertUnique(document.entries.map((entry) => entry?.id), `${relativePath} entry ids`);
}

function validateSeasonDescriptor(descriptor, seasonId, relativePath) {
  assertGameKnowledge(descriptor?.schema === SEASON_SCHEMA, `${relativePath} has invalid schema`);
  assertGameKnowledge(descriptor.scope === "season", `${relativePath} must have season scope`);
  assertGameKnowledge(descriptor.season_id === seasonId, `${relativePath} season_id does not match ${seasonId}`);
  assertGameKnowledge(descriptor.logical_id === `season.${seasonId}`, `${relativePath} logical_id does not match ${seasonId}`);
  assertGameKnowledge(Array.isArray(descriptor.inherits?.standard_mechanics), `${relativePath} must declare inherited standard mechanics`);
  assertGameKnowledge(Array.isArray(descriptor.mechanics), `${relativePath} mechanics must be an array`);
  assertGameKnowledge(Array.isArray(descriptor.manual_variable_fields), `${relativePath} manual_variable_fields must be an array`);
  assertGameKnowledge(descriptor.extensions && typeof descriptor.extensions === "object" && !Array.isArray(descriptor.extensions), `${relativePath} extensions must be an object`);
  assertGameKnowledge(descriptor.runtime_contract?.schema === "jcc-season-runtime-contract-v1", `${relativePath} requires runtime_contract`);
  assertGameKnowledge(descriptor.runtime_contract.normal_rules?.season_id === seasonId, `${relativePath} runtime normal rules must match ${seasonId}`);
  assertGameKnowledge(descriptor.runtime_contract.special_rules?.season_id === seasonId, `${relativePath} runtime special rules must match ${seasonId}`);
  assertGameKnowledge(Array.isArray(descriptor.season_entity_terms) && descriptor.season_entity_terms.length > 0, `${relativePath} requires season_entity_terms`);
  assertUnique(descriptor.mechanics.map((mechanic) => mechanic?.id), `${relativePath} mechanic ids`);
  assertUnique(descriptor.manual_variable_fields.map((field) => field?.key), `${relativePath} manual variable keys`);
  assertUnique(descriptor.season_entity_terms.map((term) => String(term).toLowerCase()), `${relativePath} season entity terms`);
}

function validatePatchManifest(patchManifest, seasonId, patchId, relativePath) {
  assertGameKnowledge(patchManifest?.schema === PATCH_SCHEMA, `${relativePath} has invalid schema`);
  assertGameKnowledge(patchManifest.scope === "patch_source_manifest", `${relativePath} has invalid scope`);
  assertGameKnowledge(patchManifest.season_id === seasonId, `${relativePath} season_id does not match ${seasonId}`);
  assertGameKnowledge(patchManifest.patch_id === patchId, `${relativePath} patch_id does not match ${patchId}`);
  assertGameKnowledge(patchManifest.logical_id === `patch.${patchId}`, `${relativePath} logical_id does not match ${patchId}`);
  assertGameKnowledge(Array.isArray(patchManifest.source_artifacts) && patchManifest.source_artifacts.length > 0, `${relativePath} requires source_artifacts`);
  assertUnique(patchManifest.source_artifacts.map((artifact) => artifact?.role), `${relativePath} source roles`);
  for (const artifact of patchManifest.source_artifacts) {
    assertGameKnowledge(artifact.copy_policy === "hash_and_metadata_only", `${relativePath} source ${artifact.role} must use hash_and_metadata_only`);
    assertGameKnowledge(artifact.required === true, `${relativePath} source ${artifact.role} must be required`);
  }
  if (patchManifest.upstream_source !== undefined) {
    const upstream = patchManifest.upstream_source;
    assertGameKnowledge(typeof upstream.mode === "string" && upstream.mode.length > 0, `${relativePath} upstream_source requires mode`);
    assertGameKnowledge(typeof upstream.season_id === "string" && upstream.season_id.length > 0, `${relativePath} upstream_source requires season_id`);
    assertGameKnowledge(typeof upstream.data_version === "string" && upstream.data_version.length > 0, `${relativePath} upstream_source requires data_version`);
    const countKinds = ["champions", "traits", "augments", "equipment", "sprites"];
    assertGameKnowledge(countKinds.every((kind) => Number.isInteger(upstream.catalog_counts?.[kind]) && upstream.catalog_counts[kind] > 0), `${relativePath} upstream_source requires positive catalog_counts`);
  }
  if (patchManifest.hard_data_inheritance !== undefined) {
    const inheritance = patchManifest.hard_data_inheritance;
    const allowedRoles = new Set(["mechanics_parameters", "reward_tables"]);
    assertGameKnowledge(/^[a-f0-9]{64}$/.test(inheritance.generation_id || ""), `${relativePath} hard_data_inheritance generation_id is invalid`);
    assertGameKnowledge(inheritance.generation_id === patchManifest.parent_core_generation_id, `${relativePath} hard_data_inheritance must use parent_core_generation_id`);
    assertGameKnowledge(Array.isArray(inheritance.roles) && inheritance.roles.length > 0, `${relativePath} hard_data_inheritance requires roles`);
    assertGameKnowledge(inheritance.roles.every((role) => allowedRoles.has(role)), `${relativePath} hard_data_inheritance has unsupported roles`);
    assertUnique(inheritance.roles, `${relativePath} hard_data_inheritance roles`);
  }
  if (patchManifest.balance_patch !== undefined) {
    const balancePatch = patchManifest.balance_patch;
    const balanceSource = patchManifest.source_artifacts.find((artifact) => artifact.role === "balance_patch_overlay");
    assertGameKnowledge(balanceSource, `${relativePath} balance_patch requires a balance_patch_overlay source`);
    assertGameKnowledge(balancePatch.schema === "jcc-core-balance-patch-v1", `${relativePath} balance_patch has invalid schema`);
    assertGameKnowledge(typeof balancePatch.release_version === "string" && balancePatch.release_version.trim().length > 0, `${relativePath} balance_patch requires release_version`);
    assertGameKnowledge(balanceSource.expected_identity?.schema === balancePatch.schema, `${relativePath} balance patch source schema must match balance_patch`);
    assertGameKnowledge(balanceSource.expected_identity?.release_version === balancePatch.release_version, `${relativePath} balance patch source release must match balance_patch`);
    assertGameKnowledge(typeof patchManifest.release_version === "string" && patchManifest.release_version === balancePatch.release_version, `${relativePath} release_version must match balance_patch`);
    assertGameKnowledge(typeof patchManifest.parent_core_generation_id === "string" && /^[a-f0-9]{64}$/.test(patchManifest.parent_core_generation_id), `${relativePath} balance_patch requires a parent_core_generation_id`);
    assertGameKnowledge(balancePatch.baseline?.hard_data_generation_id === patchManifest.parent_core_generation_id, `${relativePath} balance patch baseline must match parent_core_generation_id`);
  }
  if (patchManifest.hard_data_candidate !== undefined) {
    const candidate = patchManifest.hard_data_candidate;
    assertGameKnowledge(candidate?.schema === "jcc-hard-data-candidate-reference-v1", `${relativePath} hard_data_candidate has invalid schema`);
    assertGameKnowledge(candidate.immutable === true && /^[a-f0-9]{64}$/.test(candidate.generation_id || ""), `${relativePath} hard_data_candidate must identify one immutable generation`);
    const expectedRoot = `data/core-patches/jcc/generations/${candidate.generation_id}`;
    assertGameKnowledge(candidate.generation_dir === expectedRoot, `${relativePath} hard_data_candidate generation_dir must match generation_id`);
    const generationArtifacts = patchManifest.source_artifacts.filter((artifact) => !EXTERNAL_PATCH_SOURCE_ROLES.has(artifact.role));
    assertGameKnowledge(
      generationArtifacts.every((artifact) => artifact.path === expectedRoot || artifact.path.startsWith(`${expectedRoot}/`)),
      `${relativePath} hard_data_candidate and source_artifacts must reference the same generation`,
    );
  }
  if (patchManifest.source_adapter !== undefined) {
    const adapter = patchManifest.source_adapter;
    const validateCommand = (command, label) => {
      assertGameKnowledge(typeof command === "string" && /^tools\/[A-Za-z0-9._/-]+\.mjs$/.test(command), `${relativePath} ${label} must be a repository tools/*.mjs command`);
      assertGameKnowledge(path.posix.normalize(command) === command && !command.split("/").includes(".."), `${relativePath} ${label} must not escape tools/`);
    };
    const validateArguments = (args, label) => {
      assertGameKnowledge(Array.isArray(args) && args.every((value) => typeof value === "string"), `${relativePath} ${label} arguments must be strings`);
    };
    assertGameKnowledge(adapter && typeof adapter === "object" && !Array.isArray(adapter), `${relativePath} source_adapter must be an object`);
    assertGameKnowledge(typeof adapter.id === "string" && adapter.id.trim().length > 0, `${relativePath} source_adapter requires an id`);
    validateCommand(adapter.command, "source_adapter command");
    validateArguments(adapter.arguments, "source_adapter");
    assertGameKnowledge(Array.isArray(adapter.verifiers) && adapter.verifiers.length > 0, `${relativePath} source_adapter requires verifiers`);
    for (const [index, verifier] of adapter.verifiers.entries()) {
      assertGameKnowledge(verifier && typeof verifier === "object" && !Array.isArray(verifier), `${relativePath} source_adapter verifier ${index} must be an object`);
      validateCommand(verifier.command, `source_adapter verifier ${index} command`);
      validateArguments(verifier.arguments, `source_adapter verifier ${index}`);
    }
  }
}

function assertCommonSeasonIsolation(commonArtifacts, seasonDescriptor) {
  const forbiddenKeys = /^(?:season_id|patch_id|game_mode_id|manual_variable_fields|season_entity_terms)$/;
  const terms = seasonDescriptor.season_entity_terms.map((term) => String(term).toLowerCase());
  const visit = (value, artifactPath, currentPath = []) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, artifactPath, [...currentPath, String(index)]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...currentPath, key];
      assertGameKnowledge(!forbiddenKeys.test(key), `${artifactPath} contains season-owned field ${childPath.join(".")}`);
      if (typeof child === "string") {
        const normalized = child.toLowerCase();
        for (const term of terms) {
          assertGameKnowledge(!normalized.includes(term), `${artifactPath} contains season entity term '${term}' at ${childPath.join(".")}`);
        }
        assertGameKnowledge(!/(?:^|\W)s\d+(?:_\d+)?(?:$|\W)/i.test(child), `${artifactPath} contains a season or patch identifier at ${childPath.join(".")}`);
      }
      visit(child, artifactPath, childPath);
    }
  };
  for (const artifact of commonArtifacts) visit(artifact.value, artifact.relativePath);
}

function buildEffectiveStandardMechanics(commonArtifacts, seasonDescriptor) {
  const standardDocument = commonArtifacts.find((artifact) => artifact.value.kind === "standard_mechanics")?.value;
  assertGameKnowledge(standardDocument, "common standard_mechanics document is missing");
  const byId = new Map(standardDocument.entries.map((entry) => [entry.id, structuredClone(entry)]));
  assertUnique([...byId.keys()], "common standard mechanic ids");

  for (const inheritedId of seasonDescriptor.inherits.standard_mechanics) {
    assertGameKnowledge(byId.has(inheritedId), `season inherits unknown standard mechanic: ${inheritedId}`);
  }
  const inherited = seasonDescriptor.inherits.standard_mechanics.map((id) => byId.get(id));
  for (const override of seasonDescriptor.standard_mechanics_overrides || []) {
    const target = byId.get(override?.mechanic_id);
    assertGameKnowledge(target, `season override targets unknown standard mechanic: ${override?.mechanic_id || "<missing>"}`);
    assertGameKnowledge(target.override_policy !== "forbid_season_override", `season override is forbidden for standard mechanic: ${override.mechanic_id}`);
    throw new Error(`JCC game knowledge: unsupported standard mechanic override: ${override.mechanic_id}`);
  }
  return inherited;
}

function validateCrossDocumentCollisions(commonArtifacts, seasonDescriptor) {
  assertUnique(commonArtifacts.map((artifact) => artifact.value.logical_id), "common document logical ids");
  assertUnique(commonArtifacts.map((artifact) => artifact.value.kind), "common document kinds");
  const knowledgeIds = [
    ...commonArtifacts.flatMap((artifact) => artifact.value.entries.map((entry) => entry.id)),
    ...seasonDescriptor.mechanics.map((mechanic) => mechanic.id),
  ];
  assertUnique(knowledgeIds, "knowledge ids");
}

async function resolveMetadataReference(repoRoot, reference, label) {
  assertGameKnowledge(reference && typeof reference === "object", `${label} must be an object`);
  assertGameKnowledge(reference.copy_policy === "hash_and_metadata_only", `${label} must use hash_and_metadata_only`);
  const artifact = await readJsonArtifact(repoRoot, reference.path, label);
  for (const [key, expectedValue] of Object.entries(reference.expected_identity || {})) {
    assertGameKnowledge(artifact.value?.[key] === expectedValue, `${label} expected ${key}=${expectedValue}`);
  }
  return {
    role: reference.role,
    path: artifact.relativePath,
    sha256: artifact.sha256,
    byte_size: artifact.byte_size,
    copy_policy: reference.copy_policy,
  };
}

async function deriveRuntimeIdentity({ repoRoot, seasonId, patchId, seasonDescriptor, patchManifest }) {
  const normalGameModeId = String(seasonDescriptor.runtime_contract?.normal_rules?.game_mode_id || "").trim();
  const specialGameModeId = String(seasonDescriptor.runtime_contract?.special_rules?.game_mode_id || "").trim();
  assertGameKnowledge(normalGameModeId, "season runtime contract requires normal_rules.game_mode_id");
  assertGameKnowledge(specialGameModeId === normalGameModeId, "season runtime contract game_mode_id values must agree");

  const hardDataReference = patchManifest.source_artifacts.find((artifact) => artifact.role === "hard_data_manifest");
  assertGameKnowledge(hardDataReference, "patch source manifest requires exactly one hard_data_manifest source");
  const hardDataArtifact = await readJsonArtifact(repoRoot, hardDataReference.path, "patch hard-data manifest");
  const hardDataManifest = hardDataArtifact.value;
  for (const field of ["packageId", "mode", "season", "version", "modeName", "runtime_patch_id"]) {
    assertGameKnowledge(String(hardDataManifest?.[field] || "").trim(), `patch hard-data manifest requires ${field}`);
  }
  assertGameKnowledge(hardDataManifest.runtime_patch_id === patchId, "patch hard-data manifest runtime_patch_id must match the compiled patch");
  assertGameKnowledge(normalGameModeId === `jcc-mode${hardDataManifest.mode}`, "season game_mode_id must match the hard-data manifest mode");

  return validateGameKnowledgeRuntimeIdentity({
    schema: GAME_KNOWLEDGE_RUNTIME_IDENTITY_SCHEMA,
    season_id: seasonId,
    patch_id: patchId,
    game_mode_id: normalGameModeId,
    package_id: createRuntimeLocalPackageId(seasonId, patchId),
    source_package_id: hardDataManifest.source_package_id || hardDataManifest.packageId,
    hard_data_manifest: hardDataArtifact.relativePath,
    upstream_identity: {
      mode: String(hardDataManifest.upstream_provenance?.mode || hardDataManifest.mode),
      season: String(hardDataManifest.upstream_provenance?.season || hardDataManifest.upstream_provenance?.season_id || hardDataManifest.season),
      version: String(hardDataManifest.upstream_provenance?.version || hardDataManifest.upstream_provenance?.data_version || hardDataManifest.version),
      framework_name: String(hardDataManifest.upstream_provenance?.framework_name || hardDataManifest.modeName),
    },
  }, { label: "compiled Core Profile runtime identity" });
}

async function loadDecisionInputSources({ repoRoot, patchManifest }) {
  const sourceByRole = new Map(patchManifest.source_artifacts.map((artifact) => [artifact.role, artifact]));
  const hardDataReference = sourceByRole.get("hard_data_manifest");
  const stageAuthorityReference = sourceByRole.get("augment_stage_authority");
  const traitRosterSupportReference = sourceByRole.get("trait_diversity_roster_support");
  const playerAliasReference = sourceByRole.get("patch_player_aliases");
  const itemUsageTaxonomyReference = sourceByRole.get("item_usage_taxonomy");
  assertGameKnowledge(hardDataReference, "patch source manifest requires hard_data_manifest for the decision-input catalog");
  assertGameKnowledge(stageAuthorityReference, "patch source manifest requires augment_stage_authority for the decision-input catalog");
  assertGameKnowledge(playerAliasReference, "patch source manifest requires patch_player_aliases for current-version entity aliases");
  const hardDataManifestArtifact = await readJsonArtifact(repoRoot, hardDataReference.path, "decision-input hard-data manifest");
  const hardDataDir = path.posix.dirname(hardDataManifestArtifact.relativePath);
  const optionalArtifact = async (relativePath, label, fallbackValue) => {
    try {
      await stat(path.join(repoRoot, ...relativePath.split("/")));
    } catch (error) {
      if (error?.code === "ENOENT") return {
        absolutePath: null,
        relativePath: null,
        value: fallbackValue,
        byte_size: 0,
        sha256: null,
      };
      throw error;
    }
    return readJsonArtifact(repoRoot, relativePath, label);
  };
  const [championsArtifact, augmentsArtifact, itemsArtifact, traitsArtifact, mechanicsArtifact, rewardTablesArtifact, traitRosterSupportArtifact, aliasArtifact, stageAuthorityArtifact, playerAliasArtifact, itemUsageTaxonomyArtifact] = await Promise.all([
    readJsonArtifact(repoRoot, path.posix.join(hardDataDir, "normalized/champions.json"), "semantic-feature champions"),
    readJsonArtifact(repoRoot, path.posix.join(hardDataDir, "normalized/augments.json"), "decision-input augments"),
    readJsonArtifact(repoRoot, path.posix.join(hardDataDir, "normalized/items.json"), "decision-input items"),
    readJsonArtifact(repoRoot, path.posix.join(hardDataDir, "normalized/traits.json"), "hard-data query traits"),
    optionalArtifact(path.posix.join(hardDataDir, "normalized/mechanics_parameters.json"), "hard-data query mechanics", {}),
    optionalArtifact(path.posix.join(hardDataDir, "normalized/reward_tables.json"), "hard-data query reward tables", {
      entity_tables: [],
      season_tables: [],
      supplemental_unbound_tables: [],
      exclusions: [],
    }),
    traitRosterSupportReference
      ? readJsonArtifact(repoRoot, traitRosterSupportReference.path, "hard-data trait-diversity roster support")
      : Promise.resolve(null),
    readJsonArtifact(repoRoot, path.posix.join(hardDataDir, "indexes/entity_alias_gateway.json"), "decision-input entity aliases"),
    readJsonArtifact(repoRoot, stageAuthorityReference.path, "decision-input augment stage authority"),
    readJsonArtifact(repoRoot, playerAliasReference.path, "patch player entity aliases"),
    itemUsageTaxonomyReference
      ? readJsonArtifact(repoRoot, itemUsageTaxonomyReference.path, "patch item usage taxonomy")
      : Promise.resolve(null),
  ]);
  return {
    hardDataManifestArtifact,
    championsArtifact,
    augmentsArtifact,
    itemsArtifact,
    traitsArtifact,
    mechanicsArtifact,
    rewardTablesArtifact,
    traitRosterSupportArtifact,
    aliasArtifact,
    stageAuthorityArtifact,
    playerAliasArtifact,
    itemUsageTaxonomyArtifact,
  };
}

export function compileEntityAliasGateway({
  seasonId,
  patchId,
  baseGateway,
  champions,
  items,
  augments,
  traits,
  commonAliasDocument,
  patchAliasDocument,
}) {
  assertGameKnowledge(commonAliasDocument?.kind === "equipment_player_aliases", "Common equipment player aliases are required");
  assertGameKnowledge(patchAliasDocument?.schema === "jcc-patch-player-entity-aliases-v1", "patch player aliases have an invalid schema");
  assertGameKnowledge(patchAliasDocument?.identity?.season_id === seasonId, "patch player aliases have the wrong season identity");
  assertGameKnowledge(patchAliasDocument?.identity?.patch_id === patchId, "patch player aliases have the wrong patch identity");

  const gateway = structuredClone(baseGateway || {});
  gateway.lookup = gateway.lookup || {};
  gateway.by_kind_and_name = gateway.by_kind_and_name || {};
  const catalogs = {
    champion: champions || [],
    item: items || [],
    augment: augments || [],
    trait: traits || [],
  };
  const byKindAndId = new Map();
  const byKindAndName = new Map();
  for (const [kind, rows] of Object.entries(catalogs)) {
    for (const entity of rows) {
      const id = String(entity?.id || "").trim();
      const name = compactDecisionInputText(entity?.name);
      if (id) byKindAndId.set(`${kind}:${id}`, entity);
      if (name) byKindAndName.set(`${kind}:${name}`, [...(byKindAndName.get(`${kind}:${name}`) || []), entity]);
    }
  }

  const auditRows = [];
  const addAlias = ({ entity, kind, alias, source, declarationId }) => {
    const normalizedAlias = compactDecisionInputText(alias);
    if (!normalizedAlias) return;
    const key = `${kind}:${normalizedAlias}`;
    const existing = gateway.lookup[key] || { n: normalizedAlias, ids: [], r: [], ambiguous: false };
    const refs = Array.isArray(existing.r) ? [...existing.r] : [];
    const entityId = String(entity.id);
    const conflictingIds = new Set(refs.map((row) => String(row.entity_id)).filter((id) => id !== entityId));
    assertGameKnowledge(conflictingIds.size === 0, `player alias ${alias} is ambiguous for ${kind}`);
    if (!refs.some((row) => String(row.entity_id) === entityId && compactDecisionInputText(row.alias) === normalizedAlias)) {
      refs.push({
        entity_kind: kind,
        entity_id: entityId,
        entity_address: entity.address,
        entity_name: entity.name,
        alias: String(alias),
        alias_class: "player_alias",
        declaration_id: declarationId,
        source,
      });
    }
    const ids = [...new Set(refs.map((row) => String(row.entity_id)))].sort();
    gateway.lookup[key] = { n: normalizedAlias, ids, r: refs, ambiguous: ids.length > 1 };
  };

  const bindEntry = (entry, { source, required }) => {
    const kind = String(entry?.entity_kind || "").trim();
    assertGameKnowledge(Object.hasOwn(catalogs, kind), `${source} alias ${entry?.id || "<missing>"} has unsupported entity_kind`);
    const canonicalId = String(entry?.canonical_id || "").trim();
    const canonicalName = compactDecisionInputText(entry?.canonical_name);
    const candidates = canonicalId
      ? [byKindAndId.get(`${kind}:${canonicalId}`)].filter(Boolean)
      : (byKindAndName.get(`${kind}:${canonicalName}`) || []);
    const categoryMatches = candidates.length === 1
      && (!entry?.category || kind !== "item" || classifyDecisionInputItemCategory(candidates[0]) === entry.category);
    if (candidates.length !== 1 || (canonicalName && compactDecisionInputText(candidates[0]?.name) !== canonicalName) || !categoryMatches) {
      assertGameKnowledge(!required, `${source} alias ${entry?.id || "<missing>"} must bind one current Core entity`);
      auditRows.push({
        declaration_id: entry?.id || null,
        source,
        entity_kind: kind,
        canonical_name: entry?.canonical_name || null,
        status: "unbound_current_core",
        reason: candidates.length === 1 && !categoryMatches ? "category_mismatch" : "entity_not_uniquely_bound",
      });
      return;
    }
    const entity = candidates[0];
    const aliases = [...new Set((entry.aliases || []).map((alias) => String(alias || "").trim()).filter(Boolean))];
    assertGameKnowledge(aliases.length > 0, `${source} alias ${entry?.id || "<missing>"} requires aliases`);
    for (const alias of aliases) addAlias({ entity, kind, alias, source, declarationId: entry.id });
    auditRows.push({ declaration_id: entry.id, source, entity_kind: kind, entity_id: String(entity.id), canonical_name: entity.name, aliases, status: "bound" });

    if (kind === "item" && entry.generate_radiant_aliases === true) {
      const radiantName = compactDecisionInputText(`光明版${entry.canonical_name}`);
      const radiantCandidates = byKindAndName.get(`item:${radiantName}`) || [];
      if (radiantCandidates.length === 1 && classifyDecisionInputItemCategory(radiantCandidates[0]) === "radiant") {
        const radiantAliases = aliases.map((alias) => `光明${alias}`);
        for (const alias of radiantAliases) addAlias({ entity: radiantCandidates[0], kind, alias, source, declarationId: entry.id });
        auditRows.push({
          declaration_id: `${entry.id}.radiant`,
          source,
          entity_kind: kind,
          entity_id: String(radiantCandidates[0].id),
          canonical_name: radiantCandidates[0].name,
          aliases: radiantAliases,
          status: "bound_generated_radiant_aliases",
        });
      }
    }
  };

  for (const entry of commonAliasDocument.entries || []) bindEntry(entry, { source: "common.equipment_player_aliases", required: false });
  for (const entry of patchAliasDocument.entries || []) bindEntry(entry, { source: `patch.${patchId}.player_entity_aliases`, required: true });

  const bound = auditRows.filter((row) => row.status.startsWith("bound")).length;
  const unbound = auditRows.length - bound;
  return {
    ...gateway,
    schema: "jcc-compiled-entity-alias-gateway-v1",
    identity: { season_id: seasonId, patch_id: patchId },
    declared_alias_audit: {
      schema: "jcc-compiled-player-alias-audit-v1",
      counts: { declarations: auditRows.length, bound, unbound },
      entries: auditRows,
      policy: {
        aliases_do_not_create_entities: true,
        common_unbound_aliases_remain_inactive: true,
        patch_aliases_must_bind: true,
        canonical_ids_and_names_remain_persistence_authority: true,
      },
    },
  };
}

function buildHardDataQueryIndex({ seasonId, patchId, coreProfileId, sources }) {
  const rewardTables = sources.rewardTablesArtifact.value;
  const aliasRows = Object.values(sources.aliasArtifact.value?.lookup || {});
  const aliasesByEntity = new Map();
  for (const row of aliasRows) {
    for (const ref of row?.r || []) {
      const key = `${ref.entity_kind}:${ref.entity_id}`;
      const aliases = aliasesByEntity.get(key) || new Set();
      if (row.n) aliases.add(row.n);
      aliasesByEntity.set(key, aliases);
    }
  }
  const withAliases = (table) => {
    const ref = table.entity_ref;
    const key = `${ref?.kind}:${ref?.id}`;
    return {
      ...table,
      aliases: [...new Set([
        ref?.name,
        table.source_key,
        ...(aliasesByEntity.get(key) || []),
      ].filter(Boolean))],
    };
  };
  return {
    schema: 'jcc-hard-data-query-index-v1',
    identity: { season_id: seasonId, patch_id: patchId, core_profile_id: coreProfileId },
    entity_reward_tables: (rewardTables.entity_tables || []).map(withAliases),
    season_reward_tables: rewardTables.season_tables || [],
    supplemental_named_reward_tables: rewardTables.supplemental_unbound_tables || [],
    excluded_source_tables: rewardTables.exclusions || [],
    trait_diversity_roster_support: sources.traitRosterSupportArtifact ? {
      schema: sources.traitRosterSupportArtifact.value?.schema || null,
      roster_support_id: sources.traitRosterSupportArtifact.value?.roster_support_id || null,
      source_ref: {
        path: sources.traitRosterSupportArtifact.relativePath,
        sha256: sources.traitRosterSupportArtifact.sha256,
        byte_size: sources.traitRosterSupportArtifact.byte_size,
      },
      objective_definitions: sources.traitRosterSupportArtifact.value?.objective_definitions || [],
      augment_bindings: sources.traitRosterSupportArtifact.value?.augment_bindings || [],
      support_keys: sources.traitRosterSupportArtifact.value?.support_keys || [],
      populations: sources.traitRosterSupportArtifact.value?.populations || [],
      counts: sources.traitRosterSupportArtifact.value?.counts || {},
      policy: sources.traitRosterSupportArtifact.value?.policy || {},
    } : null,
    mechanics: {
      progression: sources.mechanicsArtifact.value?.progression || null,
      shop: sources.mechanicsArtifact.value?.shop || null,
      player_damage: sources.mechanicsArtifact.value?.player_damage || null,
      economy: sources.mechanicsArtifact.value?.economy || null,
      augment_tier_sequence_probabilities: sources.mechanicsArtifact.value?.augment_tier_sequence_probabilities || null,
      source_comparison: sources.mechanicsArtifact.value?.source_comparison || null,
    },
    trait_refs: Object.fromEntries((sources.traitsArtifact.value || []).map((trait) => [trait.name, {
      id: trait.id,
      address: trait.address,
      name: trait.name,
      reward_table_ref: trait.reward_table_ref || null,
    }])),
    policy: {
      official_entity_membership_only: true,
      supplemental_named_tables_do_not_establish_catalog_legality: true,
      reward_outcomes_are_atomic_bundles: true,
      full_index_is_runtime_internal_and_never_static_capsule_content: true,
    },
  };
}

async function compileDecisionInputCatalog({
  repoRoot,
  seasonId,
  patchId,
  seasonDescriptor,
  patchManifest,
  runtimeIdentity,
  coreProfileId,
  sources,
  entityAliasGateway,
}) {
  const {
    hardDataManifestArtifact,
    augmentsArtifact,
    itemsArtifact,
    stageAuthorityArtifact,
    itemUsageTaxonomyArtifact,
  } = sources;
  const normalRules = seasonDescriptor.runtime_contract.normal_rules;
  const specialRules = seasonDescriptor.runtime_contract.special_rules;
  const manifest = hardDataManifestArtifact.value;
  const catalogSourceFingerprint = sha256(stableDecisionInputSourceJson({
    manifest,
    champions: sources.championsArtifact.value,
    augments: augmentsArtifact.value,
    items: itemsArtifact.value,
    item_usage_taxonomy: itemUsageTaxonomyArtifact?.value || null,
    entity_alias_gateway: entityAliasGateway,
    augment_stage_authority: stageAuthorityArtifact.value,
    normal_rules: normalRules,
    special_rules: specialRules,
  }));
  const catalog = buildDecisionInputCatalogFromSources({
    seasonId,
    activePatchId: patchId,
    hardDataSourceRef: `core_profile_hard_data_manifest:${runtimeIdentity.hard_data_manifest}`,
    hardDataManifestFingerprint: sha256(stableDecisionInputSourceJson(manifest)),
    catalogSourceFingerprint,
    manifest,
    champions: sources.championsArtifact.value,
    augments: augmentsArtifact.value,
    items: itemsArtifact.value,
    itemUsageTaxonomy: itemUsageTaxonomyArtifact?.value || null,
    entityAliasGateway,
    augmentStageAuthority: stageAuthorityArtifact.value,
    normalRules,
    specialRules,
  });
  catalog.generated_at = null;
  catalog.source_identity.core_profile_id = coreProfileId;
  catalog.content_hash = sha256(JSON.stringify({
    source_identity: catalog.source_identity,
    choice_descriptors: catalog.choice_descriptors,
    item_categories: catalog.item_categories,
    entities: catalog.entities.map((entity) => [entity.kind, entity.id, entity.address, entity.name, entity.cost, entity.trait_names, entity.rounds, entity.item_category, entity.item_subtype, entity.primary_role, entity.browse_facets, entity.usage_taxonomy_status, entity.stage_num, entity.stage_unknown, entity.generated_only, entity.category_ids, entity.category_labels, entity.category_source]),
    aliases: catalog.aliases.map((alias) => [alias.ref.kind, alias.ref.id, alias.alias, alias.evidence_kind]),
    unknown_round_audit: catalog.choice_descriptors.augment.unknown_round_audit,
  }));
  return {
    catalog,
    augmentStageAuthority: stageAuthorityArtifact.value,
  };
}

function artifactMetadata(artifact) {
  return {
    path: artifact.relativePath,
    logical_id: artifact.value.logical_id || artifact.value.$id || null,
    sha256: artifact.sha256,
    byte_size: artifact.byte_size,
  };
}

async function writeImmutableArtifact(artifactFile, serializedArtifact) {
  await mkdir(path.dirname(artifactFile), { recursive: true });
  try {
    const current = await readFile(artifactFile, "utf8");
    assertGameKnowledge(current === serializedArtifact, `immutable generated artifact differs at ${artifactFile}`);
    return "unchanged";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await writeFile(artifactFile, serializedArtifact, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = await readFile(artifactFile, "utf8");
    assertGameKnowledge(current === serializedArtifact, `immutable generated artifact raced with different content at ${artifactFile}`);
    return "unchanged";
  }
}

async function writeCandidateProfile(candidateFile, serializedProfile) {
  await mkdir(path.dirname(candidateFile), { recursive: true });
  const tempFile = `${candidateFile}.${process.pid}.tmp`;
  await writeFile(tempFile, serializedProfile, "utf8");
  await rename(tempFile, candidateFile);
}

export async function resolveCompilerImplementationIdentity(repoRoot = path.resolve(import.meta.dirname, "..")) {
  const files = await Promise.all(COMPILER_IMPLEMENTATION_PATHS.map(async (relativePath) => {
    const absolutePath = resolveContainedPath(repoRoot, path.join(repoRoot, relativePath), `compiler implementation ${relativePath}`);
    const content = await readFile(absolutePath, "utf8");
    return {
      path: relativePath,
      sha256: sha256(content),
      byte_size: Buffer.byteLength(content),
    };
  }));
  return {
    schema: "jcc-game-knowledge-compiler-implementation-identity-v1",
    files,
    combined_sha256: sha256(stableJson(files, 0)),
  };
}

export async function compileGameKnowledge({
  repoRoot = path.resolve(import.meta.dirname, ".."),
  knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc"),
  seasonId = null,
  patchId = null,
  outputRoot = path.join(knowledgeRoot, "generated"),
  candidateProfilePath = path.join(knowledgeRoot, "candidates", "candidate-profile.json"),
  expectedCoreProfileId = null,
  write = true,
} = {}) {
  assertGameKnowledge(/^s\d+$/.test(String(seasonId || "")), "compiler requires an explicit season id");
  assertGameKnowledge(/^s\d+_\d+$/.test(String(patchId || "")), "compiler requires an explicit patch id");
  const rootManifest = await readJsonArtifact(knowledgeRoot, "manifest.json", "root manifest");
  validateManifest(rootManifest.value);
  const expectedOutputRoot = resolveContainedPath(knowledgeRoot, path.join(knowledgeRoot, rootManifest.value.generation.bundle_directory), "manifest generated output root");
  const expectedCandidateProfilePath = resolveContainedPath(knowledgeRoot, path.join(knowledgeRoot, rootManifest.value.generation.candidate_profile), "manifest candidate profile path");
  const safeOutputRoot = resolveContainedPath(knowledgeRoot, outputRoot, "generated output root");
  const safeCandidateProfilePath = resolveContainedPath(knowledgeRoot, candidateProfilePath, "candidate profile path");
  assertGameKnowledge(safeOutputRoot === expectedOutputRoot, "generated output root must match the manifest candidate location");
  assertGameKnowledge(safeCandidateProfilePath === expectedCandidateProfilePath, "candidate profile path must match the manifest candidate location");
  const seasonPath = rootManifest.value.season_descriptors?.[seasonId];
  const patchPath = rootManifest.value.patch_manifests?.[patchId];
  assertGameKnowledge(seasonPath, `no season descriptor registered for ${seasonId}`);
  assertGameKnowledge(patchPath, `no patch source manifest registered for ${patchId}`);

  const commonArtifacts = await Promise.all(rootManifest.value.common_documents.map((relativePath) => readJsonArtifact(knowledgeRoot, relativePath, `common document ${relativePath}`)));
  const schemaArtifacts = await Promise.all(rootManifest.value.schemas.map((relativePath) => readJsonArtifact(knowledgeRoot, relativePath, `schema ${relativePath}`)));
  const seasonArtifact = await readJsonArtifact(knowledgeRoot, seasonPath, `season descriptor ${seasonId}`);
  const patchArtifact = await readJsonArtifact(knowledgeRoot, patchPath, `patch source manifest ${patchId}`);

  validateSchemaArtifacts(schemaArtifacts);
  commonArtifacts.forEach((artifact) => validateCommonDocument(artifact.value, artifact.relativePath));
  validateSeasonDescriptor(seasonArtifact.value, seasonId, seasonArtifact.relativePath);
  validatePatchManifest(patchArtifact.value, seasonId, patchId, patchArtifact.relativePath);
  assertCommonSeasonIsolation(commonArtifacts, seasonArtifact.value);
  validateCrossDocumentCollisions(commonArtifacts, seasonArtifact.value);
  assertNoForeignLocalSeasonIdentifiers([
    ...commonArtifacts.map((artifact) => ({ label: artifact.relativePath, value: artifact.value })),
    { label: seasonArtifact.relativePath, value: seasonArtifact.value },
    { label: patchArtifact.relativePath, value: { logical_id: patchArtifact.value.logical_id } },
  ], seasonId);

  const effectiveStandardMechanics = buildEffectiveStandardMechanics(commonArtifacts, seasonArtifact.value);
  const seasonSources = await Promise.all((seasonArtifact.value.source_references || []).map((reference, index) => resolveMetadataReference(repoRoot, reference, `season source ${index}`)));
  const patchSources = await Promise.all(patchArtifact.value.source_artifacts.map((reference, index) => resolveMetadataReference(repoRoot, reference, `patch source ${index}`)));
  const decisionInputSources = await loadDecisionInputSources({
    repoRoot,
    patchManifest: patchArtifact.value,
  });
  const runtimeIdentity = await deriveRuntimeIdentity({
    repoRoot,
    seasonId,
    patchId,
    seasonDescriptor: seasonArtifact.value,
    patchManifest: patchArtifact.value,
  });
  const compilerImplementationIdentity = await resolveCompilerImplementationIdentity(repoRoot);

  const inputArtifacts = [rootManifest, ...commonArtifacts, ...schemaArtifacts, seasonArtifact, patchArtifact]
    .map(artifactMetadata)
    .sort((left, right) => left.path.localeCompare(right.path));
  const externalSources = [...seasonSources, ...patchSources].sort((left, right) => `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`));
  const consumedPayloads = Object.values(decisionInputSources)
    .filter((artifact) => artifact?.relativePath)
    .map(artifactMetadata)
    .sort((left, right) => left.path.localeCompare(right.path));
  const fingerprintInput = {
    compiler_schema: COMPILER_SCHEMA,
    compiler_revision: COMPILER_REVISION,
    compiler_implementation_identity: compilerImplementationIdentity,
    profile: { season_id: seasonId, patch_id: patchId },
    runtime_identity: runtimeIdentity,
    input_artifacts: inputArtifacts,
    external_sources: externalSources,
    consumed_payloads: consumedPayloads,
  };
  const combinedFingerprint = sha256(stableJson(fingerprintInput, 0));
  if (expectedCoreProfileId !== null) {
    assertGameKnowledge(/^[a-f0-9]{64}$/.test(String(expectedCoreProfileId)), "expected Core Profile id must be a lowercase SHA-256 value");
    assertGameKnowledge(combinedFingerprint === expectedCoreProfileId, `compiled Core Profile id ${combinedFingerprint} does not match expected ${expectedCoreProfileId}`);
  }

  const commonByKind = Object.fromEntries(commonArtifacts.map((artifact) => [artifact.value.kind, artifact.value]));
  const entityAliasGateway = compileEntityAliasGateway({
    seasonId,
    patchId,
    baseGateway: decisionInputSources.aliasArtifact.value,
    champions: decisionInputSources.championsArtifact.value,
    items: decisionInputSources.itemsArtifact.value,
    augments: decisionInputSources.augmentsArtifact.value,
    traits: decisionInputSources.traitsArtifact.value,
    commonAliasDocument: commonByKind.equipment_player_aliases,
    patchAliasDocument: decisionInputSources.playerAliasArtifact.value,
  });
  const decisionInputCompilation = await compileDecisionInputCatalog({
    repoRoot,
    seasonId,
    patchId,
    seasonDescriptor: seasonArtifact.value,
    patchManifest: patchArtifact.value,
    runtimeIdentity,
    coreProfileId: combinedFingerprint,
    sources: decisionInputSources,
    entityAliasGateway,
  });
  const decisionInputCatalog = decisionInputCompilation.catalog;
  const hardDataQueryIndex = buildHardDataQueryIndex({
    seasonId,
    patchId,
    coreProfileId: combinedFingerprint,
    sources: decisionInputSources,
  });
  const augmentStageAuthority = {
    ...decisionInputCompilation.augmentStageAuthority,
    source_identity: structuredClone(decisionInputCatalog.source_identity),
    immutable_core_profile_artifact: true,
  };
  const runtimeCatalogReference = patchArtifact.value.source_artifacts
    .find((artifact) => artifact.role === "runtime_catalog_overlay");
  assertGameKnowledge(runtimeCatalogReference, "patch source manifest requires one runtime_catalog_overlay source");
  const runtimeCatalogSource = await readJsonArtifact(repoRoot, runtimeCatalogReference.path, "patch runtime catalog overlay");
  const runtimeCatalogOverlay = {
    ...runtimeCatalogSource.value,
    schema: "jcc-runtime-catalog-overlay-v1",
    source_identity: structuredClone(decisionInputCatalog.source_identity),
    source_overlay_schema: runtimeCatalogSource.value.schema,
    immutable_core_profile_artifact: true,
  };

  const semanticFeatureIndex = compileCoreSemanticFeatureIndex({
    commonSemanticDocument: commonByKind.semantic_features,
    champions: decisionInputSources.championsArtifact.value,
    items: decisionInputSources.itemsArtifact.value,
    augments: decisionInputSources.augmentsArtifact.value,
    traits: decisionInputSources.traitsArtifact.value,
    rewardTables: hardDataQueryIndex.entity_reward_tables,
    identity: {
      season_id: seasonId,
      patch_id: patchId,
      core_profile_id: combinedFingerprint,
      ranking_overlay_id: null,
    },
  });
  const bundle = {
    schema: "jcc-game-knowledge-bundle-v1",
    compiler_schema: COMPILER_SCHEMA,
    compiler_revision: COMPILER_REVISION,
    compiler_implementation_identity: compilerImplementationIdentity,
    combined_fingerprint: combinedFingerprint,
    immutable: true,
    profile: { season_id: seasonId, patch_id: patchId },
    runtime_identity: runtimeIdentity,
    common: commonByKind,
    effective_standard_mechanics: effectiveStandardMechanics,
    season: seasonArtifact.value,
    patch: patchArtifact.value,
    entity_alias_gateway: entityAliasGateway,
    hard_data_query_index: hardDataQueryIndex,
    semantic_feature_index: semanticFeatureIndex,
    schemas: Object.fromEntries(schemaArtifacts.map((artifact) => [artifact.value.$id, artifact.value])),
    source_metadata: {
      authored_inputs: inputArtifacts,
      referenced_sources: externalSources,
      consumed_payloads: consumedPayloads,
      referenced_payloads_embedded: false,
    },
  };
  const serializedBundle = stableJson(bundle);
  const bundleBytes = Buffer.byteLength(serializedBundle);
  const bundleSha256 = sha256(serializedBundle);
  const bundleFile = path.join(safeOutputRoot, combinedFingerprint, "bundle.json");
  const decisionInputCatalogFile = path.join(safeOutputRoot, combinedFingerprint, "decision-input-catalog.json");
  const augmentStageAuthorityFile = path.join(safeOutputRoot, combinedFingerprint, "augment-stage-authority.json");
  const runtimeCatalogOverlayFile = path.join(safeOutputRoot, combinedFingerprint, "runtime-catalog-overlay.json");
  const semanticFeatureIndexFile = path.join(safeOutputRoot, combinedFingerprint, "semantic-feature-index.json");
  const serializedDecisionInputCatalog = stableJson(decisionInputCatalog);
  const serializedAugmentStageAuthority = stableJson(augmentStageAuthority);
  const serializedRuntimeCatalogOverlay = stableJson(runtimeCatalogOverlay);
  const serializedSemanticFeatureIndex = stableJson(semanticFeatureIndex);
  const decisionInputCatalogBytes = Buffer.byteLength(serializedDecisionInputCatalog);
  const decisionInputCatalogSha256 = sha256(serializedDecisionInputCatalog);
  const augmentStageAuthorityBytes = Buffer.byteLength(serializedAugmentStageAuthority);
  const augmentStageAuthoritySha256 = sha256(serializedAugmentStageAuthority);
  const runtimeCatalogOverlayBytes = Buffer.byteLength(serializedRuntimeCatalogOverlay);
  const runtimeCatalogOverlaySha256 = sha256(serializedRuntimeCatalogOverlay);
  const semanticFeatureIndexBytes = Buffer.byteLength(serializedSemanticFeatureIndex);
  const semanticFeatureIndexSha256 = sha256(serializedSemanticFeatureIndex);
  const candidateProfile = {
    schema: "jcc-game-knowledge-candidate-profile-v1",
    status: "candidate_not_promoted",
    production_switch_requested: false,
    activation_blockers: [...new Set(patchArtifact.value.activation_blockers || [])].sort(),
    season_id: seasonId,
    patch_id: patchId,
    runtime_identity: runtimeIdentity,
    combined_fingerprint: combinedFingerprint,
    bundle_path: path.relative(knowledgeRoot, bundleFile).replaceAll("\\", "/"),
    bundle_sha256: bundleSha256,
    bundle_byte_size: bundleBytes,
    decision_input_catalog_path: path.relative(knowledgeRoot, decisionInputCatalogFile).replaceAll("\\", "/"),
    decision_input_catalog_sha256: decisionInputCatalogSha256,
    decision_input_catalog_byte_size: decisionInputCatalogBytes,
    augment_stage_authority_path: path.relative(knowledgeRoot, augmentStageAuthorityFile).replaceAll("\\", "/"),
    augment_stage_authority_sha256: augmentStageAuthoritySha256,
    augment_stage_authority_byte_size: augmentStageAuthorityBytes,
    runtime_catalog_overlay_path: path.relative(knowledgeRoot, runtimeCatalogOverlayFile).replaceAll("\\", "/"),
    runtime_catalog_overlay_sha256: runtimeCatalogOverlaySha256,
    runtime_catalog_overlay_byte_size: runtimeCatalogOverlayBytes,
    semantic_feature_index_path: path.relative(knowledgeRoot, semanticFeatureIndexFile).replaceAll("\\", "/"),
    semantic_feature_index_sha256: semanticFeatureIndexSha256,
    semantic_feature_index_byte_size: semanticFeatureIndexBytes,
  };

  let writeStatus = "not_written";
  if (write) {
    const bundleWriteStatus = await writeImmutableArtifact(bundleFile, serializedBundle);
    const catalogWriteStatus = await writeImmutableArtifact(decisionInputCatalogFile, serializedDecisionInputCatalog);
    const stageAuthorityWriteStatus = await writeImmutableArtifact(augmentStageAuthorityFile, serializedAugmentStageAuthority);
    const runtimeCatalogWriteStatus = await writeImmutableArtifact(runtimeCatalogOverlayFile, serializedRuntimeCatalogOverlay);
    const semanticFeatureWriteStatus = await writeImmutableArtifact(semanticFeatureIndexFile, serializedSemanticFeatureIndex);
    writeStatus = bundleWriteStatus === "created" || catalogWriteStatus === "created" || stageAuthorityWriteStatus === "created" || runtimeCatalogWriteStatus === "created" || semanticFeatureWriteStatus === "created"
      ? "created"
      : "unchanged";
    await writeCandidateProfile(safeCandidateProfilePath, stableJson(candidateProfile));
  }
  return {
    combinedFingerprint,
    bundle,
    bundleFile,
    bundleSha256,
    bundleBytes,
    decisionInputCatalog,
    decisionInputCatalogFile,
    decisionInputCatalogSha256,
    decisionInputCatalogBytes,
    augmentStageAuthority,
    augmentStageAuthorityFile,
    augmentStageAuthoritySha256,
    augmentStageAuthorityBytes,
    runtimeCatalogOverlay,
    runtimeCatalogOverlayFile,
    runtimeCatalogOverlaySha256,
    runtimeCatalogOverlayBytes,
    semanticFeatureIndex,
    semanticFeatureIndexFile,
    semanticFeatureIndexSha256,
    semanticFeatureIndexBytes,
    candidateProfile,
    candidateProfilePath: safeCandidateProfilePath,
    writeStatus,
  };
}

function parseArguments(argv) {
  const options = { write: false };
  const explicit = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--no-write") options.write = false;
    else if (argument === "--repo-root") options.repoRoot = path.resolve(argv[++index]);
    else if (argument === "--knowledge-root") options.knowledgeRoot = path.resolve(argv[++index]);
    else if (argument === "--output-root") options.outputRoot = path.resolve(argv[++index]);
    else if (argument === "--candidate-manifest" || argument === "--candidate-profile") {
      options.candidateProfilePath = path.resolve(argv[++index]);
      explicit.add("candidate-manifest");
    } else if (argument === "--expected-core-profile-id") {
      options.expectedCoreProfileId = argv[++index];
      explicit.add("expected-core-profile-id");
    } else if (argument === "--season") {
      options.seasonId = argv[++index];
      explicit.add("season");
    } else if (argument === "--patch") {
      options.patchId = argv[++index];
      explicit.add("patch");
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const required = options.write
    ? ["candidate-manifest", "expected-core-profile-id", "season", "patch"]
    : ["season", "patch"];
  {
    const missing = required.filter((field) => !explicit.has(field));
    if (missing.length > 0) {
      throw new Error(`${options.write ? "Production compiler writes" : "Compiler reads"} require explicit ${missing.join(", ")}`);
    }
  }
  return options;
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const result = await compileGameKnowledge(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({
    ok: true,
    schema: COMPILER_SCHEMA,
    combined_fingerprint: result.combinedFingerprint,
    bundle_path: result.bundleFile,
    bundle_sha256: result.bundleSha256,
    bundle_byte_size: result.bundleBytes,
    candidate_profile_path: result.candidateProfilePath,
    write_status: result.writeStatus,
  }, null, 2));
}
