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
    "  node tools/verify-jcc-current-opponent-schema-evidence.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies current opponent exposes schema aliases while unproven opponent details remain unknown.",
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
  const opponent = liveState.opponents?.current_opponent;

  assert(opponent && opponent !== "unknown", "current_opponent must expose an object");
  assert(Number.isInteger(opponent.chair), "current_opponent must expose chair alias");
  assert(opponent.chair === opponent.chair_id, "current_opponent chair alias must match chair_id");
  assert(opponent.hp === "unknown", "current_opponent hp must remain unknown until linked to player_life");
  assert(opponent.level === "unknown", "current_opponent level must remain unknown");
  assert(opponent.gold === "unknown", "current_opponent gold must remain unknown");
  assert(opponent.board === "unknown", "current_opponent board must remain unknown");
  assert(opponent.bench === "unknown", "current_opponent bench must remain unknown");
  assert(opponent.traits === "unknown", "current_opponent traits must remain unknown");
  assert(opponent.last_scouted === "unknown", "current_opponent last_scouted must remain unknown");
  assert(opponent.evidence, "current_opponent must carry evidence");
  assert(opponent.source_signal_type === "battle_pairing", "current_opponent must cite battle_pairing");
  assert(liveState.field_status?.["opponents.current_opponent"]?.status === "partial", "current_opponent must remain partial");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "current opponent exposes target schema aliases",
      "unproven current opponent details remain unknown",
      "current opponent remains partial",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
