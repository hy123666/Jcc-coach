import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimeDataRoot = process.env.JCC_RUNTIME_DATA_DIR
  ? path.resolve(process.env.JCC_RUNTIME_DATA_DIR)
  : path.join(repoRoot, ".jcc-runtime-data");
const DEFAULT_OUT_DIR = path.join(runtimeDataRoot, "runtime-evidence", "mumu-gi-live", "current-watch");
const DEFAULT_STATE_FILE = path.join(runtimeDataRoot, "state", "jcc-current-match-session.json");
const RESET_FILES = [
  "state.json",
  "summary.json",
  "events.jsonl",
  "cruise-live-state.json",
  "latest-visual-live-state.json",
  "pending-visual-requests.json",
  "cruise-pipeline.json",
  "advice-lifecycle.json",
  "manual-scouting-notes.json",
  "opponent-snapshots.json",
  "manual-match-variables.json",
  "match-context.json",
];

function usage() {
  return [
    "Usage:",
    "  node tools/start-jcc-new-match-session.mjs --season-snapshot-base64url <snapshot> [--match-session-id <id>] [--prepare-only] [--dry-run]",
    "",
    "Starts a clean match session boundary for MuMu runtime/watch/advice state.",
    "The owning Runtime must capture the immutable Core Profile snapshot once and pass it explicitly.",
    "Clears the selected current-match workspace; historical/debug folders outside that workspace are not touched.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    stateFile: DEFAULT_STATE_FILE,
    dryRun: false,
    prepareOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--state-file") options.stateFile = argv[++index];
    else if (arg === "--test-workspace-root") options.testWorkspaceRoot = argv[++index];
    else if (arg === "--season-snapshot-base64url") options.seasonSnapshotBase64Url = argv[++index];
    else if (arg === "--prepare-only") options.prepareOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function explicitSeasonVersionSnapshot(options) {
  const encoded = String(options.seasonSnapshotBase64Url || "").trim();
  if (!encoded) {
    throw new Error("Start Match requires --season-snapshot-base64url from the owning Runtime boundary");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid explicit season snapshot: ${error?.message || String(error)}`);
  }
  const coreProfileId = String(snapshot?.core_profile_id || "").trim();
  const promotionTuple = snapshot?.promotion_tuple || {};
  const sourceIdentity = snapshot?.core_source_identity || {};
  const rankingIdentity = snapshot?.ranking_overlay_identity || {};
  const rankingAvailability = String(rankingIdentity.availability || "").trim();
  const rankingOverlayId = String(snapshot?.ranking_overlay_id || "").trim();
  const rankingIdentityOverlayId = String(rankingIdentity.ranking_overlay_id || "").trim();
  const rankingIdentityComplete = rankingAvailability === "available"
    ? Boolean(rankingOverlayId) && rankingOverlayId === rankingIdentityOverlayId
    : rankingAvailability === "unavailable" && !rankingOverlayId && !rankingIdentityOverlayId;
  const recipeIdentity = snapshot?.recipe_catalog_identity || {};
  const recipeAvailability = String(recipeIdentity.availability || "").trim();
  const recipeGenerationId = String(snapshot?.recipe_catalog_generation_id || "").trim();
  const recipeIdentityGenerationId = String(recipeIdentity.generation_id || "").trim();
  const recipeIdentityComplete = recipeAvailability === "available"
    ? /^[a-f0-9]{64}$/.test(recipeGenerationId) && recipeGenerationId === recipeIdentityGenerationId
    : recipeAvailability === "unavailable" && !recipeGenerationId && !recipeIdentityGenerationId;
  const pairedPublicationComplete = rankingAvailability === "available" && recipeAvailability === "available"
    ? recipeIdentity.closure_ranking_generation_id === rankingOverlayId
      && recipeIdentity.stat_date === rankingIdentity.ranking_stat_date
    : rankingAvailability === "unavailable" && recipeAvailability === "unavailable";
  if (
    snapshot?.schema !== "jcc-match-season-version-snapshot-v1"
    || !snapshot?.captured_at
    || snapshot?.activation_policy !== "new_match_only"
    || !promotionTuple.season_id
    || !promotionTuple.active_patch_id
    || !promotionTuple.game_mode_id
    || !promotionTuple.package_id
    || !promotionTuple.hard_data_manifest
    || !snapshot?.rules_source_fingerprint
    || !/^[a-f0-9]{64}$/.test(coreProfileId)
    || promotionTuple.core_profile_id !== coreProfileId
    || snapshot?.core_profile_ref?.core_profile_id !== coreProfileId
    || !snapshot?.core_profile_artifacts?.hard_data_manifest
    || !snapshot?.core_profile_artifacts?.decision_input_catalog
    || !snapshot?.core_profile_artifacts?.augment_stage_authority
    || !snapshot?.core_profile_artifacts?.runtime_catalog_overlay
    || !snapshot?.core_profile_artifacts?.bundle
    || sourceIdentity.core_profile_id !== coreProfileId
    || sourceIdentity.season_id !== promotionTuple.season_id
    || sourceIdentity.active_patch_id !== promotionTuple.active_patch_id
    || rankingIdentity.core_profile_id !== coreProfileId
    || rankingIdentity.season_id !== promotionTuple.season_id
    || rankingIdentity.patch_id !== promotionTuple.active_patch_id
    || !rankingIdentityComplete
    || recipeIdentity.core_profile_id !== coreProfileId
    || recipeIdentity.season_id !== promotionTuple.season_id
    || recipeIdentity.patch_id !== promotionTuple.active_patch_id
    || !recipeIdentityComplete
    || !pairedPublicationComplete
    || snapshot.core_profile_artifacts.hard_data_manifest !== promotionTuple.hard_data_manifest
    || snapshot?.knowledge_lifecycle?.core_profile !== "fixed_for_match"
    || snapshot?.knowledge_lifecycle?.ranking_overlay !== "fixed_for_match"
    || snapshot?.knowledge_lifecycle?.recipe_catalog !== "fixed_for_match"
  ) {
    throw new Error("Explicit season snapshot is incomplete");
  }
  return structuredClone(snapshot);
}

function makeMatchSessionId(now = new Date()) {
  return `jcc-match-${now.toISOString().replace(/[:.]/g, "-")}`;
}

async function removeCurrentArtifacts(outDir, dryRun) {
  const resolvedOutDir = path.resolve(outDir);
  if (resolvedOutDir === path.parse(resolvedOutDir).root) {
    throw new Error(`Refusing to clear filesystem root as current-match workspace: ${resolvedOutDir}`);
  }
  const entries = await readdir(resolvedOutDir, { withFileTypes: true }).catch(() => []);
  const removed = entries.map((entry) => path.join(resolvedOutDir, entry.name));
  for (const target of removed) {
    if (!dryRun) await rm(target, { recursive: true, force: true });
  }
  return removed;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinOrEqual(target, parent) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertMatchWorkspaceBoundary({ outDir, stateFile, testWorkspaceRoot }) {
  const resolvedOutDir = path.resolve(outDir);
  const resolvedStateFile = path.resolve(stateFile);
  const canonicalOutDir = path.resolve(DEFAULT_OUT_DIR);
  const canonicalStateFile = path.resolve(DEFAULT_STATE_FILE);
  if (
    normalizedPath(resolvedOutDir) === normalizedPath(canonicalOutDir)
    && normalizedPath(resolvedStateFile) === normalizedPath(canonicalStateFile)
  ) {
    return { kind: "canonical", root: canonicalOutDir };
  }

  if (!testWorkspaceRoot) {
    throw new Error("Custom match workspace paths require --test-workspace-root and are never accepted by production Start Match.");
  }
  const resolvedTestRoot = path.resolve(testWorkspaceRoot);
  const tempRoot = path.resolve(os.tmpdir());
  if (
    normalizedPath(resolvedTestRoot) === normalizedPath(tempRoot)
    || !isWithinOrEqual(resolvedTestRoot, tempRoot)
  ) {
    throw new Error(`Test workspace root must be a dedicated child of the OS temporary directory: ${resolvedTestRoot}`);
  }
  if (!isWithinOrEqual(resolvedOutDir, resolvedTestRoot) || !isWithinOrEqual(resolvedStateFile, resolvedTestRoot)) {
    throw new Error(`Custom match workspace and state file must stay inside the declared test root: ${resolvedTestRoot}`);
  }

  const [realTestRoot, realOutDir] = await Promise.all([
    realpath(resolvedTestRoot),
    realpath(resolvedOutDir).catch(() => resolvedOutDir),
  ]);
  if (normalizedPath(realTestRoot) !== normalizedPath(resolvedTestRoot)) {
    throw new Error(`Refusing symlinked test workspace root: ${resolvedTestRoot}`);
  }
  if (!isWithinOrEqual(realOutDir, realTestRoot)) {
    throw new Error(`Resolved match workspace escapes the declared test root: ${realOutDir}`);
  }
  return { kind: "test", root: resolvedTestRoot };
}

async function startSession(options) {
  const now = new Date().toISOString();
  const matchSessionId = options.matchSessionId || makeMatchSessionId(new Date(now));
  const outDir = path.resolve(options.outDir || DEFAULT_OUT_DIR);
  const stateFile = path.resolve(options.stateFile || DEFAULT_STATE_FILE);
  const seasonVersionSnapshot = explicitSeasonVersionSnapshot(options);
  await assertMatchWorkspaceBoundary({
    outDir,
    stateFile,
    testWorkspaceRoot: options.testWorkspaceRoot,
  });
  const removed_current_match_artifacts = options.prepareOnly
    ? []
    : await removeCurrentArtifacts(outDir, options.dryRun);
  const state = {
    schema: "jcc-current-match-session-state-v1",
    match_session_id: matchSessionId,
    started_at: now,
    out_dir: outDir,
    dry_run: options.dryRun,
    prepare_only: options.prepareOnly,
    season_version_snapshot: seasonVersionSnapshot,
    reset_policy: {
      match_scoped: true,
      cleared: [
        "live_state",
        "advice_task lifecycle",
        "user-confirmed scouting notes",
        "manual match variables",
        "match context",
        "current watcher events",
        "current summary",
      ],
      not_cleared: [
        "historical debug folders",
        "hard-data",
        "live rankings",
        "catalog/cache assets",
      ],
      old_match_pollution_allowed: false,
    },
    removed_current_match_artifacts,
    next_runtime_command_hint: `node tools/start-jcc-mumu-runtime-watch.mjs --match-session-id ${matchSessionId}`,
  };
  if (!options.dryRun && !options.prepareOnly) {
    await mkdir(outDir, { recursive: true });
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "match-session.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  return state;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const state = await startSession(options);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { RESET_FILES, assertMatchWorkspaceBoundary, startSession };
