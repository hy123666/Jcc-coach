import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_EVIDENCE_DIR = ".omx/runtime-evidence/android-probe-ingame-20260605-214908";
const DEFAULT_MATRIX = "data/runtime/jcc/android-live-state-field-evidence-matrix.json";
const CAPTURE_CONTRACT = "data/runtime/jcc/android-runtime-capture-contract.json";

const VERIFICATION_COMMANDS = [
  "node tools\\verify-jcc-match-id-derived-from-gamestart.mjs",
  "node tools\\verify-jcc-match-set-candidate.mjs",
  "node tools\\verify-jcc-phase-round-stage-candidate.mjs",
  "node tools\\verify-jcc-phase-current-phase-candidate.mjs",
  "node tools\\verify-jcc-runtime-freshness-metadata.mjs",
  "node tools\\verify-jcc-runtime-metadata-field-lists.mjs",
  "node tools\\verify-jcc-runtime-metadata-source-status.mjs",
  "node tools\\verify-jcc-runtime-final-status-report.mjs",
  "node tools\\verify-jcc-runtime-coverage-transition-audit.mjs",
  "node tools\\verify-jcc-round-select-source-insights.mjs",
  "node tools\\verify-jcc-shop-refresh-count-candidate.mjs",
  "node tools\\verify-jcc-shop-unit-schema-evidence.mjs",
  "node tools\\verify-jcc-item-taxonomy-schema.mjs",
  "node tools\\verify-jcc-local-unit-schema-normalization.mjs",
  "node tools\\verify-jcc-local-trait-schema-normalization.mjs",
  "node tools\\verify-jcc-local-augment-schema-normalization.mjs",
  "node tools\\verify-jcc-local-reward-schema-normalization.mjs",
  "node tools\\verify-jcc-local-carousel-schema-normalization.mjs",
  "node tools\\verify-jcc-round-flow-candidate-insights.mjs",
  "node tools\\verify-jcc-board-bench-action-candidates.mjs",
  "node tools\\verify-jcc-round-flow-source-evidence-pointers.mjs",
  "node tools\\verify-jcc-current-opponent-mapping.mjs",
  "node tools\\verify-jcc-current-opponent-schema-evidence.mjs",
  "node tools\\verify-jcc-opponent-snapshot-schema-evidence.mjs",
  "node tools\\verify-jcc-combat-earned-money-mapping.mjs",
  "node tools\\verify-jcc-combat-damage-taken-mapping.mjs",
  "node tools\\verify-jcc-combat-active-candidate.mjs",
  "node tools\\verify-jcc-combat-result-candidate.mjs",
  "node tools\\verify-jcc-carousel-active-candidate.mjs",
  "node tools\\verify-jcc-actions-unavailable-reason-status.mjs",
  "node tools\\verify-jcc-live-state-schema-shape.mjs",
  "node tools\\verify-jcc-live-state-field-status-evidence.mjs",
  "node tools\\verify-jcc-match-live-state-bootstrap.mjs",
  "node tools\\verify-jcc-android-runtime-signal-extractor.mjs",
  "node tools\\verify-jcc-android-probe-targeted-scopes.mjs",
  "node tools\\verify-jcc-android-source-health.mjs",
  "node tools\\verify-jcc-mumu-gameassist-source-discovery.mjs",
  "node tools\\verify-jcc-apk-static-source-discovery.mjs",
  "node tools\\verify-jcc-android-live-state-contract.mjs",
  "node tools\\verify-jcc-android-runtime-capture-contract.mjs",
  "node tools\\verify-jcc-targeted-capture-diff.mjs",
  "node tools\\verify-jcc-targeted-diff-signal-extractor.mjs",
  "node tools\\verify-jcc-targeted-candidate-source-insights.mjs",
  "node tools\\verify-jcc-economy-candidate-audit.mjs",
  "node tools\\verify-jcc-round-flow-binding-analyzer.mjs",
  "node tools\\verify-jcc-runtime-coverage-report.mjs",
];

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-runtime-coverage-report.mjs [--evidence-dir <dir>] [--matrix <matrix.json>] [--out <report.json>]",
    "",
    "Builds an honest coverage report for Android runtime live_state fields and source insights.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { evidenceDir: DEFAULT_EVIDENCE_DIR, matrix: DEFAULT_MATRIX };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--evidence-dir") options.evidenceDir = argv[++index];
    else if (arg === "--matrix") options.matrix = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.out) options.out = path.join(options.evidenceDir, "runtime-coverage-report.json");
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function countMatrixStatuses(matrix) {
  const counts = {};
  for (const field of matrix.fields || []) counts[field.status] = (counts[field.status] || 0) + 1;
  return counts;
}

