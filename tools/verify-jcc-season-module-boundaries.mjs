import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function exists(file) {
  try {
    await access(path.resolve(file));
    return true;
  } catch {
    return false;
  }
}

async function treeHasFiles(dir) {
  let entries;
  try {
    entries = await readdir(path.resolve(dir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await treeHasFiles(path.join(dir, entry.name))) return true;
  }
  return false;
}

const contract = await readJson("data/runtime/jcc/runtime-season-module-contract.json");
const activeProfile = await readJson("data/game-knowledge/jcc/active-profile.json");
assert(contract.schema === "jcc-runtime-season-module-contract-v1", "season module contract schema mismatch");
assert(contract.active_selection?.primary === "data/game-knowledge/jcc/active-profile.json#runtime_identity", "active Core Profile must be the only production selector");
assert(contract.active_selection?.compatibility_fallback === null, "season compatibility metadata must not be a production fallback");
assert(contract.active_season === undefined, "season contract must not retain a second mutable active-version identity");
const activeIdentity = activeProfile.runtime_identity;
assert(activeIdentity?.hard_data_manifest, "active Core Profile hard data manifest missing");
assert(await exists(activeIdentity.hard_data_manifest), "active Core Profile hard data manifest path missing");

const manifest = await readJson(activeIdentity.hard_data_manifest);
const manifestDirName = path.basename(path.dirname(path.resolve(activeIdentity.hard_data_manifest)));
assert(manifest.packageId === activeIdentity.package_id, "active local package id must match hard data manifest");
assert(manifest.immutable === true, "active hard data generation must be immutable");
assert(manifest.hard_data_generation_id === manifestDirName, "active hard data generation id must match its content-addressed directory");
assert(manifest.source_package_id === activeIdentity.source_package_id, "active source package id must match hard-data provenance");
assert(String(activeIdentity.package_id).includes(activeProfile.season_id), "runtime package id must include the runtime season id");
assert(String(activeIdentity.package_id).includes(activeProfile.patch_id), "runtime package id must include the runtime patch id");

const promotionFields = ["season_id", "active_patch_id", "game_mode_id", "package_id", "source_package_id", "hard_data_manifest"];
assert(
  promotionFields.every((field) => contract.promotion_tuple?.immutable_fields?.includes(field)),
  "promotion tuple must declare every version identity field immutable",
);
assert(contract.activation_policy?.scope === "new_match_only", "season promotion must apply to new matches only");
assert(
  [...promotionFields, "rules_source_fingerprint"].every((field) => contract.activation_policy?.match_snapshot_fields?.includes(field)),
  "match snapshots must pin the promotion tuple and compiled rules fingerprint",
);
assert(contract.versioned_layers?.active_game_rules?.common_knowledge_path === "data/game-knowledge/jcc/common/", "common knowledge path must remain explicit");
assert(contract.versioned_layers?.active_game_rules?.common_runtime_path === "data/runtime/jcc/common-choice-runtime-contract.json", "common Runtime choice path must remain explicit");
assert(contract.versioned_layers?.active_game_rules?.season_descriptor_path_pattern?.includes("<season_id>"), "season descriptor must be major-season scoped");
assert(contract.versioned_layers?.patch_strategy_overrides?.path_pattern?.includes("<patch_id>"), "patch strategy must remain minor-patch scoped");
assert(contract.versioned_layers?.patch_rule_overrides?.policy?.includes("Absent by default"), "same-season rule overrides must be exceptional");
assert(contract.minor_patch_default_policy?.hard_data?.includes("Do not alter season normal/special rules"), "ordinary minor patches must not rewrite major-season rules");
assert(contract.minor_patch_default_policy?.runtime_code?.includes("should not require runtime code"), "ordinary minor patches must remain data-first");
assert(contract.exceptional_patch_rule_override_policy?.requirements?.some((item) => item.includes("changed rule surface")), "exceptional rule overrides must declare exact changed surfaces");
assert(contract.exceptional_patch_rule_override_policy?.requirements?.some((item) => item.includes("requirements registry") && item.includes("changelog")), "exceptional rule overrides must update requirement authority history");
assert(contract.rollback_and_history_policy?.preserve?.includes("old hard-data packages"), "rollback must retain old hard-data packages");
assert(contract.rollback_and_history_policy?.preserve?.includes("requirements changelog entries"), "rollback must retain requirement decisions");
assert(contract.compatibility_policy?.missing_contract_or_match_snapshot?.includes("fail_closed"), "missing version authority must fail closed");
assert(contract.switching_workflow?.some((item) => item.includes("--candidate-manifest")), "candidate promotion must use an explicit manifest");
assert(contract.switching_workflow?.some((item) => item.includes("never use an environment-variable path override")), "season promotion must reject environment path overrides");

const requiredCurrentPaths = [
  "data/runtime/jcc/mumu-catalog-overlay.json",
  "data/runtime/jcc/visual-icons/manifest.json",
  "data/runtime/jcc/runtime-session-contract.json",
  "data/runtime/jcc/runtime-ui-mode-contract.json",
  "data/runtime/jcc/visual-live-state-contract.json",
  "data/runtime/jcc/cruise-agent-output-loop-contract.json",
  "data/runtime/jcc/lineup-display-contract.json",
];
for (const file of requiredCurrentPaths) {
  assert(await exists(file), `required season/runtime boundary path missing: ${file}`);
}

assert(contract.compatibility_policy?.keep_old_season_modules === true, "old season modules must be retained");
assert(contract.runtime_invariant_layers?.includes("mode_system"), "mode system must be runtime invariant");
assert(contract.runtime_invariant_layers?.includes("host_multimodal_visual_request"), "host visual request must be runtime invariant");
assert(
  contract.versioned_layers?.mechanism_policy_tables?.policy?.includes("Core Profile"),
  "version-specific mechanism policy must be supplied by the immutable Core Profile",
);
assert(
  contract.versioned_layers?.patch_strategy_overrides?.path_pattern?.startsWith("data/game-knowledge/jcc/seasons/"),
  "patch strategy must remain inside its version-owned game-knowledge module",
);
assert(
  !(await treeHasFiles("data/runtime/jcc/seasons")),
  "season-owned game knowledge must not reappear in the Runtime contract tree",
);
assert(
  contract.switching_workflow?.some((item) => item.includes("season module") && item.includes("common-season-neutrality") && item.includes("season-aware renderer")),
  "season switching workflow must include season, common-neutrality, and renderer verifiers",
);
assert(contract.do_not_port_assumptions?.some((item) => item.includes("retired season") && item.includes("compiled descriptor")), "season-specific mechanic non-port rule missing");

console.log(JSON.stringify({
  ok: true,
  active_season: {
    season_id: activeProfile.season_id,
    active_patch_id: activeProfile.patch_id,
    ...activeIdentity,
  },
  checked_paths: requiredCurrentPaths,
  runtime_invariant_layers: contract.runtime_invariant_layers,
}, null, 2));
