import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { resolveHardDataTarget, validateHardDataManifestIdentity } from "./jcc_hard_data_target.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(file) {
  return readFile(file, "utf8");
}

async function filesUnder(root, extensions) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".omx"].includes(entry.name)) continue;
        await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function lacks(source, needle, label) {
  assert(!source.includes(needle), `${label} must not include ${needle}`);
}

function has(source, needle, label) {
  assert(source.includes(needle), `${label} missing ${needle}`);
}

function throws(operation, pattern, label) {
  try {
    operation();
  } catch (error) {
    assert(pattern.test(error?.message || String(error)), `${label} threw the wrong error: ${error?.message || error}`);
    return;
  }
  throw new Error(`${label} must throw`);
}

async function main() {
  const repoRoot = process.cwd();
  const paths = createRuntimePaths(repoRoot);
  const expectedRuntimeDataRoot = path.resolve(process.env.JCC_RUNTIME_DATA_DIR || path.join(repoRoot, ".jcc-runtime-data"));
  const previousRuntimeDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  delete process.env.JCC_RUNTIME_DATA_DIR;
  const defaultPaths = createRuntimePaths(repoRoot);
  if (previousRuntimeDataDir !== undefined) process.env.JCC_RUNTIME_DATA_DIR = previousRuntimeDataDir;
  const service = await text("ui/electron/runtime-service.js");
  const startMatch = await text("tools/start-jcc-new-match-session.mjs");
  const watcher = await text("tools/start-jcc-mumu-runtime-watch.mjs");
  const contextPack = await text("tools/build-jcc-host-agent-context-pack.mjs");
  const cruise = await text("tools/run-jcc-cruise-runtime-pipeline.mjs");
  const itemization = await text("tools/build-jcc-itemization-context.mjs");
  const combatCap = await text("tools/build-jcc-combat-cap-estimator-context.mjs");
  const s18HardDataStage = await text("tools/stage-jcc-s18-hard-data.mjs");
  const hardDataVerifier = await text("tools/verify-jcc-hard-data.mjs");
  const rankingsSync = await text("tools/sync-jcc-live-rankings.mjs");
  const resourceModifierCatalog = await text("data/runtime/jcc/resource-policy-modifier-catalog.json");

  const retiredTelemetryTools = [
    "generate-runtime-proxy-evidence.mjs",
    "assemble-runtime-evidence-export.mjs",
    "export-runtime-telemetry-envelope.mjs",
    "ingest-runtime-telemetry-jsonl.mjs",
    "install-runtime-integration-artifact.mjs",
    "install-runtime-telemetry-bundle.mjs",
    "verify-runtime-integration-acceptance.mjs",
    "verify-runtime-integration-installer.mjs",
    "verify-runtime-telemetry-bundle-installer.mjs",
    "verify-runtime-telemetry-intake.mjs",
    "verify-runtime-telemetry-ingest.mjs",
    "verify-runtime-telemetry-exporter.mjs",
    "verify-runtime-telemetry-envelope.mjs",
    "verify-runtime-evidence-assembler.mjs",
    "verify-runtime-evidence-packet.mjs",
    "verify-runtime-load-trace.mjs",
    "verify-runtime-decision-probes.mjs",
    "verify-runtime-decision-events.mjs",
    "verify-jcc-hot-path-integrity.mjs",
    "verify-jcc-runtime-readiness.mjs",
    "verify-jcc-real-evidence-live-state.mjs",
  ];
  for (const file of retiredTelemetryTools) {
    assert(!await pathExists(path.join("tools", file)), `retired permanent telemetry tool must stay deleted: ${file}`);
  }
  for (const file of [
    "tools/build-jcc-augment-strategy-taxonomy.mjs",
    "tools/verify-jcc-augment-strategy-taxonomy.mjs",
    "tools/verify-jcc-augment-special-mechanism-formulas.mjs",
    "data/runtime/jcc/augment-strategy-taxonomy.json",
    "tools/verify-jcc-variable-runtime-candidates.mjs",
    "tools/verify-jcc-god-reward-state-candidate.mjs",
    "tools/run-jcc-god-choice-roi-ocr.mjs",
    "tools/roi_god_choice.py",
    "tools/jcc_god_choice_field_aggregator.py",
    "data/runtime/jcc/manual-match-variable-contract.json",
    "data/runtime/jcc/mumu-decrypted-config/cfg.json",
    "data/runtime/jcc/mumu-decrypted-config/lus.json",
  ]) {
    assert(!await pathExists(file), `retired global/S17 augment scoring surface must stay deleted: ${file}`);
  }
  lacks(resourceModifierCatalog, "encounter_cheaper_levels", "current resource modifier catalog");
  lacks(resourceModifierCatalog, "augment_ahri_blessing", "current resource modifier catalog");
  lacks(resourceModifierCatalog, "阿狸的恩赐", "current resource modifier catalog");
  for (const packageEntry of await readdir(path.join("data", "core-patches", "jcc"), { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    const packageDir = path.join("data", "core-patches", "jcc", packageEntry.name);
    assert(!await pathExists(path.join(packageDir, "runtime-fixtures")), `retired runtime-fixtures directory must stay deleted from ${packageEntry.name}`);
    assert(!await pathExists(path.join(packageDir, "graphs")), `retired graphs directory must stay deleted from ${packageEntry.name}`);
    assert(!await pathExists(path.join(packageDir, "indexes", "hot")), `retired indexes/hot directory must stay deleted from ${packageEntry.name}`);
    for (const indexName of [
      "hard_data_readiness_audit",
      "runtime_hot_path_budgets",
      "runtime_gap_closure_runbooks",
      "runtime_integration_acceptance_manifest",
      "runtime_decision_probes",
      "runtime_evidence_packet_contract",
      "runtime_load_trace_contracts",
      "runtime_telemetry_capture_plan",
      "runtime_telemetry_envelope_contract",
    ]) {
      assert(!await pathExists(path.join(packageDir, "indexes", `${indexName}.json`)), `retired index must stay deleted from ${packageEntry.name}: ${indexName}.json`);
    }
  }

  assert(paths.currentWatchDir.startsWith(expectedRuntimeDataRoot), "current watch dir must honor the configured runtime data root");
  assert(paths.currentSessionFile.startsWith(expectedRuntimeDataRoot), "current session file must honor the configured runtime data root");
  assert(defaultPaths.currentWatchDir.includes(path.join(".jcc-runtime-data", "runtime-evidence")), "current watch dir must default under .jcc-runtime-data without an override");
  assert(defaultPaths.currentSessionFile.includes(path.join(".jcc-runtime-data", "state")), "current session file must default under .jcc-runtime-data without an override");

  has(service, '"--out-dir"', "runtime service start watcher");
  has(service, "currentWatchDir", "runtime service start watcher");
  has(service, '"--state-file"', "runtime service start match");
  has(service, "currentSessionFile", "runtime service start match");
  lacks(service, "runNodeTool(\"tools/start-jcc-new-match-session.mjs\", [],", "runtime service");

  has(startMatch, "process.env.JCC_RUNTIME_DATA_DIR", "start match tool");
  has(startMatch, 'path.join(repoRoot, ".jcc-runtime-data")', "start match tool");
  has(startMatch, "--season-snapshot-base64url", "start match tool");
  lacks(startMatch, "createRuntimePaths", "start match tool");
  lacks(startMatch, "loadActiveRulesBundle", "start match tool");
  lacks(startMatch, "const DEFAULT_OUT_DIR = \".omx", "start match tool");
  lacks(startMatch, "const DEFAULT_STATE_FILE = \".omx", "start match tool");

  has(watcher, "createRuntimePaths", "watcher tool");
  has(watcher, "runtimePaths.currentWatchDir", "watcher tool");
  has(watcher, "writeLegacyJsonMirror", "watcher tool");
  lacks(watcher, "outDir: \".omx", "watcher tool");
  lacks(watcher, "writeFile(path.resolve(\".omx\"", "watcher tool");

  has(contextPack, "createRuntimePaths", "context pack tool");
  has(contextPack, "runtimePaths.runtimeEvidenceDir", "context pack tool");
  has(contextPack, "runtimePaths.currentSessionFile", "context pack tool");
  lacks(contextPack, "const DEFAULT_OUT_DIR = \".omx", "context pack tool");
  lacks(contextPack, "readJsonIfExists(\".omx/state/jcc-current-match-session.json\")", "context pack tool");

  has(cruise, "createRuntimePaths", "cruise pipeline");
  has(cruise, "runtimePaths.stateDir", "cruise pipeline");
  has(cruise, "buildContext", "cruise pipeline active hard-data context builder");
  lacks(cruise, '"--patch-dir"', "cruise pipeline active hard-data bypass");
  lacks(combatCap, '"--patch-dir"', "combat-cap active hard-data bypass");
  has(combatCap, "resolveHardDataTarget", "combat-cap active hard-data target resolver");
  has(combatCap, "validateHardDataTarget", "combat-cap active hard-data manifest validation");
  lacks(cruise, "adviceState: \".omx/state", "cruise pipeline");

  for (const [label, source] of [
    ["context pack", contextPack],
    ["itemization context", itemization],
    ["combat-cap context", combatCap],
    ["hard-data verifier", hardDataVerifier],
  ]) {
    has(source, "activeHardDataManifest", `${label} active hard-data path`);
    lacks(source, "JCC_HARD_DATA_PATCH_DIR", `${label} hard-data env bypass`);
  }
  has(s18HardDataStage, "immutable generations are publisher-owned", "S18 staging output guard");
  has(rankingsSync, "resolveRankingTarget", "rankings sync version-pipeline target resolver");
  has(rankingsSync, "rankingTarget.hard_data_manifest_value", "rankings sync Core Profile hard-data binding");
  lacks(rankingsSync, "JCC_HARD_DATA_PATCH_DIR", "rankings sync hard-data env bypass");

  throws(
    () => resolveHardDataTarget({
      repoRoot,
      activeManifest: paths.activeHardDataManifest,
      env: { JCC_HARD_DATA_PATCH_DIR: "data/core-patches/jcc/not-active" },
    }),
    /forbidden because it bypasses the active promotion tuple/,
    "legacy hard-data environment override",
  );
  assert(!await pathExists("tools/build-jcc-hard-data.mjs"), "retired S17 hard-data builder must stay deleted");
  assert(!await pathExists("tools/collect-jcc-official-hard-data.mjs"), "retired direct collector must stay deleted");
  throws(
    () => resolveHardDataTarget({
      repoRoot,
      activeManifest: paths.activeHardDataManifest,
      argv: ["--candidate-manifest", "data/core-patches/jcc/not-active/manifest.json"],
    }),
    /not allowed for this active-runtime operation/,
    "candidate manifest on active-only operation",
  );
  throws(
    () => resolveHardDataTarget({
      repoRoot,
      activeManifest: paths.activeHardDataManifest,
      argv: ["--candidate-manifest", "data/core-patches/jcc/manifest.json"],
      allowCandidate: true,
      env: {},
    }),
    /must use data\/core-patches\/jcc\/<legacy-package>\/manifest\.json or generations\/<sha256>\/manifest\.json/,
    "root-level candidate manifest",
  );
  throws(
    () => resolveHardDataTarget({
      repoRoot,
      activeManifest: paths.activeHardDataManifest,
      argv: ["--candidate-manifest", "data/core-patches/jcc/package/nested/manifest.json"],
      allowCandidate: true,
      env: {},
    }),
    /must use data\/core-patches\/jcc\/<legacy-package>\/manifest\.json or generations\/<sha256>\/manifest\.json/,
    "nested candidate manifest",
  );
  throws(
    () => validateHardDataManifestIdentity(
      { kind: "candidate", packageDir: path.join(repoRoot, "data/core-patches/jcc/candidate") },
      { packageId: "candidate", mode: "17", season: "18" },
    ),
    /missing required identity field version/,
    "candidate manifest identity",
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "start-match-runtime-data-defaults",
      "watcher-runtime-data-defaults",
      "context-pack-runtime-data-defaults",
      "cruise-pipeline-runtime-data-defaults",
      "mainline-hard-data-defaults-follow-active-promotion-tuple",
      "implicit-hard-data-env-bypass-is-forbidden",
      "candidate-manifest-is-explicit-and-operation-scoped",
      "candidate-manifest-layout-and-identity-fail-closed",
      "all-runtime-tools-and-current-contracts-avoid-fixed-package-literals",
      "legacy-json-mirror-explicit-only",
      "retired-permanent-telemetry-tools-and-proxy-fixtures-absent",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