function runtimeFieldRows(matrix, fieldStatus) {
  return (matrix.fields || []).map((field) => {
    const runtime = fieldStatus?.[field.field_key] || {};
    return {
      field_key: field.field_key,
      status: runtime.status || field.status || "missing",
    };
  });
}

function countRuntimeStatuses(matrix, fieldStatus) {
  const counts = {};
  for (const field of runtimeFieldRows(matrix, fieldStatus)) {
    counts[field.status] = (counts[field.status] || 0) + 1;
  }
  return counts;
}

function runtimeFieldsByStatus(matrix, fieldStatus, status) {
  return runtimeFieldRows(matrix, fieldStatus)
    .filter((field) => field.status === status)
    .map((field) => field.field_key);
}

function finalStatusBuckets(matrix, fieldStatus) {
  return {
    verified: runtimeFieldsByStatus(matrix, fieldStatus, "verified"),
    partial: runtimeFieldsByStatus(matrix, fieldStatus, "partial"),
    missing: runtimeFieldsByStatus(matrix, fieldStatus, "missing"),
    fallback: runtimeFieldsByStatus(matrix, fieldStatus, "fallback_only"),
    impossible: runtimeFieldsByStatus(matrix, fieldStatus, "impossible"),
  };
}

function compactShopUnits(liveState) {
  return (liveState.shop?.shop_units || []).map((unit) => ({
    slot: unit.slot,
    id: unit.champion_id,
    raw_id: unit.raw_id,
    name: unit.name,
    cost: unit.cost,
    traits: unit.traits || [],
    evidence: unit.evidence || null,
  }));
}

function topRemainingGaps(matrix, fieldStatus) {
  const priority = [
    "board.board_units",
    "bench.bench_units",
    "items.item_bench",
    "items.equipped_items",
    "economy.gold",
    "economy.level",
    "economy.xp",
    "economy.xp_to_next",
    "augments.choices",
    "variables.other_set_variables",
    "phase.planning_timer",
    "opponents.current_rank",
  ];
  const byKey = new Map((matrix.fields || []).map((field) => [field.field_key, field]));
  return priority
    .map((field) => {
      const matrixEntry = byKey.get(field) || {};
      const runtimeEntry = fieldStatus?.[field] || {};
      const status = runtimeEntry.status || matrixEntry.status || "missing";
      if (status === "verified") return null;
      return {
        field,
        status,
        blocker: runtimeEntry.blocker || matrixEntry.blocker || "unverified_runtime_semantics",
        next_experiment: runtimeEntry.next_experiment || matrixEntry.next_experiment || "Capture targeted ADB evidence and add a focused extractor/verifier.",
      };
    })
    .filter(Boolean);
}

function nextExperiments(gaps, insights) {
  const experiments = gaps.slice(0, 8).map((gap) => `${gap.field}: ${gap.next_experiment}`);
  const boardDecision = insights?.board_bench_item_candidates?.promotion_decision?.board_units;
  if (boardDecision?.status === "not_promoted") {
    experiments.unshift("board/bench/items: bind round_flow snapshot chair semantics against local_chair_id using targeted planning/combat captures.");
  }
  const economyDecision = insights?.economy_candidates?.promotion_decision?.economy_gold;
  if (economyDecision?.status === "not_promoted") {
    experiments.unshift("economy.gold: map battle_result_money player_ref to chair/local player before promoting gold or combat income.");
  }
  return [...new Set(experiments)];
}

