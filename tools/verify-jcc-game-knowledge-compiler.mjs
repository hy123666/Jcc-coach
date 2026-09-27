import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { compileGameKnowledge, resolveCompilerImplementationIdentity } from "./jcc_game_knowledge_compiler.mjs";
import { stableJson } from "./jcc_game_knowledge_helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceKnowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");
const seasonId = "s18";
const patchId = "s18_1";
const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(action, pattern, label) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${label} must fail closed`);
  assert(pattern.test(String(caught.message || caught)), `${label} failed for the wrong reason: ${caught.message || caught}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stableJson(value), "utf8");
}

async function compileFixture(knowledgeRoot) {
  return compileGameKnowledge({ repoRoot, knowledgeRoot, seasonId, patchId });
}

async function copyKnowledgeFixture(tempRoot, name) {
  const target = path.join(tempRoot, name);
  await cp(sourceKnowledgeRoot, target, { recursive: true });
  await Promise.all([
    rm(path.join(target, "generated"), { recursive: true, force: true }),
    rm(path.join(target, "candidates"), { recursive: true, force: true }),
  ]);
  return target;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-game-knowledge-compiler-"));
try {
  const fixtureA = await copyKnowledgeFixture(tempRoot, "fixture-a");
  const fixtureB = await copyKnowledgeFixture(tempRoot, "fixture-b");

  const first = await compileFixture(fixtureA);
  const repeated = await compileFixture(fixtureA);
  const independent = await compileFixture(fixtureB);
  assert(first.writeStatus === "created", "first isolated compile must create an immutable bundle");
  assert(repeated.writeStatus === "unchanged", "repeated compile must reuse an identical immutable bundle");
  assert(first.combinedFingerprint === repeated.combinedFingerprint, "repeated compile fingerprint must be deterministic");
  assert(first.combinedFingerprint === independent.combinedFingerprint, "independent compile fingerprint must ignore output location");
  assert(await readFile(first.bundleFile, "utf8") === await readFile(independent.bundleFile, "utf8"), "independent bundle bytes must match");
  const implementationIdentity = await resolveCompilerImplementationIdentity(repoRoot);
  assert(
    first.bundle.compiler_implementation_identity?.combined_sha256 === implementationIdentity.combined_sha256,
    "Core bundle must carry the exact compiler implementation identity used by its fingerprint",
  );
  const copiedImplementationRoot = path.join(tempRoot, "compiler-implementation-copy");
  for (const entry of implementationIdentity.files) {
    const source = path.join(repoRoot, entry.path);
    const target = path.join(copiedImplementationRoot, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(
    path.join(copiedImplementationRoot, "ui", "electron", "semantic-feature-layer.js"),
    "\n// semantic identity mutation\n",
    { flag: "a" },
  );
  const changedImplementationIdentity = await resolveCompilerImplementationIdentity(copiedImplementationRoot);
  assert(
    changedImplementationIdentity.combined_sha256 !== implementationIdentity.combined_sha256,
    "semantic compiler implementation changes must change compiler identity without a manual revision bump",
  );

  const candidateBeforeCliChecks = await readFile(first.candidateProfilePath, "utf8");
  await execFileAsync(process.execPath, [
    path.join(repoRoot, "tools", "jcc_game_knowledge_compiler.mjs"),
    "--repo-root", repoRoot,
    "--knowledge-root", fixtureA,
    "--season", seasonId,
    "--patch", patchId,
  ]);
  assert(await readFile(first.candidateProfilePath, "utf8") === candidateBeforeCliChecks, "read-only CLI must not mutate candidate state");
  await assertRejects(
    () => execFileAsync(process.execPath, [path.join(repoRoot, "tools", "jcc_game_knowledge_compiler.mjs"), "--write", "--repo-root", repoRoot, "--knowledge-root", fixtureA]),
    /production compiler writes require explicit/i,
    "compiler write without explicit identity",
  );
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: fixtureA, seasonId, patchId, expectedCoreProfileId: "0".repeat(64) }),
    /does not match expected/i,
    "expected Core Profile identity mismatch",
  );
  assert(await readFile(first.candidateProfilePath, "utf8") === candidateBeforeCliChecks, "identity mismatch must preserve candidate bytes");

  const effectiveAugment = first.bundle.effective_standard_mechanics.find((mechanic) => mechanic.id === "mechanic.augment_choice");
  const effectiveCarousel = first.bundle.effective_standard_mechanics.find((mechanic) => mechanic.id === "mechanic.carousel_checkpoint");
  assert(JSON.stringify(effectiveAugment?.checkpoints) === JSON.stringify(["2-1", "3-2", "4-2"]), "standard augment checkpoints must come from Common");
  assert(JSON.stringify(effectiveCarousel?.checkpoints) === JSON.stringify(["2-4", "3-4", "4-4", "5-4", "6-4", "7-4"]), "standard carousel checkpoints must come from Common");
  assert(first.bundle.season.standard_mechanics_overrides.length === 0, "S18 must inherit standard mechanics without an override");
  assert(first.bundle.season.manual_variable_fields.length === 0, "S18 must not invent manual variables");

  const authoredMetadata = first.bundle.source_metadata.authored_inputs;
  const referencedMetadata = first.bundle.source_metadata.referenced_sources;
  assert(authoredMetadata.every((entry) => entry.byte_size > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)), "authored inputs require byte and hash metadata");
  assert(referencedMetadata.every((entry) => entry.byte_size > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)), "referenced sources require byte and hash metadata");
  assert(first.bundle.source_metadata.referenced_payloads_embedded === false, "source payloads must not be copied into the Core bundle");
  assert(first.candidateProfile.status === "candidate_not_promoted", "compiler output must remain a candidate");
  assert(first.candidateProfile.production_switch_requested === false, "compiler must not switch production");
  assert(first.bundle.runtime_identity.package_id === "jcc-s18-s18_1", "runtime-local package identity must follow the selected profile");
  assert(first.bundle.runtime_identity.season_id === seasonId && first.bundle.runtime_identity.patch_id === patchId, "runtime identity must match the selected season and patch");
  assert(JSON.stringify(first.bundle.runtime_identity) === JSON.stringify(first.candidateProfile.runtime_identity), "bundle and candidate runtime identities must match");
  assert(first.bundle.hard_data_query_index?.schema === "jcc-hard-data-query-index-v1", "compiled profile must contain the bounded typed hard-data query index");
  assert(first.bundle.hard_data_query_index?.trait_diversity_roster_support?.counts?.source_candidate_rows === 43, "compiled profile must expose only the bounded default no-emblem candidate set");
  assert(first.bundle.hard_data_query_index?.trait_diversity_roster_support?.counts?.unique_champion_entities_used === 32, "compiled profile must distinguish used unique champions from repeated roster slots");
  assert(first.bundle.hard_data_query_index?.trait_diversity_roster_support?.counts?.catalog_champion_entities === 65, "compiled profile must keep the full catalog count separate from tracker usage");
  assert(first.bundle.hard_data_query_index?.trait_diversity_roster_support?.source_ref?.path?.includes("/generations/"), "trait-diversity support must stay in immutable hard data");
  assert(!Object.hasOwn(first.bundle.hard_data_query_index?.trait_diversity_roster_support || {}, "roster_groups"), "the Core bundle must not inline the full roster cache");
  assert(first.bundle.semantic_feature_index?.schema === "jcc-semantic-feature-index-v1", "compiled Core Profile must include the controlled semantic feature index");
  assert(first.bundle.semantic_feature_index?.identity?.core_profile_id === first.combinedFingerprint, "semantic feature bindings must be fenced to the exact Core Profile");
  assert(first.candidateProfile.semantic_feature_index_path?.endsWith("/semantic-feature-index.json"), "candidate profile must list the immutable semantic feature artifact");
  assert(await readFile(first.semanticFeatureIndexFile, "utf8") === await readFile(independent.semanticFeatureIndexFile, "utf8"), "independent semantic feature artifact bytes must match");
  assert(first.semanticFeatureIndexSha256 === first.candidateProfile.semantic_feature_index_sha256, "candidate profile must hash the semantic feature artifact");

  const patchManifest = await readJson(path.join(fixtureA, "seasons", seasonId, "patches", patchId, "source-manifest.json"));
  const externalRoles = new Set(["primary_augment_catalog_snapshot", "supplemental_hard_data_snapshot", "supplemental_rate_and_reward_snapshot", "supplemental_trait_diversity_roster_snapshot", "mumu_runtime_id_mapping_receipt", "patch_player_aliases", "patch_strategy", "item_usage_taxonomy", "balance_patch_overlay"]);
  const generationRoot = `${patchManifest.hard_data_candidate.generation_dir}/`;
  assert(patchManifest.source_artifacts.filter((entry) => externalRoles.has(entry.role)).every((entry) => !entry.path.startsWith(generationRoot)), "source snapshots must remain outside immutable normalized generations");
  assert(patchManifest.source_artifacts.filter((entry) => !externalRoles.has(entry.role)).every((entry) => entry.path.startsWith(generationRoot)), "compiled hard-data artifacts must share the selected generation");

  const commonText = JSON.stringify(Object.values(first.bundle.common)).toLowerCase();
  for (const term of first.bundle.season.season_entity_terms.map((value) => value.toLowerCase())) {
    assert(!commonText.includes(term), `Common must not contain current-season entity term: ${term}`);
  }

  const contaminatedRoot = await copyKnowledgeFixture(tempRoot, "contaminated-common");
  const contaminatedFile = path.join(contaminatedRoot, "common", "concepts.json");
  const contaminated = await readJson(contaminatedFile);
  contaminated.entries[0].definition = `Use ${first.bundle.season.season_entity_terms[0]} as Common evidence.`;
  await writeJson(contaminatedFile, contaminated);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: contaminatedRoot, seasonId, patchId, write: false }),
    /contains season entity term/i,
    "season entity contamination in Common",
  );

  const invalidOverrideRoot = await copyKnowledgeFixture(tempRoot, "invalid-override");
  const invalidDescriptorFile = path.join(invalidOverrideRoot, "seasons", seasonId, "season-descriptor.json");
  const invalidDescriptor = await readJson(invalidDescriptorFile);
  invalidDescriptor.standard_mechanics_overrides = [{ mechanic_id: "mechanic.augment_choice", checkpoints: ["2-2"] }];
  await writeJson(invalidDescriptorFile, invalidDescriptor);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: invalidOverrideRoot, seasonId, patchId, write: false }),
    /override is forbidden.*mechanic\.augment_choice/i,
    "forbidden standard-mechanic override",
  );

  const escapingSourceRoot = await copyKnowledgeFixture(tempRoot, "escaping-source");
  const escapingManifestFile = path.join(escapingSourceRoot, "seasons", seasonId, "patches", patchId, "source-manifest.json");
  const escapingManifest = await readJson(escapingManifestFile);
  escapingManifest.source_artifacts[0].path = "../outside.json";
  await writeJson(escapingManifestFile, escapingManifest);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: escapingSourceRoot, seasonId, patchId, write: false }),
    /escapes its allowed root/i,
    "escaping source path",
  );

  const mismatchedRoot = await copyKnowledgeFixture(tempRoot, "mismatched-generation");
  const mismatchedManifestFile = path.join(mismatchedRoot, "seasons", seasonId, "patches", patchId, "source-manifest.json");
  const mismatchedManifest = await readJson(mismatchedManifestFile);
  mismatchedManifest.hard_data_candidate = { ...mismatchedManifest.hard_data_candidate, generation_id: "f".repeat(64), generation_dir: `data/core-patches/jcc/generations/${"f".repeat(64)}` };
  await writeJson(mismatchedManifestFile, mismatchedManifest);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: mismatchedRoot, seasonId, patchId, write: false }),
    /hard_data_candidate and source_artifacts must reference the same generation/i,
    "mismatched hard-data generation",
  );

  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: fixtureB, seasonId, patchId, outputRoot: path.join(tempRoot, "escaped-output"), write: false }),
    /escapes its allowed root/i,
    "escaping generated output path",
  );

  const collisionRoot = await copyKnowledgeFixture(tempRoot, "collision");
  const conceptsFile = path.join(collisionRoot, "common", "concepts.json");
  const concepts = await readJson(conceptsFile);
  concepts.entries.push(structuredClone(concepts.entries[0]));
  await writeJson(conceptsFile, concepts);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: collisionRoot, seasonId, patchId, write: false }),
    /entry ids collision/i,
    "duplicate logical entry id",
  );

  const invalidSchemaRoot = await copyKnowledgeFixture(tempRoot, "invalid-schema");
  const invalidSchemaFile = path.join(invalidSchemaRoot, "schemas", "common-document.schema.json");
  const invalidSchema = await readJson(invalidSchemaFile);
  invalidSchema.$schema = "invalid-draft";
  await writeJson(invalidSchemaFile, invalidSchema);
  await assertRejects(
    () => compileGameKnowledge({ repoRoot, knowledgeRoot: invalidSchemaRoot, seasonId, patchId, write: false }),
    /must use JSON Schema 2020-12/i,
    "invalid schema declaration",
  );

  await writeFile(first.bundleFile, "{\"tampered\":true}\n", "utf8");
  await assertRejects(() => compileFixture(fixtureA), /immutable generated artifact differs/i, "immutable bundle mutation");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-game-knowledge-compiler-verifier-v2",
    season_id: seasonId,
    patch_id: patchId,
    combined_fingerprint: independent.combinedFingerprint,
    checks: [
      "current-profile deterministic compilation",
      "Common augment and carousel inheritance",
      "season-neutral Common isolation",
      "external source snapshots separated from immutable normalized generation",
      "source path and generation identity fail closed",
      "schema and logical-id collision validation",
      "candidate compilation does not switch production",
      "typed hard-data query index compiled",
      "compiler implementation identity changes with semantic rules",
      "immutable generated artifact enforcement",
    ],
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
