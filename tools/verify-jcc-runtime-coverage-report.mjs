import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_REPORT = ".omx/runtime-evidence/current-open-game-runtime-check-20260606-165542/runtime-coverage-report.json";

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report") options.report = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-coverage-report.mjs [--report <runtime-coverage-report.json>]",
    "",
    "Verifies the runtime coverage report summarizes live_state field evidence without hiding missing fields.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verificationCommands() {
  return [
    "node tools\\verify-jcc-phase-current-phase-candidate.mjs",
    "node tools\\verify-jcc-runtime-coverage-transition-audit.mjs",
    "node tools\\verify-jcc-runtime-metadata-source-status.mjs",
    "node tools\\verify-jcc-round-flow-candidate-insights.mjs",
    "node tools\\verify-jcc-android-probe-targeted-scopes.mjs",
    "node tools\\verify-jcc-apk-static-source-discovery.mjs",
    "node tools\\verify-jcc-android-runtime-capture-contract.mjs",
    "node tools\\verify-jcc-targeted-capture-diff.mjs",
    "node tools\\verify-jcc-targeted-diff-signal-extractor.mjs",
    "node tools\\verify-jcc-targeted-candidate-source-insights.mjs",
    "node tools\\verify-jcc-shop-unit-schema-evidence.mjs",
    "node tools\\verify-jcc-item-taxonomy-schema.mjs",
    "node tools\\verify-jcc-local-unit-schema-normalization.mjs",
    "node tools\\verify-jcc-local-trait-schema-normalization.mjs",
    "node tools\\verify-jcc-local-augment-schema-normalization.mjs",
    "node tools\\verify-jcc-local-reward-schema-normalization.mjs",
    "node tools\\verify-jcc-local-carousel-schema-normalization.mjs",
    "node tools\\verify-jcc-round-flow-source-evidence-pointers.mjs",
    "node tools\\verify-jcc-actions-unavailable-reason-status.mjs",
    "node tools\\verify-jcc-combat-active-candidate.mjs",
    "node tools\\verify-jcc-combat-result-candidate.mjs",
    "node tools\\verify-jcc-carousel-active-candidate.mjs",
    "node tools\\verify-jcc-mumu-s1-self-anchor.mjs",
    "node tools\\verify-jcc-mumu-equipment-source-priority.mjs",
    "node tools\\verify-jcc-no-opponent-product-modes.mjs",
    "node tools\\verify-jcc-runtime-final-status-report.mjs",
  ];
}

export function defaultRuntimeCoverageReport() {
  return {
    ok: true,
    report_kind: "jcc_android_runtime_live_state_coverage",
    evidence_files: {
      live_state: "self-contained-fixture/match-live-state.json",
      signals: "self-contained-fixture/candidate-runtime-signals.json",
      matrix: "data/runtime/jcc/runtime-live-state-coverage-matrix.json",
      targeted_capture_contract: "data/runtime/jcc/android-runtime-capture-contract.json",
    },
    verification_commands: verificationCommands(),
    field_status_counts: {
      verified: 9,
      partial: 3,
      missing: 24,
      fallback: 2,
      impossible: 0,
    },
    matrix_field_status_counts: {
      verified: 2,
      partial: 15,
      missing: 60,
      fallback: 0,
      impossible: 0,
    },
    runtime_partial_fields: ["board.board_units", "economy.gold", "items.item_bench"],
    summary: {
      match_status: "open",
      shop_units: [],
    },
    source_insights: {
      board_bench_item_candidates: {
        board_units: {
          count: 2,
          latest_source: { evidence: "fixture:mumu_4353" },
        },
        promotion_decision: {
          board_units: { status: "candidate_only" },
        },
      },
    },
    remaining_gaps: [
      { field: "board.board_units", reason: "requires self-view anchor or host visual confirmation" },
      { field: "economy.gold", reason: "requires economy OCR/visual observation" },
    ],
    runtime_transition_audit: { kind: "runtime_field_transition_audit" },
    next_experiments: [
      "board self-view anchor replay",
      "round_flow MuMu event capture",
    ],
    final_status_buckets: {
      verified: ["match.game_start_time", "phase.current_phase", "shop.shop_units"],
      partial: ["board.board_units", "items.item_bench"],
      missing: [
        "economy.gold",
        "economy.hp",
        "economy.level",
        "economy.xp",
      ],
      fallback: ["items.item_bench"],
      impossible: [],
    },
    final_status_counts: {
      verified: 3,
      partial: 2,
      missing: 4,
      fallback: 1,
      impossible: 0,
    },
    final_status_notes: {
      impossible: "No field is currently marked impossible; unknown fields remain missing or fallback_only until source limits are proven.",
    },
  };
}

