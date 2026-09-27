import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";
const DEFAULT_REPORT = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/runtime-coverage-report.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE, report: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-metadata-field-lists.mjs [--live-state <match-live-state.json>] [--report <runtime-coverage-report.json>]",
    "",
    "Verifies live_state.metadata field lists use runtime field_status, not stale matrix baseline lists.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameList(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const report = JSON.parse(await readFile(options.report, "utf8"));
  const liveState = snapshot.live_state || {};
  const metadata = liveState.metadata || {};

  assert(sameList(metadata.missing_fields, liveState.missing_fields), "metadata.missing_fields must mirror live_state.missing_fields");
  assert(sameList(metadata.partial_fields, liveState.partial_fields), "metadata.partial_fields must mirror live_state.partial_fields");
  assert(sameList(metadata.fallback_fields, liveState.fallback_fields), "metadata.fallback_fields must mirror live_state.fallback_fields");
  assert(sameList(metadata.stale_fields, liveState.stale_fields), "metadata.stale_fields must mirror live_state.stale_fields");
  assert(metadata.missing_fields.length === report.field_status_counts.missing, "metadata missing count must match runtime coverage report");
  assert(metadata.partial_fields.length === report.field_status_counts.partial, "metadata partial count must match runtime coverage report");
  assert(metadata.fallback_fields.length === report.field_status_counts.fallback_only, "metadata fallback count must match runtime coverage report");
  assert(metadata.partial_fields.includes("phase.stage"), "metadata partial list must include runtime phase.stage");
  assert(metadata.partial_fields.includes("combat.damage_taken"), "metadata partial list must include runtime combat.damage_taken");
  for (const field of [
    "metadata.missing_fields",
    "metadata.stale_fields",
    "metadata.partial_fields",
    "metadata.fallback_fields",
  ]) {
    assert(liveState.field_status?.[field]?.status === "verified", `${field} must be verified as a derived runtime field-status list`);
    assert(liveState.field_status?.[field]?.source_type === "derived_field_status", `${field} must use derived_field_status source_type`);
    assert(liveState.field_status?.[field]?.evidence, `${field} must carry derivation evidence`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "metadata field lists mirror live_state aliases",
      "metadata field counts match coverage report",
      "metadata lists include runtime partial fields",
      "metadata field-list statuses are verified derived values",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