function runtimeTransitionAudit(matrix, fieldStatus) {
  const coreFields = [
    "board.board_units",
    "bench.bench_units",
    "items.item_bench",
    "items.equipped_items",
    "economy.gold",
    "economy.level",
    "economy.xp",
    "economy.xp_to_next",
    "augments.choices",
    "traits.active_traits",
    "carousel.available_units",
    "rewards.choices",
  ];
  const unresolvedPartialFields = [
    "augments.choices",
    "augments.selected_augments",
  ];
  const promoted = [];
  const protectedMissing = [];
  const protectedUnresolvedPartial = [];
  for (const field of matrix.fields || []) {
    const runtime = fieldStatus?.[field.field_key] || {};
    const runtimeStatus = runtime.status || field.status || "missing";
    if (runtimeStatus !== field.status) {
      promoted.push({
        field: field.field_key,
        matrix_status: field.status,
        runtime_status: runtimeStatus,
        source_type: runtime.source_type || field.source_type || "unknown",
        evidence: runtime.evidence || field.evidence_packet || null,
        blocker: runtime.blocker || field.blocker || null,
        next_experiment: runtime.next_experiment || field.next_experiment || null,
      });
    }
    if (coreFields.includes(field.field_key) && runtimeStatus === "missing") {
      protectedMissing.push({
        field: field.field_key,
        runtime_status: runtimeStatus,
        reason: runtime.blocker || field.blocker || "local_semantics_not_proven",
        next_experiment: runtime.next_experiment || field.next_experiment || "Capture targeted ADB evidence and add a focused extractor/verifier.",
      });
    }
    if (unresolvedPartialFields.includes(field.field_key) && runtimeStatus === "partial") {
      protectedUnresolvedPartial.push({
        field: field.field_key,
        runtime_status: runtimeStatus,
        reason: runtime.blocker || field.blocker || "partial_signal_without_local_choice_semantics",
        next_experiment: runtime.next_experiment || field.next_experiment || "Capture augment screen and map choices/selection before promotion.",
      });
    }
  }
  return {
    kind: "runtime_field_transition_audit",
    promoted_from_matrix: promoted,
    protected_core_missing_fields: protectedMissing,
    protected_unresolved_partial_fields: protectedUnresolvedPartial,
    counts: {
      promoted_from_matrix: promoted.length,
      protected_core_missing_fields: protectedMissing.length,
      protected_unresolved_partial_fields: protectedUnresolvedPartial.length,
    },
  };
}

async function buildReport(options) {
  const livePath = path.join(options.evidenceDir, "match-live-state.json");
  const signalsPath = path.join(options.evidenceDir, "candidate-runtime-signals.json");
  const sourceHealthPath = path.join(options.evidenceDir, "source-health.json");
  const liveSnapshot = await readJson(livePath);
  const signals = await readJson(signalsPath);
  const matrix = await readJson(options.matrix);
  let sourceHealth = null;
  try {
    sourceHealth = await readJson(sourceHealthPath);
  } catch {
    sourceHealth = liveSnapshot.source?.source_health || null;
  }
  const liveState = liveSnapshot.live_state || {};
  const buckets = finalStatusBuckets(matrix, liveState.field_status || {});
  const gaps = topRemainingGaps(matrix, liveState.field_status || {});
  return {
    ok: true,
    report_kind: "jcc_android_runtime_live_state_coverage",
    generated_from: {
      evidence_dir: options.evidenceDir,
      matrix: options.matrix,
    },
    evidence_files: {
      live_state: livePath,
      signals: signalsPath,
      source_health: sourceHealthPath,
      matrix: options.matrix,
      targeted_capture_contract: CAPTURE_CONTRACT,
    },
    verification_commands: VERIFICATION_COMMANDS,
    field_status_counts: countRuntimeStatuses(matrix, liveState.field_status || {}),
    final_status_counts: Object.fromEntries(Object.entries(buckets).map(([bucket, fields]) => [bucket, fields.length])),
    final_status_buckets: buckets,
    final_status_notes: {
      fallback: "Fallback fields require host visual sensing, future companion semantic extraction, or explicit user input because no verified ADB/logcat/cache signal is mapped yet.",
      impossible: "No field is currently marked impossible; unknown fields remain missing or fallback_only until source limits are proven.",
    },
    matrix_field_status_counts: countMatrixStatuses(matrix),
    runtime_verified_fields: runtimeFieldsByStatus(matrix, liveState.field_status || {}, "verified"),
    runtime_partial_fields: runtimeFieldsByStatus(matrix, liveState.field_status || {}, "partial"),
    runtime_missing_fields: runtimeFieldsByStatus(matrix, liveState.field_status || {}, "missing"),
    runtime_transition_audit: runtimeTransitionAudit(matrix, liveState.field_status || {}),
    summary: {
      match_status: liveState.match?.status,
      local_chair_id: liveState.local?.local_chair_id,
      binding_status: liveState.local?.binding_status,
      hp: liveState.economy?.hp,
      turn_count: liveState.phase?.turn_count,
      alive_count: liveState.opponents?.alive_count,
      shop_units: compactShopUnits(liveState),
      local_board_units: liveState.board?.board_units?.length || 0,
      local_bench_units: liveState.bench?.bench_units?.length || 0,
      local_item_bench: liveState.items?.item_bench?.length || 0,
    },
    source_insights: liveState.source_insights || {},
    remaining_gaps: gaps,
    next_experiments: nextExperiments(gaps, liveState.source_insights || {}),
    source_health: sourceHealth,
    signal_counts: signals.signal_counts || {},
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = await buildReport(options);
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    out: options.out,
    field_status_counts: report.field_status_counts,
    remaining_gap_count: report.remaining_gaps.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