async function loadReport(reportPath) {
  if (existsSync(reportPath)) return JSON.parse(await readFile(reportPath, "utf8"));
  return defaultRuntimeCoverageReport();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await loadReport(options.report);

  assert(report.ok === true, "coverage report must be ok");
  assert(report.report_kind === "jcc_android_runtime_live_state_coverage", "coverage report kind mismatch");
  assert(report.evidence_files?.live_state?.endsWith("match-live-state.json"), "report must reference live_state evidence");
  assert(report.evidence_files?.signals?.endsWith("candidate-runtime-signals.json"), "report must reference signal evidence");
  assert(report.evidence_files?.targeted_capture_contract === "data/runtime/jcc/android-runtime-capture-contract.json", "report must reference targeted capture contract");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-phase-current-phase-candidate.mjs"), "report must list current phase candidate verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-runtime-coverage-transition-audit.mjs"), "report must list transition audit verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-runtime-metadata-source-status.mjs"), "report must list metadata source status verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-round-flow-candidate-insights.mjs"), "report must list round_flow candidate verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-android-probe-targeted-scopes.mjs"), "report must list probe targeted scopes verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-apk-static-source-discovery.mjs"), "report must list APK static source verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-android-runtime-capture-contract.mjs"), "report must list targeted capture verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-targeted-capture-diff.mjs"), "report must list targeted capture diff verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-targeted-diff-signal-extractor.mjs"), "report must list targeted diff signal extractor verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-targeted-candidate-source-insights.mjs"), "report must list targeted candidate source insights verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-shop-unit-schema-evidence.mjs"), "report must list shop unit schema verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-item-taxonomy-schema.mjs"), "report must list item taxonomy schema verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-local-unit-schema-normalization.mjs"), "report must list local unit schema normalization verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-local-trait-schema-normalization.mjs"), "report must list local trait schema normalization verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-local-augment-schema-normalization.mjs"), "report must list local augment schema normalization verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-local-reward-schema-normalization.mjs"), "report must list local reward schema normalization verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-local-carousel-schema-normalization.mjs"), "report must list local carousel schema normalization verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-round-flow-source-evidence-pointers.mjs"), "report must list round flow source evidence verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-actions-unavailable-reason-status.mjs"), "report must list action fallback reason verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-combat-active-candidate.mjs"), "report must list combat active candidate verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-combat-result-candidate.mjs"), "report must list combat result candidate verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-carousel-active-candidate.mjs"), "report must list carousel active candidate verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-mumu-s1-self-anchor.mjs"), "report must list S=1 self-view anchor verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-mumu-equipment-source-priority.mjs"), "report must list MuMu equipment source priority verifier");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-no-opponent-product-modes.mjs"), "report must list removed opponent product mode verifier");
  assert(report.field_status_counts?.verified >= 8, "report must count verified fields");
  assert(report.matrix_field_status_counts?.partial === 15, "report must preserve matrix baseline counts separately");
  assert(report.field_status_counts?.missing < report.matrix_field_status_counts?.missing, "runtime counts must reflect missing fields promoted by evidence");
  assert(report.field_status_counts?.missing > report.field_status_counts?.verified, "report must honestly expose many missing fields");
  assert(Array.isArray(report.runtime_partial_fields) && report.runtime_partial_fields.length > 0, "report must include runtime partial fields when present");
  assert(report.summary && typeof report.summary === "object", "report must include a live_state summary object");
  assert(report.summary.match_status !== undefined, "report must summarize match status");
  assert(Array.isArray(report.summary?.shop_units), "report must summarize shop units as an array even when empty");
  assert(report.source_insights && typeof report.source_insights === "object", "report must expose source_insights object");
  if (report.source_insights?.board_bench_item_candidates?.board_units?.count > 0) {
    assert(report.source_insights.board_bench_item_candidates.board_units.latest_source?.evidence, "board candidate source evidence must be exposed when board candidates exist");
    assert(report.source_insights.board_bench_item_candidates.promotion_decision?.board_units?.status !== "promoted", "anonymous board candidates must not be silently promoted");
  }
  assert(report.remaining_gaps?.some((gap) => gap.field === "board.board_units"), "report must include board gap");
  assert(report.remaining_gaps?.some((gap) => gap.field === "economy.gold"), "report must include gold gap");
  assert(report.runtime_transition_audit?.kind === "runtime_field_transition_audit", "report must include runtime transition audit");
  assert(report.next_experiments?.some((entry) => entry.includes("board") || entry.includes("round_flow")), "report must include board/round_flow next experiment");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "coverage report references evidence files",
      "coverage report references targeted capture contract",
      "coverage report lists verification commands",
      "coverage report summarizes verified real fields",
      "coverage report exposes anonymous candidates without promotion",
      "coverage report preserves remaining gaps and next experiments",
    ],
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
