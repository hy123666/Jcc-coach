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
    "  node tools/verify-jcc-current-opponent-mapping.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies battle_pairing maps only the opponent chair into opponents.current_opponent without inventing opponent board data.",
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
  const currentOpponent = liveState.opponents?.current_opponent;

  assert(currentOpponent && typeof currentOpponent === "object", "current_opponent must be a structured object");
  assert(Number.isInteger(currentOpponent.chair_id), "current_opponent.chair_id must be mapped from battle_pairing");
  assert(currentOpponent.chair_id >= 0 && currentOpponent.chair_id <= 8, "current_opponent chair_id must be a player chair");
  assert(currentOpponent.chair_id !== liveState.local?.local_chair_id, "current_opponent must not equal local chair");
  assert(currentOpponent.source_signal_type === "battle_pairing", "current_opponent must cite battle_pairing");
  assert(currentOpponent.evidence, "current_opponent must carry evidence");
  assert(currentOpponent.confidence > 0, "current_opponent must carry confidence");
  assert(currentOpponent.board === "unknown", "current_opponent must not invent opponent board");
  assert(currentOpponent.bench === "unknown", "current_opponent must not invent opponent bench");
  assert(liveState.field_status?.["opponents.current_opponent"]?.status === "partial", "field_status must mark current_opponent partial");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "battle_pairing maps current opponent chair",
      "current opponent carries evidence and confidence",
      "current opponent does not invent board or bench",
      "field_status marks current_opponent partial",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
