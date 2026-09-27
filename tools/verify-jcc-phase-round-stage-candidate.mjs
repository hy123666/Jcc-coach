import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-phase-round-stage-candidate.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies phase.stage/round are exposed as partial round_flow candidates without inventing timers.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const liveState = snapshot.live_state || {};

  assert(liveState.phase?.stage === 5, "phase.stage must expose latest round_flow major candidate");
  assert(liveState.phase?.round === 5, "phase.round must expose latest round_flow minor candidate");
  assert(liveState.field_status?.["phase.stage"]?.status === "partial", "phase.stage status must be partial");
  assert(liveState.field_status?.["phase.round"]?.status === "partial", "phase.round status must be partial");
  assert(liveState.field_status?.["phase.stage"]?.evidence, "phase.stage must carry evidence");
  assert(liveState.field_status?.["phase.round"]?.evidence, "phase.round must carry evidence");
  assert(liveState.phase?.planning_timer === "unknown", "planning_timer must remain unknown");
  assert(liveState.phase?.combat_timer === "unknown", "combat_timer must remain unknown");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "phase.stage candidate exposed",
      "phase.round candidate exposed",
      "phase round/stage carry evidence",
      "timers remain unknown",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
