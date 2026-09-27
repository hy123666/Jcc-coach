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
    "  node tools/verify-jcc-actions-unavailable-reason-status.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies the action unavailable fallback reason is surfaced as partial, without promoting action booleans.",
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
  const actions = liveState.actions || {};
  const status = liveState.field_status || {};

  assert(actions.unavailable_reason === "unmapped_runtime_action_state", "actions.unavailable_reason must expose the fallback reason");
  assert(status["actions.unavailable_reason"]?.status === "partial", "actions.unavailable_reason must be partial");
  assert(status["actions.unavailable_reason"]?.source_type === "derived_gate_reason", "actions.unavailable_reason must use derived_gate_reason source_type");
  assert(!liveState.missing_fields?.includes("actions.unavailable_reason"), "actions.unavailable_reason must not remain missing");
  for (const field of [
    "actions.can_buy",
    "actions.can_sell",
    "actions.can_level",
    "actions.can_roll",
    "actions.can_move",
    "actions.can_equip",
    "actions.can_choose_augment",
    "actions.can_choose_reward",
    "actions.can_pick_carousel",
  ]) {
    assert(status[field]?.status === "missing", `${field} must remain missing`);
    const key = field.split(".")[1];
    assert(actions[key] === "unknown", `${field} value must remain unknown`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "action unavailable reason is surfaced as partial",
      "action booleans remain unknown and missing",
      "fallback reason does not promote can_* action state",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
